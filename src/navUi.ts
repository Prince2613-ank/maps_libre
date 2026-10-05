import * as maplibregl from "maplibre-gl";
import * as THREE from "three";
import type { ModelLayer } from "./modelLayer";
import { NAV_FLOORS, Navigator, samplePath, thirdFloorWeight, type FloorId, type NavRoute, type RoomChoice } from "./navigation";
import { enuToLonLat } from "./placement";
import { RouteOverlay } from "./routeOverlay";

// Navigation panel + live walk, following the Cesium app (cesium_demo/src/navigation.ts startNavigation,
// startLiveNavigationMarker, liveNavigationHudState, finishLiveNavigation).

const ROUTE_OVERLAY_ID = "route:navigation";
const DOT_SPACING_METRES = 0.4;
const LIVE_STEP_MS = 420;
const FOLLOW = { zoom: 21.4, pitch: 62 };
/** Fraction of the way the follow camera moves towards the walker each frame. */
const FOLLOW_EASE = 0.12;
const WELCOME_MS = 3000;
const ROUTE_LIFT = 0.5; // matches navigation.ts: drawn route floats 50 cm above the floor

export type NavHooks = {
  /** Show just this floor (the floor preset). */
  showFloor: (floor: FloorId) => void;
  /** Whether a floor's models are currently shown. */
  isFloorVisible: (floor: FloorId) => boolean;
  /** Load a floor's main model (needed so its saved adjustment pivots correctly). */
  ensureFloorLoaded: (floor: FloorId) => Promise<void>;
};

