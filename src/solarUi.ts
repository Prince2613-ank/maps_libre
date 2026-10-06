import type * as maplibregl from "maplibre-gl";
import * as THREE from "three";
import type { Lighting, ModelLayer } from "./modelLayer";
import { LATITUDE, LONGITUDE } from "./placement";
import {
  SITE_TIME_ZONE_LABEL,
  compassPoint,
  formatMinutes,
  siteMidnight,
  sunDay,
  sunDirectionEnu,
  sunPosition,
  toSiteTime,
  type SunPosition
} from "./sun";
import { BASEMAP_LAYER_IDS } from "./basemaps";

// Sun panel: pick a date and time (building local time), and the scene is lit from the real sun position —
// direction, colour and strength of sunlight, sky light, shadows on the models and on the map, a day/night
// tint for the basemap and sky, and the sun's path across the sky drawn around the building.

const OVERLAY_ID = "sun:path";
const PATH_RADIUS = 45; // m — size of the sun-path dome drawn around the building
const PATH_STEP_MIN = 10;
const PLAY_SPEEDS = [15, 60, 180]; // simulated minutes per real second

// Look of the scene before the Sun panel existed; used when sun lighting is switched off.
const STUDIO_LIGHTING: Lighting = {
  sunDirection: new THREE.Vector3(0.5, 0.8, 1.5).normalize(),
  sunColor: new THREE.Color(0xffffff),
  sunIntensity: 1.6,
  ambientColor: new THREE.Color(0xffffff),
  ambientIntensity: 1.4,
  skyColor: new THREE.Color(0xffffff),
  groundColor: new THREE.Color(0x666666),
  hemiIntensity: 1.2,
  shadows: false,
  groundShadowOpacity: 0
};

const smoothstep = (edge0: number, edge1: number, x: number) => THREE.MathUtils.smoothstep(x, edge0, edge1);
const mix = (a: string, b: string, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), t);

