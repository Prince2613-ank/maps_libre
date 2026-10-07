import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { GROUPS, PRESETS } from "./catalog";
import { ModelLayer } from "./modelLayer";
import { setupDebugPanel } from "./debugPanel";
import { setupInteraction } from "./interaction";
import { ALT_2ND, ALT_3RD, LATITUDE, LONGITUDE } from "./placement";
import { loadRooms, roomOverlayId, type RoomFloor } from "./rooms";
import { NavigationUi } from "./navUi";
import { SolarUi } from "./solarUi";
import { BookingUi } from "./bookingUi";
import { tintRooms } from "./rooms";
import { BasemapControl, initialStyle } from "./basemaps";
import { hydrateIcons, icon } from "./icons";
import { setupPanel } from "./panel";
import { PLACE } from "./place";
import { renderPlaceCard } from "./placeCard";
import { setupSearch } from "./search";
import { NAV_FLOORS, type FloorId } from "./navigation";
import { OutdoorNavigationUi } from "./outdoorNavUi";

// maplibre-gl v6 looks for its worker file next to its own script, which isn't there once Vite bundles it
// (404 → "Worker failed to load" in production). Vite bundles the worker with its shared code instead.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

renderPlaceCard(document.getElementById("place-card")!, PLACE, { lat: LATITUDE, lon: LONGITUDE });
hydrateIcons();
setupPanel();

const START_VIEW = { center: [LONGITUDE, LATITUDE] as [number, number], zoom: 19, pitch: 60, bearing: -20 };

const map = new maplibregl.Map({
  container: "map",
  style: initialStyle(),
  ...START_VIEW,
  maxZoom: 24,
  maxPitch: 85,
  canvasContextAttributes: { antialias: true }
});

/** Mount an element from index.html as a map control, so it stacks with MapLibre's own. */
const htmlControl = (id: string): maplibregl.IControl => {
  const el = document.getElementById(id)!;
  return { onAdd: () => el, onRemove: () => el.remove() };
};

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(htmlControl("view-ctrl"), "top-right");
map.addControl(htmlControl("floor-ctrl"), "top-right");
map.addControl(new maplibregl.ScaleControl(), "bottom-left");

const layer = new ModelLayer("glb-models", `${import.meta.env.BASE_URL}models/`);
for (const { file, maxTextureSize, doubleSided } of GROUPS.flatMap((g) => g.models)) {
  if (maxTextureSize) layer.limitTextureSize(file, maxTextureSize);
  if (doubleSided) layer.setDoubleSided(file);
}
// Handy for poking at the scene from the browser console during development.
if (import.meta.env.DEV) Object.assign(window, { indoor: { map, layer } });

// Clickable room shapes, drawn on the same floors as in the Cesium app.
const ROOM_FLOORS: (RoomFloor & { altitude: number })[] = [
  { groupId: "second", url: `${import.meta.env.BASE_URL}data/2nd_floor_room1.geojson`, floorLabel: "2nd Floor", altitude: ALT_2ND },
  { groupId: "third", url: `${import.meta.env.BASE_URL}data/3rd_floor_room1.geojson`, floorLabel: "3rd Floor", altitude: ALT_3RD }
];

const status = document.getElementById("status")!;
const groupList = document.getElementById("groups")!;
const presetBar = document.getElementById("presets")!;
const checkboxes = new Map<string, HTMLInputElement>();
let loading = 0;

function updateStatus(): void {
  status.textContent = loading > 0 ? `Loading ${loading} model${loading === 1 ? "" : "s"}…` : "";
}

async function setGroup(id: string, visible: boolean): Promise<void> {
  const group = GROUPS.find((g) => g.id === id);
  if (!group) return;
  const box = checkboxes.get(id);
  if (box) box.checked = visible;
  for (const rooms of ROOM_FLOORS) if (rooms.groupId === id) layer.setOverlayVisible(roomOverlayId(id), rooms.altitude, visible);
  await Promise.all(
    group.models.map(async ({ file, altitude }) => {
      const needsLoad = visible && !layer.isVisible(file, altitude);
      if (needsLoad) { loading++; updateStatus(); }
      try {
        await layer.setVisible(file, altitude, visible);
      } catch (error) {
        console.error(`Failed to load ${file}`, error);
      } finally {
        if (needsLoad) { loading--; updateStatus(); }
      }
    })
  );
}