type Walk = {
  points: THREE.Vector3[]; // adjusted, sampled
  floors: FloorId[]; // floor each point is on
  stairStart: number;
  stairEnd: number;
  index: number;
  timer: number | null;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function headingOf(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function remaining(points: THREE.Vector3[], from: number): number {
  let total = 0;
  for (let i = Math.max(1, from + 1); i < points.length; i++) total += points[i - 1].distanceTo(points[i]);
  return total;
}

function nearestIndex(points: THREE.Vector3[], p: THREE.Vector3): number {
  let best = 0;
  points.forEach((q, i) => {
    if (q.distanceTo(p) < points[best].distanceTo(p)) best = i;
  });
  return best;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class NavigationUi {
  private readonly overlay = new RouteOverlay();
  private readonly navigator: Navigator;
  private rooms: RoomChoice[] = [];
  private route: NavRoute | null = null;
  private walk: Walk | null = null;
  private frame: number | null = null;
  private welcomeTimer: number | null = null;
  /** Where the follow camera is heading; eased towards every frame (easeTo can't animate centre elevation). */
  private cameraTarget: { lon: number; lat: number; elevation: number; bearing: number } | null = null;

  private readonly from = $<HTMLSelectElement>("nav-from");
  private readonly to = $<HTMLSelectElement>("nav-to");
  private readonly startButton = $<HTMLButtonElement>("nav-start");
  private readonly pauseButton = $<HTMLButtonElement>("nav-pause");
  private readonly exitButton = $<HTMLButtonElement>("nav-exit");
  private readonly follow = $<HTMLInputElement>("nav-follow");
  private readonly message = $<HTMLElement>("nav-message");
  private readonly summary = $<HTMLElement>("nav-summary");
  private readonly stepList = $<HTMLOListElement>("nav-steps");
  private readonly hud = $<HTMLElement>("nav-hud");

  constructor(
    private readonly map: maplibregl.Map,
    private readonly layer: ModelLayer,
    dataUrl: string,
    private readonly hooks: NavHooks
  ) {
    this.navigator = new Navigator(dataUrl);
    layer.addOverlay(ROUTE_OVERLAY_ID, this.overlay.object, 0);

    $("nav-swap").addEventListener("click", () => {
      [this.from.value, this.to.value] = [this.to.value, this.from.value];
      this.updateButtons();
    });
    this.from.addEventListener("change", () => this.updateButtons());
    this.to.addEventListener("change", () => this.updateButtons());
    this.startButton.addEventListener("click", () => void this.start());
    this.pauseButton.addEventListener("click", () => this.togglePause());
    this.exitButton.addEventListener("click", () => this.exit());
    this.follow.addEventListener("change", () => this.follow.checked && this.walk && this.followCamera(false));
    // Dragging the map while following turns follow off so the user can look around.
    map.on("dragstart", () => {
      if (this.walk) this.follow.checked = false;
    });

    this.setMessage("Loading rooms…");
    this.updateButtons();
  }

  async load(): Promise<void> {
    await this.navigator.load();
    this.rooms = this.navigator.rooms();
    for (const select of [this.from, this.to]) {
      select.replaceChildren(new Option(select === this.from ? "Choose start…" : "Choose destination…", ""));
      for (const room of this.rooms) select.appendChild(new Option(room.label, room.label));
    }
    this.setMessage("Choose rooms to start navigation.");
    this.updateButtons();
  }

  /** Is this room a navigation destination? (used by the room popup buttons) */
  canNavigate(roomName: string, floor: string): boolean {
    return floor in NAV_FLOORS && Boolean(this.navigator.findRoom(roomName, floor as FloorId));
  }

  /** Fill From or To from a room popup and open the panel section. */
  setEndpoint(which: "from" | "to", roomName: string, floor: string): void {
    const room = this.navigator.findRoom(roomName, floor as FloorId);
    if (!room) return;
    (which === "from" ? this.from : this.to).value = room.label;
    this.updateButtons();
    const section = $<HTMLDetailsElement>("nav-section");
    section.open = true;
    section.scrollIntoView({ block: "nearest" });
    this.setMessage(this.from.value && this.to.value ? "Press Start to navigate." : `Now choose the ${which === "from" ? "destination" : "start"}.`);
  }

  private choice(select: HTMLSelectElement): RoomChoice | undefined {
    return this.rooms.find((r) => r.label === select.value);
  }

  private setMessage(text: string): void {
    this.message.textContent = text;
  }

  private updateButtons(): void {
    const ready = Boolean(this.choice(this.from) && this.choice(this.to)) && this.from.value !== this.to.value;
    this.startButton.disabled = !ready;
    this.pauseButton.hidden = !this.walk;
    this.exitButton.hidden = !this.route;
    this.pauseButton.textContent = this.walk?.timer === null ? "▶ Resume" : "⏸ Pause";
  }

  // --- Start / exit

  async start(): Promise<void> {
    const from = this.choice(this.from);
    const to = this.choice(this.to);
    if (!from || !to) return this.setMessage("Choose a start and destination.");
    if (from.label === to.label) return this.setMessage("Start and destination are the same room.");

    const route = this.navigator.route(from, to);
    if (typeof route === "string") return this.setMessage(route);

    this.exit(false);
    this.setMessage("Preparing navigation…");
    this.startButton.disabled = true;
    try {
      // Both floors' main models must be loaded so their saved adjustments (and pivots) are known.
      await Promise.all([...new Set([from.floor, to.floor])].map((f) => this.hooks.ensureFloorLoaded(f)));
    } catch (error) {
      console.warn("Failed to preload floors for navigation", error);
    }

    this.route = route;
    const partA = samplePath(route.partA.map((p) => this.adjust(p)), DOT_SPACING_METRES);
    const partB = samplePath(route.partB.map((p) => this.adjust(p)), DOT_SPACING_METRES);
    this.overlay.setRoute([
      { points: partA, floor: from.floor },
      { points: partB, floor: to.floor }
    ]);

    const points = [...partA, ...partB];
    const floors = points.map((_, i) => (i < partA.length ? from.floor : to.floor));
    const crossFloor = route.partB.length > 0;
    const stairStart = crossFloor ? Math.max(0, nearestIndex(points, this.adjust(route.partB[0])) - 1) : -1;
    const stairEnd = crossFloor ? nearestIndex(points, this.adjust(route.partB[5])) + 1 : -1;
    this.walk = { points, floors, stairStart, stairEnd, index: 0, timer: null };

    this.renderSummary(route);
    this.hooks.showFloor(from.floor);
    this.overlay.setLive(points[0], floors[0], 0);
    this.updateHud();
    this.startAnimation();
    this.map.setCenterClampedToGround(false);
    if (this.follow.checked) this.followCamera(false);
    else this.fitRoute(points);
    this.resume();
    this.setMessage(crossFloor ? "Proceed to the stairs; the floor switches automatically." : "Live navigation started. Follow the blue route.");
  }

  exit(resetMessage = true): void {
    this.pause();
    if (this.welcomeTimer !== null) window.clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
    this.walk = null;
    this.route = null;
    this.cameraTarget = null;
    this.overlay.clear();
    this.stopAnimation();
    this.hud.hidden = true;
    this.summary.hidden = true;
    this.stepList.replaceChildren();
    this.map.setCenterClampedToGround(true);
    this.map.triggerRepaint();
    if (resetMessage) this.setMessage("Choose rooms to start navigation.");
    this.updateButtons();
  }

  // --- Live walk

  private resume(): void {
    const walk = this.walk;
    if (!walk || walk.timer !== null) return;
    walk.timer = window.setInterval(() => this.stepWalk(), LIVE_STEP_MS);
    this.updateButtons();
  }

  private pause(): void {
    if (this.walk?.timer != null) window.clearInterval(this.walk.timer);
    if (this.walk) this.walk.timer = null;
    this.updateButtons();
  }

  private togglePause(): void {
    if (!this.walk) return;
    if (this.walk.timer === null) this.resume();
    else this.pause();
  }

  private stepWalk(): void {
    const walk = this.walk;
    if (!walk) return;
    if (walk.index >= walk.points.length - 1) {
      void this.finish();
      return;
    }
    walk.index++;
    const floor = walk.floors[walk.index];
    if (!this.hooks.isFloorVisible(floor)) this.hooks.showFloor(floor);
    this.overlay.setLive(walk.points[walk.index], floor, walk.index);
    this.updateHud();
    if (this.follow.checked) this.followCamera(true);
  }

  private stepFollowCamera(): void {
    const target = this.cameraTarget;
    if (!target || !this.follow.checked || !this.walk) return;
    const center = this.map.getCenter();
    const elevation = this.map.getCenterElevation();
    let turn = target.bearing - this.map.getBearing();
    while (turn > 180) turn -= 360;
    while (turn < -180) turn += 360;
    const k = FOLLOW_EASE;
    this.map.jumpTo({
      center: [center.lng + (target.lon - center.lng) * k, center.lat + (target.lat - center.lat) * k],
      elevation: elevation + (target.elevation - elevation) * k,
      bearing: this.map.getBearing() + turn * k
    });
  }

  private async finish(): Promise<void> {
    const route = this.route;
    this.exit(false);
    if (!route) return;
    this.showHud("🎉", `Welcome to ${route.to.roomName}`, "You have arrived", 0);
    this.welcomeTimer = window.setTimeout(() => (this.hud.hidden = true), WELCOME_MS);
    this.setMessage(`Arrived at ${route.to.label}.`);
    this.hooks.showFloor(route.to.floor);
    // Look at the destination room from above, like Cesium's focusDestinationRoomView.
    const end = this.adjust(route.partB.length ? route.partB[route.partB.length - 1] : route.partA[route.partA.length - 1]);
    this.map.setCenterClampedToGround(false);
    this.map.jumpTo({ elevation: end.z });
    this.map.easeTo({ center: enuToLonLat(end.x, end.y), zoom: 21, pitch: 55, duration: 1200 });
  }

  /** Same instructions as Cesium's liveNavigationHudState. */
  private updateHud(): void {
    const walk = this.walk;
    const route = this.route;
    if (!walk || !route) return;
    const i = walk.index;
    const floor = walk.floors[i];
    const nextFloor = walk.floors[Math.min(i + 1, walk.floors.length - 1)];
    const left = remaining(walk.points, i);
    const context = `${NAV_FLOORS[floor].label} to ${route.to.label}`;

    if (i >= walk.points.length - 1) return this.showHud("🚩", "Arrived", context, 0);
    if (i >= walk.stairStart && i <= walk.stairEnd)
      return this.showHud("🪜", "Use stairs", `Be careful - move to ${NAV_FLOORS[route.to.floor].label}`, left);
    if (nextFloor !== floor) return this.showHud("🪜", "Stairs ahead", `Be careful - move to ${NAV_FLOORS[nextFloor].label}`, left);
    if (i < 1 || i >= walk.points.length - 2) return this.showHud("↑", "Forward", context, left);

    let diff = headingOf(walk.points[i], walk.points[i + 1]) - headingOf(walk.points[i - 1], walk.points[i]);
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    if (Math.abs(diff) < 0.45) return this.showHud("↑", "Forward", context, left);
    const turnLeft = diff > 0;
    this.showHud(turnLeft ? "↰" : "↱", `Turn ${turnLeft ? "left" : "right"}`, `Next: ${context}`, left);
  }

  private showHud(icon: string, instruction: string, context: string, metres: number): void {
    this.hud.hidden = false;
    this.hud.innerHTML = `
      <div class="hud-icon">${icon}</div>
      <div class="hud-text">
        <div class="hud-instruction">${escapeHtml(instruction)}</div>
        <div class="hud-context">${escapeHtml(context)}</div>
      </div>
      ${metres > 0 ? `<div class="hud-distance">${Math.max(1, Math.round(metres))} m</div>` : ""}`;
  }

  private renderSummary(route: NavRoute): void {
    const metres = Math.round(route.distance);
    this.summary.hidden = false;
    this.summary.innerHTML = `
      <strong>${escapeHtml(route.from.label)}</strong> → <strong>${escapeHtml(route.to.label)}</strong><br/>
      ${metres} m · about ${Math.max(1, Math.round(metres / 80))} min walk`;
    this.stepList.replaceChildren(
      ...route.steps.map((step) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="step-icon">${step.icon}</span><span><b>${escapeHtml(step.title)}</b><br/>${escapeHtml(step.text)}</span>`;
        return li;
      })
    );
  }

  // --- Camera

  private followCamera(smooth: boolean): void {
    const walk = this.walk;
    if (!walk) return;
    const p = walk.points[walk.index];
    // Look along the route a few dots ahead so small zig-zags don't swing the camera.
    const ahead = walk.points[Math.min(walk.index + 3, walk.points.length - 1)];
    const behind = walk.points[Math.max(walk.index - 1, 0)];
    const dir = ahead.distanceTo(p) > 0.05 ? headingOf(p, ahead) : headingOf(behind, p);
    const bearing = 90 - THREE.MathUtils.radToDeg(dir);
    const [lon, lat] = enuToLonLat(p.x, p.y);
    this.cameraTarget = { lon, lat, elevation: p.z, bearing };
    if (!smooth) this.map.jumpTo({ center: [lon, lat], elevation: p.z, bearing, ...FOLLOW });
  }

  private fitRoute(points: THREE.Vector3[]): void {
    const bounds = new maplibregl.LngLatBounds();
    for (const p of points) bounds.extend(enuToLonLat(p.x, p.y));
    this.map.fitBounds(bounds, { padding: 120, pitch: 50, maxZoom: 21, duration: 800 });
  }

  // --- Drawing

  /** Raw route point → where it is drawn: moved with its floor's saved adjustment (blended on the stairs). */
  private adjust(p: THREE.Vector3): THREE.Vector3 {
    let w = thirdFloorWeight(p.z - ROUTE_LIFT);
    if (w < 0.15) w = 0;
    else if (w > 0.85) w = 1;
    const second = p.clone().applyMatrix4(this.layer.setTransform("second", NAV_FLOORS.second.altitude));
    const third = p.clone().applyMatrix4(this.layer.setTransform("third", NAV_FLOORS.third.altitude));
    return second.lerp(third, w);
  }

  private startAnimation(): void {
    this.layer.setOverlayVisible(ROUTE_OVERLAY_ID, 0, true);
    if (this.frame !== null) return;
    const tick = () => {
      this.stepFollowCamera();
      this.overlay.update(this.map.getPixelRatio(), (floor) => this.hooks.isFloorVisible(floor as FloorId));
      this.map.triggerRepaint();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stopAnimation(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.layer.setOverlayVisible(ROUTE_OVERLAY_ID, 0, false);
  }
}
