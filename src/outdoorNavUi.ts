import * as maplibregl from "maplibre-gl";
import * as THREE from "three";
import type { ModelLayer } from "./modelLayer";
import type { RoomChoice } from "./navigation";
import {
  BUILDING_ENTRANCE,
  OutdoorRouter,
  SUGGESTED_PLACES,
  distanceMeters,
  resolvePlace,
  samplePath,
  suggestPlaces,
  type LonLat,
  type OutdoorRoute,
  type TravelMode
} from "./outdoorNav";
import { lonLatToEnu } from "./placement";
import { RouteOverlay } from "./routeOverlay";

// "From outside" directions, following the Cesium app's map route (cesium_demo/src/ui.ts): route from any place to
// the building entrance — streets, then the surveyed footpath — then hand over to indoor navigation to the room.

const SOURCE = "outdoor-route";
const OVERLAY_ID = "route:outdoor";
const MODEL_LAYER_ID = "glb-models";
const ENTRANCE_VALUE = "__entrance__";
const DOT_SPACING = 0.6; // m, footpath dots (indoor route uses 0.4)
const DOT_LIFT = 0.6; // m above the ground
const FOLLOW_EASE = 0.1;
const STREET_VIEW = { zoom: 18.2, pitch: 55 };
const FOOTPATH_VIEW = { zoom: 20.3, pitch: 62 };
const ROAD_SECONDS = 30; // the simulated street part takes at most this long…
const ROAD_MIN_SPEED = { walk: 12, drive: 25 }; // …and moves at least this fast (m/s)
const FOOTPATH_SPEED = 2.2; // m/s on the footpath near the building
const HANDOVER_MS = 1600;

export type OutdoorHooks = {
  /** Show the building exterior + outdoor area. */
  showOutside: () => void;
  /** Stop any indoor navigation that is running. */
  stopIndoor: () => void;
  /** Continue with indoor navigation from the entrance to this room. */
  startIndoor: (room: RoomChoice) => void;
};