function isGroupVisible(id: string): boolean {
  return checkboxes.get(id)?.checked ?? false;
}

function showActivePreset(presetId: string | null): void {
  presetBar.querySelectorAll("button").forEach((b) => {
    const active = b.dataset.preset === presetId;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  });
}

function applyPreset(presetId: string): void {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  showActivePreset(presetId);
  for (const group of GROUPS) void setGroup(group.id, preset.groups.includes(group.id));
}

for (const preset of PRESETS) {
  const button = document.createElement("button");
  button.type = "button";
  button.innerHTML = preset.short || icon("building");
  button.title = preset.label;
  button.setAttribute("aria-label", preset.label);
  button.dataset.preset = preset.id;
  button.addEventListener("click", () => applyPreset(preset.id));
  presetBar.appendChild(button);
}

for (const group of GROUPS) {
  const row = document.createElement("label");
  row.className = "layer-row";
  const text = document.createElement("span");
  text.className = "layer-text";
  const name = document.createElement("span");
  name.className = "layer-name";
  name.textContent = group.label;
  const count = document.createElement("small");
  count.textContent = `${group.models.length} model${group.models.length === 1 ? "" : "s"}`;
  text.append(name, count);
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "switch";
  box.addEventListener("change", () => {
    // One layer at a time: switching one on switches the others off, and the floor switcher follows.
    if (box.checked) {
      for (const other of GROUPS) if (other.id !== group.id && isGroupVisible(other.id)) void setGroup(other.id, false);
    }
    const preset = box.checked ? PRESETS.find((p) => p.groups.length === 1 && p.groups[0] === group.id) : undefined;
    showActivePreset(preset?.id ?? null);
    void setGroup(group.id, box.checked);
  });
  checkboxes.set(group.id, box);
  row.append(text, box);
  groupList.appendChild(row);
}

// --- Rotation controls
const ROTATE_STEP_DEG = 45;
const AUTO_ROTATE_DEG_PER_SEC = 12;
const autoButton = document.getElementById("rotate-auto")!;
let autoFrame: number | null = null;

function stopAutoRotate(): void {
  if (autoFrame !== null) cancelAnimationFrame(autoFrame);
  autoFrame = null;
  autoButton.classList.remove("active");
  autoButton.setAttribute("aria-pressed", "false");
  autoButton.innerHTML = icon("play");
  autoButton.title = "Spin the view around the map centre";
}

function startAutoRotate(): void {
  let last = performance.now();
  const tick = (now: number) => {
    map.setBearing(map.getBearing() + ((now - last) / 1000) * AUTO_ROTATE_DEG_PER_SEC);
    last = now;
    autoFrame = requestAnimationFrame(tick);
  };
  autoFrame = requestAnimationFrame(tick);
  autoButton.classList.add("active");
  autoButton.setAttribute("aria-pressed", "true");
  autoButton.innerHTML = icon("pause");
  autoButton.title = "Stop spinning";
}

function rotateBy(deg: number): void {
  stopAutoRotate();
  map.easeTo({ bearing: map.getBearing() + deg, duration: 600 });
}

document.getElementById("rotate-left")!.addEventListener("click", () => rotateBy(-ROTATE_STEP_DEG));
document.getElementById("rotate-right")!.addEventListener("click", () => rotateBy(ROTATE_STEP_DEG));
autoButton.addEventListener("click", () => (autoFrame === null ? startAutoRotate() : stopAutoRotate()));
document.getElementById("rotate-reset")!.addEventListener("click", () => {
  stopAutoRotate();
  map.jumpTo({ elevation: 0 }); // navigation may have raised the camera centre to a floor's height
  map.easeTo({ ...START_VIEW, duration: 800 });
});
// Grabbing the map stops the auto spin so it doesn't fight the user.
for (const type of ["mousedown", "touchstart", "wheel"] as const) map.getCanvas().addEventListener(type, stopAutoRotate);

