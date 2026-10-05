import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { GROUPS, PRESETS } from "./catalog";
import { ModelLayer } from "./modelLayer";
import { setupDebugPanel } from "./debugPanel";
import { setupInteraction } from "./interaction";
import { ALT_2ND, ALT_3RD, LATITUDE, LONGITUDE } from "./placement";
import { loadRooms, roomOverlayId, type RoomFloor } from "./rooms";

const START_VIEW = { center: [LONGITUDE, LATITUDE] as [number, number], zoom: 19, pitch: 60, bearing: -20 };

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }]
  },
  ...START_VIEW,
  maxZoom: 24,
  maxPitch: 85,
  canvasContextAttributes: { antialias: true }
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(new maplibregl.ScaleControl(), "bottom-left");

const layer = new ModelLayer("glb-models", `${import.meta.env.BASE_URL}models/`);
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

function applyPreset(presetId: string): void {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  presetBar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.preset === presetId));
  for (const group of GROUPS) void setGroup(group.id, preset.groups.includes(group.id));
}

for (const preset of PRESETS) {
  const button = document.createElement("button");
  button.textContent = preset.label;
  button.dataset.preset = preset.id;
  button.addEventListener("click", () => applyPreset(preset.id));
  presetBar.appendChild(button);
}

for (const group of GROUPS) {
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.addEventListener("change", () => {
    presetBar.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    void setGroup(group.id, box.checked);
  });
  checkboxes.set(group.id, box);
  label.append(box, ` ${group.label} (${group.models.length})`);
  groupList.appendChild(label);
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
  autoButton.textContent = "▶ Auto";
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
  autoButton.textContent = "⏸ Stop";
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
  map.easeTo({ ...START_VIEW, duration: 800 });
});
// Grabbing the map stops the auto spin so it doesn't fight the user.
for (const type of ["mousedown", "touchstart", "wheel"] as const) map.getCanvas().addEventListener(type, stopAutoRotate);

setupDebugPanel(layer, document.getElementById("debug-toggle") as HTMLButtonElement);

map.on("load", () => {
  map.addLayer(layer);
  setupInteraction(map, layer);
  for (const rooms of ROOM_FLOORS) {
    loadRooms(layer, rooms, rooms.altitude)
      .then(() => layer.setOverlayVisible(roomOverlayId(rooms.groupId), rooms.altitude, checkboxes.get(rooms.groupId)?.checked ?? false))
      .catch((error) => console.error(`Failed to load rooms for ${rooms.groupId}`, error));
  }
  applyPreset("building");
});