type Walk = {
  /** Distance travelled along the route (m). */
  at: number;
  cumulative: number[];
  approachAt: number;
  roadSpeed: number;
  paused: boolean;
  last: number;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const formatMeters = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 1 : 2)} km` : `${Math.max(1, Math.round(m))} m`);
const formatMinutes = (s: number) => (s < 90 ? "1 min" : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
const bearingOf = (a: LonLat, b: LonLat) => {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
};

function markerElement(className: string, label: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `route-marker ${className}`;
  el.innerHTML = `<span class="route-marker-dot"></span><span class="route-marker-label">${escapeHtml(label)}</span>`;
  return el;
}

export class OutdoorNavigationUi {
  private readonly router: OutdoorRouter;
  private readonly overlay = new RouteOverlay();
  private rooms: RoomChoice[] = [];
  private route: OutdoorRoute | null = null;
  private routeKey = "";
  private walk: Walk | null = null;
  private frame: number | null = null;
  private mode: TravelMode = "walk";
  private markers: maplibregl.Marker[] = [];
  private suggestTimer: number | null = null;
  private busy = false;
  /** The "lat,lng" text filled in by the location button, so it can be shown as "Your location". */
  private locatedValue: string | null = null;

  private readonly from = $<HTMLInputElement>("out-from");
  private readonly fromList = $<HTMLDataListElement>("out-from-list");
  private readonly to = $<HTMLSelectElement>("out-to");
  private readonly showButton = $<HTMLButtonElement>("out-show");
  private readonly startButton = $<HTMLButtonElement>("out-start");
  private readonly pauseButton = $<HTMLButtonElement>("out-pause");
  private readonly exitButton = $<HTMLButtonElement>("out-exit");
  private readonly locateButton = $<HTMLButtonElement>("out-locate");
  private readonly follow = $<HTMLInputElement>("out-follow");
  private readonly message = $<HTMLElement>("out-message");
  private readonly summary = $<HTMLElement>("out-summary");
  private readonly stepList = $<HTMLOListElement>("out-steps");
  private readonly hud = $<HTMLElement>("nav-hud");

  constructor(
    private readonly map: maplibregl.Map,
    private readonly layer: ModelLayer,
    pointsUrl: string,
    private readonly hooks: OutdoorHooks
  ) {
    this.router = new OutdoorRouter(pointsUrl);
    layer.addOverlay(OVERLAY_ID, this.overlay.object, 0);

    for (const label of SUGGESTED_PLACES) this.fromList.appendChild(new Option(label));
    this.setRooms([]);

    this.from.addEventListener("input", () => {
      this.invalidate();
      if (this.suggestTimer !== null) window.clearTimeout(this.suggestTimer);
      // Nominatim asks for at most one request a second.
      this.suggestTimer = window.setTimeout(() => void this.suggest(), 600);
    });
    this.from.addEventListener("keydown", (e) => e.key === "Enter" && void this.showRoute());
    this.to.addEventListener("change", () => this.invalidate());
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-travel]")) {
      button.addEventListener("click", () => {
        this.mode = button.dataset.travel as TravelMode;
        document.querySelectorAll("[data-travel]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
        this.invalidate();
      });
    }
    this.locateButton.addEventListener("click", () => this.locate());
    this.showButton.addEventListener("click", () => void this.showRoute());
    this.startButton.addEventListener("click", () => void this.start());
    this.pauseButton.addEventListener("click", () => this.togglePause());
    this.exitButton.addEventListener("click", () => this.exit());
    this.follow.addEventListener("change", () => this.follow.checked && this.walk && this.updateCamera(true));
    map.on("dragstart", () => {
      if (this.walk) this.follow.checked = false;
    });

    this.ensureMapLayers();
    // Keep the line if the style is ever reloaded.
    map.on("styledata", () => this.ensureMapLayers());
    this.updateButtons();
  }

  /** Fill the To list once indoor rooms are known. */
  setRooms(rooms: readonly RoomChoice[]): void {
    this.rooms = [...rooms];
    const current = this.to.value || ENTRANCE_VALUE;
    this.to.replaceChildren(new Option("Building entrance", ENTRANCE_VALUE), ...this.rooms.map((r) => new Option(r.label, r.label)));
    this.to.value = [...this.to.options].some((o) => o.value === current) ? current : ENTRANCE_VALUE;
  }

  /** Pre-select a room as destination (e.g. from a room popup) and show the tab. */
  setDestination(label: string): void {
    if ([...this.to.options].some((o) => o.value === label)) this.to.value = label;
    this.invalidate();
  }

  private destination(): RoomChoice | null {
    return this.rooms.find((r) => r.label === this.to.value) ?? null;
  }

  private setMessage(text: string): void {
    this.message.textContent = text;
  }

  private invalidate(): void {
    if (this.walk) return;
    this.updateButtons();
  }

  private updateButtons(): void {
    const hasInput = this.from.value.trim().length > 0;
    this.showButton.disabled = !hasInput || this.busy;
    this.startButton.disabled = !hasInput || this.busy;
    this.pauseButton.hidden = !this.walk;
    this.exitButton.hidden = !this.route;
    this.pauseButton.textContent = this.walk?.paused ? "▶ Resume" : "⏸ Pause";
  }

  private async suggest(): Promise<void> {
    const value = this.from.value;
    const suggestions = await suggestPlaces(value);
    if (this.from.value !== value) return;
    this.fromList.replaceChildren(...suggestions.map((label) => new Option(label)));
  }

  private locate(): void {
    if (!navigator.geolocation) return this.setMessage("Your browser can't share its location.");
    this.locateButton.disabled = true;
    this.setMessage("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        this.locateButton.disabled = false;
        this.from.value = `${position.coords.latitude.toFixed(7)},${position.coords.longitude.toFixed(7)}`;
        this.locatedValue = this.from.value;
        this.setMessage(`Using your location (±${Math.round(position.coords.accuracy)} m).`);
        this.invalidate();
      },
      () => {
        this.locateButton.disabled = false;
        this.setMessage("Allow location access to start from where you are.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  // --- Route

  /** Find and draw the route (reuses the last one if nothing changed). */
  async showRoute(fit = true): Promise<boolean> {
    const key = `${this.from.value.trim()}|${this.mode}`;
    if (this.route && key === this.routeKey) {
      if (fit) this.fitRoute();
      return true;
    }
    this.exit(false);
    this.busy = true;
    this.updateButtons();
    this.setMessage("Finding the place…");
    try {
      const start = await resolvePlace(this.from.value);
      if (!start) {
        this.setMessage("Couldn't find that place. Try a fuller address, a landmark, or lat,lng.");
        return false;
      }
      if (distanceMeters(start, BUILDING_ENTRANCE) > 200_000) {
        this.setMessage("That place is more than 200 km away — pick a start closer to the building.");
        return false;
      }
      this.setMessage("Finding a route…");
      const route = await this.router.routeToEntrance(start, this.mode);
      this.route = route;
      this.routeKey = key;
      this.hooks.stopIndoor();
      this.hooks.showOutside();
      this.draw(route, start);
      this.renderSummary(route);
      if (fit) this.fitRoute();
      this.setMessage(route.routed ? "Press Start to follow the route." : "No street route found — showing a straight line.");
      return true;
    } catch (error) {
      console.error("Outdoor route failed", error);
      this.setMessage("Couldn't load a route right now. Check the connection and try again.");
      return false;
    } finally {
      this.busy = false;
      this.updateButtons();
    }
  }

  private ensureMapLayers(): void {
    if (!this.map.isStyleLoaded() || this.map.getSource(SOURCE)) return;
    this.map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    const before = this.map.getLayer(MODEL_LAYER_ID) ? MODEL_LAYER_ID : undefined;
    const line = { "line-join": "round", "line-cap": "round" } as const;
    this.map.addLayer({ id: "outdoor-route-casing", type: "line", source: SOURCE, layout: line, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 6, 20, 14] } }, before);
    this.map.addLayer({ id: "outdoor-route-line", type: "line", source: SOURCE, layout: line, paint: { "line-color": "#0B66FF", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 20, 9] } }, before);
    this.map.addLayer({
      id: "outdoor-route-walked",
      type: "line",
      source: SOURCE,
      filter: ["==", ["get", "part"], "walked"],
      layout: line,
      paint: { "line-color": "#94a3b8", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 20, 9] }
    }, before);
    this.map.setFilter("outdoor-route-line", ["==", ["get", "part"], "route"]);
    this.map.setFilter("outdoor-route-casing", ["==", ["get", "part"], "route"]);
  }

  private setLine(points: LonLat[], walked: LonLat[] = []): void {
    this.ensureMapLayers();
    const source = this.map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
    const feature = (part: string, pts: LonLat[]) => ({
      type: "Feature" as const,
      properties: { part },
      geometry: { type: "LineString" as const, coordinates: pts.map((p) => [p.lon, p.lat]) }
    });
    source?.setData({ type: "FeatureCollection", features: [feature("route", points), ...(walked.length > 1 ? [feature("walked", walked)] : [])] });
  }

  /** Lon/lat → where it is drawn in 3D (follows the outdoor area's saved adjustment, like the indoor route). */
  private toScene(p: LonLat, lift = DOT_LIFT): THREE.Vector3 {
    const e = lonLatToEnu(p.lon, p.lat);
    return new THREE.Vector3(e.x, e.y, lift + this.router.heightOffset).applyMatrix4(this.layer.setTransform("outdoor"));
  }

  private draw(route: OutdoorRoute, start: LonLat): void {
    this.setLine(route.points);
    const approach = samplePath(route.points.slice(route.approachStart), DOT_SPACING).map((p) => this.toScene(p));
    this.overlay.setRoute([{ points: approach, floor: "outdoor" }]);
    this.startAnimation();
    for (const m of this.markers) m.remove();
    this.markers = [
      new maplibregl.Marker({ element: markerElement("start", "Start"), anchor: "bottom" }).setLngLat([start.lon, start.lat]).addTo(this.map),
      new maplibregl.Marker({ element: markerElement("entrance", "Entrance"), anchor: "bottom" }).setLngLat([BUILDING_ENTRANCE.lon, BUILDING_ENTRANCE.lat]).addTo(this.map)
    ];
  }

  private fitRoute(): void {
    if (!this.route) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const p of this.route.points) bounds.extend([p.lon, p.lat]);
    this.map.jumpTo({ elevation: 0 });
    // Keep the route clear of the side panel (a bottom sheet on phones, nothing when collapsed).
    const phone = window.matchMedia("(max-width: 640px)").matches;
    const collapsed = document.body.classList.contains("panel-collapsed");
    const padding = phone
      ? { top: 70, bottom: collapsed ? 70 : Math.round(window.innerHeight * 0.45), left: 30, right: 70 }
      : { top: 100, bottom: 110, left: collapsed ? 80 : 460, right: 120 };
    this.map.fitBounds(bounds, { padding, pitch: 35, maxZoom: 19.5, duration: 900 });
  }

  private renderSummary(route: OutdoorRoute): void {
    const room = this.destination();
    const how = this.mode === "walk" ? "walk" : "drive";
    this.summary.hidden = false;
    this.summary.innerHTML = `
      <strong>${escapeHtml(this.from.value === this.locatedValue ? "Your location" : this.from.value.trim())}</strong> → <strong>${escapeHtml(room ? room.label : "Building entrance")}</strong><br/>
      ${formatMeters(route.meters)} · about ${formatMinutes(route.seconds)} ${how}${room ? `, then indoor directions from the entrance` : ""}`;
    const steps = [...route.steps];
    if (room) steps.push({ icon: "🧭", text: `Go inside — indoor navigation continues to ${room.label}`, meters: 0, location: BUILDING_ENTRANCE });
    this.stepList.replaceChildren(
      ...steps.map((step) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="step-icon">${step.icon}</span><span>${escapeHtml(step.text)}${step.meters > 0 ? `<br/><small>${formatMeters(step.meters)}</small>` : ""}</span>`;
        return li;
      })
    );
  }

  // --- Live walk

  async start(): Promise<void> {
    if (!(await this.showRoute(false)) || !this.route) return;
    const route = this.route;
    const cumulative = [0];
    for (let i = 1; i < route.points.length; i++) cumulative.push(cumulative[i - 1] + distanceMeters(route.points[i - 1], route.points[i]));
    const approachAt = cumulative[route.approachStart];
    this.walk = {
      at: 0,
      cumulative,
      approachAt,
      roadSpeed: Math.max(ROAD_MIN_SPEED[this.mode], approachAt / ROAD_SECONDS),
      paused: false,
      last: performance.now()
    };
    this.map.setCenterClampedToGround(false);
    this.follow.checked = true;
    this.updateCamera(true);
    this.setMessage("Following the route to the building…");
    this.updateButtons();
  }

  private togglePause(): void {
    if (!this.walk) return;
    this.walk.paused = !this.walk.paused;
    this.walk.last = performance.now();
    this.updateButtons();
  }

  /** Position (and travel direction) at a distance along the route. */
  private pointAt(at: number): { p: LonLat; segment: number } {
    const { points } = this.route!;
    const cum = this.walk!.cumulative;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < at) i++;
    const len = cum[i] - cum[i - 1];
    const t = len > 0 ? Math.min(1, Math.max(0, (at - cum[i - 1]) / len)) : 1;
    const a = points[i - 1];
    const b = points[i];
    return { p: { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t }, segment: i };
  }

  private tickWalk(now: number): void {
    const walk = this.walk;
    const route = this.route;
    if (!walk || !route) return;
    const dt = Math.min(0.1, (now - walk.last) / 1000);
    walk.last = now;
    const total = walk.cumulative[walk.cumulative.length - 1];
    if (!walk.paused) walk.at = Math.min(total, walk.at + dt * (walk.at < walk.approachAt ? walk.roadSpeed : FOOTPATH_SPEED));

    const { p, segment } = this.pointAt(walk.at);
    const onFootpath = walk.at >= walk.approachAt;
    const live = onFootpath ? this.toScene(p) : (() => {
      const e = lonLatToEnu(p.lon, p.lat);
      return new THREE.Vector3(e.x, e.y, DOT_LIFT);
    })();
    const walkedDots = onFootpath ? Math.floor((walk.at - walk.approachAt) / DOT_SPACING) : -1;
    this.overlay.setLive(live, "outdoor", walkedDots);
    this.setLine(route.points, [...route.points.slice(0, segment), p]);
    this.updateHud(walk.at, total);
    if (this.follow.checked) this.updateCamera(false);

    if (walk.at >= total) void this.arrive();
  }

  private updateHud(at: number, total: number): void {
    const route = this.route!;
    const room = this.destination();
    // Next maneuver: the first step that starts ahead of us.
    let stepStart = 0;
    let next = route.steps[route.steps.length - 1];
    let toNext = total - at;
    for (const step of route.steps) {
      if (stepStart > at + 1) {
        next = step;
        toNext = stepStart - at;
        break;
      }
      stepStart += step.meters;
    }
    if (at >= this.walk!.approachAt) {
      next = { icon: "🚶", text: "Follow the footpath to the entrance", meters: 0, location: BUILDING_ENTRANCE };
      toNext = total - at;
    }
    this.showHud(next.icon, next.text, room ? `To ${room.label} · ${formatMeters(total - at)} left` : `To the building entrance`, toNext);
  }

  private showHud(icon: string, instruction: string, context: string, meters: number): void {
    this.hud.hidden = false;
    this.hud.innerHTML = `
      <div class="hud-icon">${icon}</div>
      <div class="hud-text">
        <div class="hud-instruction">${escapeHtml(instruction)}</div>
        <div class="hud-context">${escapeHtml(context)}</div>
      </div>
      ${meters > 0 ? `<div class="hud-distance">${formatMeters(meters)}</div>` : ""}`;
  }

  private async arrive(): Promise<void> {
    const room = this.destination();
    this.walk = null;
    this.updateButtons();
    this.showHud("🏢", "You've reached the entrance", room ? `Going inside to ${room.label}…` : "Welcome!", 0);
    this.map.easeTo({ center: [BUILDING_ENTRANCE.lon, BUILDING_ENTRANCE.lat], zoom: 20.3, pitch: 60, duration: 1000 });
    if (!room) {
      this.setMessage("Arrived at the building entrance.");
      window.setTimeout(() => (this.hud.hidden = true), 3000);
      return;
    }
    this.setMessage(`Arrived. Indoor navigation continues to ${room.label}.`);
    await new Promise((resolve) => window.setTimeout(resolve, HANDOVER_MS));
    this.exit(false);
    this.hooks.startIndoor(room);
  }

  private updateCamera(jump: boolean): void {
    const walk = this.walk;
    if (!walk || !this.route) return;
    const onFootpath = walk.at >= walk.approachAt;
    const here = this.pointAt(walk.at).p;
    const ahead = this.pointAt(walk.at + (onFootpath ? 5 : 25)).p;
    const bearing = distanceMeters(here, ahead) > 0.5 ? bearingOf(here, ahead) : this.map.getBearing();
    const view = onFootpath ? FOOTPATH_VIEW : STREET_VIEW;
    if (jump) {
      this.map.jumpTo({ center: [here.lon, here.lat], elevation: 0, bearing, ...view });
      return;
    }
    const center = this.map.getCenter();
    let turn = bearing - this.map.getBearing();
    while (turn > 180) turn -= 360;
    while (turn < -180) turn += 360;
    const k = FOLLOW_EASE;
    this.map.jumpTo({
      center: [center.lng + (here.lon - center.lng) * k * 2, center.lat + (here.lat - center.lat) * k * 2],
      bearing: this.map.getBearing() + turn * k,
      zoom: this.map.getZoom() + (view.zoom - this.map.getZoom()) * k * 0.5,
      pitch: this.map.getPitch() + (view.pitch - this.map.getPitch()) * k * 0.5
    });
  }

  // --- Animation / cleanup

  private startAnimation(): void {
    this.layer.setOverlayVisible(OVERLAY_ID, 0, true);
    if (this.frame !== null) return;
    const tick = (now: number) => {
      this.tickWalk(now);
      this.overlay.update(this.map.getPixelRatio(), () => true);
      this.map.triggerRepaint();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  exit(resetMessage = true): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.walk = null;
    this.route = null;
    this.routeKey = "";
    this.overlay.clear();
    this.layer.setOverlayVisible(OVERLAY_ID, 0, false);
    this.setLine([]);
    for (const m of this.markers) m.remove();
    this.markers = [];
    this.hud.hidden = true;
    this.summary.hidden = true;
    this.stepList.replaceChildren();
    this.map.triggerRepaint();
    if (resetMessage) this.setMessage("");
    this.updateButtons();
  }
}