setupDebugPanel(layer, document.getElementById("debug-toggle") as HTMLButtonElement, map, { showFloor: (preset) => applyPreset(preset) });

map.on("load", () => {
  map.addLayer(layer);
  const solar = new SolarUi(map, layer);
  // Bottom-left controls stack upwards, so this sits above the scale bar.
  map.addControl(new BasemapControl(() => solar.tintBasemap()), "bottom-left");
  const navigation = new NavigationUi(map, layer, `${import.meta.env.BASE_URL}data/`, {
    showFloor: (floor) => applyPreset(floor),
    isFloorVisible: isGroupVisible,
    ensureFloorLoaded: async (floor) => {
      const main = GROUPS.find((g) => g.id === floor)?.models[0];
      if (main) await layer.preload(main.file, main.altitude);
    }
  });
  // Navigate tab: "Inside the building" (room to room) or "From outside" (any place to the entrance, then inside).
  const setNavMode = (mode: "indoor" | "outdoor") => {
    document.querySelectorAll<HTMLButtonElement>("[data-nav-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.navMode === mode)));
    document.getElementById("nav-indoor")!.hidden = mode !== "indoor";
    document.getElementById("nav-outdoor")!.hidden = mode !== "outdoor";
  };
  document.querySelectorAll<HTMLButtonElement>("[data-nav-mode]").forEach((b) =>
    b.addEventListener("click", () => setNavMode(b.dataset.navMode as "indoor" | "outdoor"))
  );
  const outdoor = new OutdoorNavigationUi(map, layer, `${import.meta.env.BASE_URL}data/outdoor_navigation_points.geojson`, {
    showOutside: () => applyPreset("building"),
    stopIndoor: () => navigation.exit(),
    startIndoor: (room) => {
      setNavMode("indoor");
      // The outdoor route ends at the entrance on the 2nd floor (cesium_demo/src/buildingPOI.ts).
      if (room.floor === "second" && room.roomName.toLowerCase() === "entrance") return;
      navigation.setEndpoint("from", "Entrance", "second");
      navigation.setEndpoint("to", room.roomName, room.floor);
      void navigation.start();
    }
  });
  if (import.meta.env.DEV) Object.assign((window as any).indoor, { navigation, outdoor });
  navigation
    .load()
    .then(() => outdoor.setRooms(navigation.roomList()))
    .catch((error) => console.error("Failed to load navigation data", error));
  const booking = new BookingUi({
    floorOf: (room) => ["second", "third"].find((floor) => navigation.canNavigate(room, floor)),
    focusRoom: (room, floor) => void navigation.focusRoom(room, floor),
    onChange: () => {
      if (tintRooms((name) => booking.tintFor(name))) map.triggerRepaint();
    }
  });
  setupSearch({
    rooms: () => navigation.roomList(),
    floorLabel: (floor) => NAV_FLOORS[floor as FloorId]?.label ?? floor,
    bookingStatus: (room) => booking.statusFor(room),
    focus: (room) => void navigation.focusRoom(room.roomName, room.floor),
    routeTo: (room) => navigation.setEndpoint("to", room.roomName, room.floor)
  });
  setupInteraction(map, layer, {
    canNavigate: (room, groupId) => navigation.canNavigate(room, groupId),
    onDirections: (which, room, groupId) => navigation.setEndpoint(which, room, groupId),
    bookingStatus: (room) => booking.statusFor(room),
    onBook: (room) => booking.openFor(room)
  });
  for (const rooms of ROOM_FLOORS) {
    loadRooms(layer, rooms, rooms.altitude)
      .then(() => tintRooms((name) => booking.tintFor(name)))
      .then(() => layer.setOverlayVisible(roomOverlayId(rooms.groupId), rooms.altitude, checkboxes.get(rooms.groupId)?.checked ?? false))
      .catch((error) => console.error(`Failed to load rooms for ${rooms.groupId}`, error));
  }
  applyPreset("building");
});