/** Sunlight, sky light and shadow strength for a sun altitude (degrees). */
function lightingFor(sun: SunPosition, shadows: boolean): Lighting {
  const alt = sun.altitude;
  const day = smoothstep(-8, 8, alt); // 0 night … 1 full day, through civil twilight
  const high = smoothstep(0, 30, alt); // warm, low sun → white, high sun
  const [x, y, z] = sunDirectionEnu(sun);
  return {
    sunDirection: new THREE.Vector3(x, y, z),
    sunColor: mix("#ff7a2f", "#fff6e8", high),
    sunIntensity: 2.8 * smoothstep(-1, 12, alt),
    ambientColor: mix("#4a5a8c", "#ffffff", day).lerp(new THREE.Color("#ffb27a"), 0.25 * day * (1 - high)),
    ambientIntensity: 0.35 + 0.55 * day,
    skyColor: mix("#26345e", "#cfe3ff", day),
    groundColor: mix("#151a26", "#7a7466", day),
    hemiIntensity: 0.35 + 0.65 * day,
    shadows,
    groundShadowOpacity: 0.4 * smoothstep(0, 10, alt)
  };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class SolarUi {
  private readonly enabled = $<HTMLInputElement>("sun-enabled");
  private readonly dateInput = $<HTMLInputElement>("sun-date");
  private readonly timeInput = $<HTMLInputElement>("sun-time");
  private readonly timeLabel = $<HTMLElement>("sun-time-label");
  private readonly playButton = $<HTMLButtonElement>("sun-play");
  private readonly speedSelect = $<HTMLSelectElement>("sun-speed");
  private readonly shadowsBox = $<HTMLInputElement>("sun-shadows");
  private readonly pathBox = $<HTMLInputElement>("sun-path");
  private readonly tintBox = $<HTMLInputElement>("sun-tint");
  private readonly readout = $<HTMLElement>("sun-readout");

  private readonly overlay = new THREE.Group();
  private readonly pathLine: THREE.Line;
  private readonly sunMesh: THREE.Mesh;
  private readonly sunRay: THREE.Line;
  private readonly labels = new Map<THREE.Object3D, HTMLElement>();
  private readonly hourGroup = new THREE.Group();
  private readonly labelLayer = document.createElement("div");
  private playFrame: number | null = null;
  private pathDate = "";
  private basemapDay = 1;

  constructor(
    private readonly map: maplibregl.Map,
    private readonly layer: ModelLayer
  ) {
    for (const speed of PLAY_SPEEDS) this.speedSelect.appendChild(new Option(`${speed / 60 >= 1 ? speed / 60 + " h" : speed + " min"}/s`, String(speed), false, speed === 60));
    $("sun-tz").textContent = SITE_TIME_ZONE_LABEL;

    // --- 3D overlay: compass ring, sun path, hour marks, sun and its ray to the building
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 96 }, (_, i) => {
          const a = (i / 96) * Math.PI * 2;
          return new THREE.Vector3(Math.sin(a) * PATH_RADIUS, Math.cos(a) * PATH_RADIUS, 0.05);
        })
      ),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })
    );
    this.overlay.add(ring);
    for (const [text, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]] as const) {
      const anchor = new THREE.Object3D();
      anchor.position.set(Math.sin(az * THREE.MathUtils.DEG2RAD) * (PATH_RADIUS + 4), Math.cos(az * THREE.MathUtils.DEG2RAD) * (PATH_RADIUS + 4), 0);
      this.overlay.add(anchor);
      this.addLabel(anchor, text, "sun-label cardinal");
    }

    this.pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
    this.overlay.add(this.pathLine, this.hourGroup);

    this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(2.4, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffd34d }));
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(4, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.25, depthWrite: false })
    );
    this.sunMesh.add(halo);
    this.sunRay = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: 0xffc233, dashSize: 1.5, gapSize: 1, transparent: true, opacity: 0.9 })
    );
    this.overlay.add(this.sunMesh, this.sunRay);
    layer.addOverlay(OVERLAY_ID, this.overlay, 0);

    this.labelLayer.className = "sun-labels";
    map.getContainer().appendChild(this.labelLayer);
    layer.onAfterRender(() => this.placeLabels());

    // --- Controls
    const now = toSiteTime(new Date());
    this.dateInput.value = now.isoDate;
    const today = sunDay(now.isoDate, LATITUDE, LONGITUDE);
    // Open on the current time if the sun is up, otherwise mid-morning so the effect is visible straight away.
    const daytime = today.sunrise !== null && today.sunset !== null && now.minutes > today.sunrise && now.minutes < today.sunset;
    this.timeInput.value = String(daytime ? now.minutes : 600);

    this.enabled.addEventListener("change", () => this.update());
    this.dateInput.addEventListener("change", () => this.update());
    this.timeInput.addEventListener("input", () => this.update());
    for (const box of [this.shadowsBox, this.pathBox, this.tintBox]) box.addEventListener("change", () => this.update());
    $("sun-now").addEventListener("click", () => {
      const t = toSiteTime(new Date());
      this.dateInput.value = t.isoDate;
      this.timeInput.value = String(t.minutes);
      this.update();
    });
    $("sun-sunrise").addEventListener("click", () => this.jumpTo("sunrise"));
    $("sun-noon").addEventListener("click", () => this.jumpTo("noon"));
    $("sun-sunset").addEventListener("click", () => this.jumpTo("sunset"));
    this.playButton.addEventListener("click", () => (this.playFrame === null ? this.play() : this.stop()));

    this.update();
  }

  private addLabel(anchor: THREE.Object3D, text: string, className: string): void {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    this.labelLayer.appendChild(el);
    this.labels.set(anchor, el);
  }

  private placeLabels(): void {
    const show = this.enabled.checked && this.pathBox.checked;
    this.labelLayer.hidden = !show;
    if (!show) return;
    for (const [anchor, el] of this.labels) {
      const screen = anchor.visible && anchor.parent?.visible !== false ? this.layer.projectToScreen(anchor.getWorldPosition(new THREE.Vector3())) : null;
      el.style.display = screen ? "" : "none";
      if (screen) el.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%, -50%)`;
    }
  }

  private minutes(): number {
    return Number(this.timeInput.value);
  }

  private instant(): Date {
    return new Date(siteMidnight(this.dateInput.value).valueOf() + this.minutes() * 60_000);
  }

  private jumpTo(which: "sunrise" | "noon" | "sunset"): void {
    this.stop();
    const day = sunDay(this.dateInput.value, LATITUDE, LONGITUDE);
    const minutes = which === "noon" ? day.solarNoon : which === "sunrise" ? day.sunrise : day.sunset;
    if (minutes === null) return;
    // A few minutes inside daylight so there is still direct sun to see.
    this.timeInput.value = String(Math.round(minutes + (which === "sunrise" ? 5 : which === "sunset" ? -5 : 0)));
    this.update();
  }

  private play(): void {
    let last = performance.now();
    let minutes = this.minutes();
    const tick = (now: number) => {
      minutes = (minutes + ((now - last) / 1000) * Number(this.speedSelect.value)) % 1440;
      last = now;
      this.timeInput.value = String(Math.floor(minutes));
      this.update();
      this.playFrame = requestAnimationFrame(tick);
    };
    this.playFrame = requestAnimationFrame(tick);
    this.playButton.textContent = "⏸";
    this.playButton.title = "Pause the day animation";
  }

  private stop(): void {
    if (this.playFrame !== null) cancelAnimationFrame(this.playFrame);
    this.playFrame = null;
    this.playButton.textContent = "▶";
    this.playButton.title = "Play the day";
  }

  /** Recompute everything from the controls. */
  update(): void {
    const on = this.enabled.checked;
    $("sun-controls").classList.toggle("disabled", !on);
    if (!on) this.stop();

    const sun = sunPosition(this.instant(), LATITUDE, LONGITUDE);
    const day = sunDay(this.dateInput.value, LATITUDE, LONGITUDE);
    this.timeLabel.textContent = formatMinutes(this.minutes());
    // The slider track is coloured night → day → night at this date's real sunrise and sunset.
    this.timeInput.style.setProperty("--sunrise", `${((day.sunrise ?? 360) / 1440) * 100}%`);
    this.timeInput.style.setProperty("--sunset", `${((day.sunset ?? 1080) / 1440) * 100}%`);

    this.layer.setLighting(on ? lightingFor(sun, this.shadowsBox.checked) : STUDIO_LIGHTING);
    this.updateOverlay(sun, on && this.pathBox.checked);
    this.updateBasemap(on && this.tintBox.checked ? smoothstep(-8, 8, sun.altitude) : 1, sun);

    const daylight = day.sunrise !== null && day.sunset !== null ? day.sunset - day.sunrise : null;
    const state = sun.altitude > 6 ? "☀️ Daylight" : sun.altitude > -0.833 ? "🌅 Golden hour" : sun.altitude > -6 ? "🌆 Twilight" : "🌙 Night";
    this.readout.innerHTML = `
      <div class="sun-state">${state}</div>
      <table>
        <tr><th>Azimuth</th><td>${sun.azimuth.toFixed(1)}° ${compassPoint(sun.azimuth)}</td></tr>
        <tr><th>Elevation</th><td>${sun.altitude.toFixed(1)}°</td></tr>
        <tr><th>Sunrise</th><td>${day.sunrise === null ? "—" : formatMinutes(day.sunrise)}</td></tr>
        <tr><th>Solar noon</th><td>${formatMinutes(day.solarNoon)} (${day.noonAltitude.toFixed(1)}°)</td></tr>
        <tr><th>Sunset</th><td>${day.sunset === null ? "—" : formatMinutes(day.sunset)}</td></tr>
        <tr><th>Daylight</th><td>${daylight === null ? "—" : `${Math.floor(daylight / 60)} h ${Math.round(daylight % 60)} min`}</td></tr>
        <tr><th>Shadow length</th><td>${sun.altitude > 0.5 ? `${(1 / Math.tan(sun.altitude * THREE.MathUtils.DEG2RAD)).toFixed(2)} × height` : "—"}</td></tr>
      </table>`;
  }

  private updateOverlay(sun: SunPosition, show: boolean): void {
    this.layer.setOverlayVisible(OVERLAY_ID, 0, show);
    if (!show) return;
    const toPoint = (s: SunPosition) => new THREE.Vector3(...sunDirectionEnu(s)).multiplyScalar(PATH_RADIUS);

    // The day's arc only changes with the date.
    if (this.pathDate !== this.dateInput.value) {
      this.pathDate = this.dateInput.value;
      const midnight = siteMidnight(this.pathDate).valueOf();
      const points: THREE.Vector3[] = [];
      const colors: number[] = [];
      for (let m = 0; m <= 1440; m += PATH_STEP_MIN) {
        const s = sunPosition(new Date(midnight + m * 60_000), LATITUDE, LONGITUDE);
        if (s.altitude < -4) continue;
        points.push(toPoint(s));
        const c = mix("#ff7a2f", "#ffe680", smoothstep(0, 30, s.altitude));
        colors.push(c.r, c.g, c.b);
      }
      this.pathLine.geometry.dispose();
      this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
      this.pathLine.geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

      for (const child of [...this.hourGroup.children]) {
        this.labels.get(child)?.remove();
        this.labels.delete(child);
        this.hourGroup.remove(child);
      }
      for (let hour = 0; hour < 24; hour++) {
        const s = sunPosition(new Date(midnight + hour * 3_600_000), LATITUDE, LONGITUDE);
        if (s.altitude < 0) continue;
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        dot.position.copy(toPoint(s));
        this.hourGroup.add(dot);
        this.addLabel(dot, `${String(hour).padStart(2, "0")}h`, "sun-label hour");
      }
    }

    const p = toPoint(sun);
    this.sunMesh.position.copy(p);
    this.sunMesh.visible = this.sunRay.visible = sun.altitude > -2;
    this.sunRay.geometry.setFromPoints([new THREE.Vector3(0, 0, 0), p]);
    this.sunRay.computeLineDistances();
    (this.sunMesh.material as THREE.MeshBasicMaterial).color.copy(mix("#ff8a3d", "#ffd34d", smoothstep(0, 25, sun.altitude)));
    this.map.triggerRepaint();
  }

  /** Darken and desaturate the map at night; tint the sky. `day` is 0 (night) … 1 (day). */
  private updateBasemap(day: number, sun: SunPosition): void {
    this.basemapDay = day;
    this.tintBasemap();
    const low = 1 - smoothstep(0, 20, sun.altitude);
    try {
      this.map.setSky({
        "sky-color": `#${mix("#0b1026", "#5aa9ff", day).getHexString()}`,
        "horizon-color": `#${mix("#1b2140", "#ffffff", day).lerp(new THREE.Color("#ff9a4d"), 0.6 * low * day).getHexString()}`,
        "sky-horizon-blend": 0.6,
        "horizon-fog-blend": 0.5,
        "fog-color": `#${mix("#0b1026", "#dfe9f5", day).getHexString()}`,
        "fog-ground-blend": 0.9,
        "atmosphere-blend": 0
      });
    } catch {
      // Sky is cosmetic; older styles/versions may not support it.
    }
  }

  /** Apply the current day/night tint to every base map layer, including ones added since the last update. */
  tintBasemap(): void {
    for (const id of BASEMAP_LAYER_IDS) {
      if (!this.map.getLayer(id)) continue;
      this.map.setPaintProperty(id, "raster-brightness-max", 0.3 + 0.7 * this.basemapDay);
      this.map.setPaintProperty(id, "raster-saturation", -0.6 * (1 - this.basemapDay));
    }
  }
}
