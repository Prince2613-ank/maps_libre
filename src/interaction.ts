import type * as maplibregl from "maplibre-gl";
import * as THREE from "three";
import { chairInfo } from "./chairs";
import type { ModelLayer, PickHit } from "./modelLayer";
import { highlightRoom, roomOf } from "./rooms";

// Click / hover behaviour copied from the Cesium app (cesium_demo/src/ui.ts):
// hover a chair → blue highlight; click a chair → chair popup; hover/click a room → room popup.

const HOVER_INTERVAL_MS = 60;
const CHAIR_HOVER_COLOR = new THREE.Color(0x1f6feb);

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function chairPopupHtml(file: string): string {
  const chair = chairInfo(file)!;
  const status = chair.available
    ? `<span class="status available">Available</span>`
    : `<span class="status occupied">Occupied</span>`;
  return `
    <div class="popup-title">🪑 ${escapeHtml(chair.name)}</div>
    <table>
      <tr><th>Chair ID</th><td>CHAIR-${chair.index}</td></tr>
      <tr><th>Floor</th><td>${chair.floorLabel}</td></tr>
      <tr><th>Status</th><td>${status}</td></tr>
    </table>`;
}

function roomPopupHtml(mesh: THREE.Object3D): string {
  const room = roomOf.get(mesh)!;
  const rows = [
    room.roomId ? `<tr><th>Room ID</th><td>${escapeHtml(room.roomId)}</td></tr>` : "",
    `<tr><th>Floor</th><td>${room.floorLabel}</td></tr>`,
    room.type ? `<tr><th>Type</th><td>${escapeHtml(room.type)}</td></tr>` : "",
    room.bookable ? `<tr><th>Status</th><td><span class="status available">Available</span></td></tr>` : ""
  ].join("");
  return `
    <div class="popup-title">🚪 ${escapeHtml(room.name)}</div>
    <table>${rows}</table>
    ${room.bookable ? `<div class="popup-note">Bookable meeting room</div>` : ""}`;
}

/** Tint every material of a chair model (or restore it). Each GLB has its own materials, so this is per chair. */
function tintChair(root: THREE.Object3D, on: boolean): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of [mesh.material].flat() as THREE.MeshStandardMaterial[]) {
      if (!material.emissive) continue;
      material.userData.baseEmissive ??= material.emissive.clone();
      material.emissive.copy(on ? CHAIR_HOVER_COLOR : material.userData.baseEmissive);
    }
  });
}

/** The GLB root a hit mesh belongs to (the object directly under the layer's per-model group). */
function modelRoot(object: THREE.Object3D): THREE.Object3D {
  let node = object;
  while (node.parent && node.parent.parent && node.parent.parent.type !== "Scene") node = node.parent;
  return node;
}

export function setupInteraction(map: maplibregl.Map, layer: ModelLayer): void {
  const container = map.getContainer();

  // --- Popup glued to a 3D point
  const popup = document.createElement("div");
  popup.className = "model-popup";
  popup.hidden = true;
  const popupBody = document.createElement("div");
  const close = document.createElement("button");
  close.className = "popup-close";
  close.textContent = "×";
  close.title = "Close";
  popup.append(close, popupBody);
  container.appendChild(popup);
  let popupPoint: THREE.Vector3 | null = null;

  const placePopup = () => {
    if (!popupPoint) return;
    const screen = layer.projectToScreen(popupPoint);
    popup.style.visibility = screen ? "visible" : "hidden";
    if (screen) popup.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%, calc(-100% - 12px))`;
  };
  layer.onAfterRender(placePopup);

  const openPopup = (html: string, point: THREE.Vector3) => {
    popupBody.innerHTML = html;
    popupPoint = point;
    popup.hidden = false;
    placePopup();
  };
  const closePopup = () => {
    popup.hidden = true;
    popupPoint = null;
  };
  close.addEventListener("click", closePopup);
  window.addEventListener("keydown", (e) => e.key === "Escape" && closePopup());

  // --- Hover tooltip (follows the cursor)
  const tooltip = document.createElement("div");
  tooltip.className = "model-tooltip";
  tooltip.hidden = true;
  container.appendChild(tooltip);

  let hovered: { kind: "chair" | "room"; object: THREE.Object3D } | null = null;
  const clearHover = () => {
    if (hovered?.kind === "chair") tintChair(hovered.object, false);
    if (hovered?.kind === "room") highlightRoom(hovered.object, false);
    hovered = null;
    tooltip.hidden = true;
    map.getCanvas().style.cursor = "";
  };

  const describe = (hit: PickHit) =>
    roomOf.has(hit.object)
      ? { kind: "room" as const, object: hit.object, label: roomOf.get(hit.object)!.name }
      : { kind: "chair" as const, object: modelRoot(hit.object), label: chairInfo(hit.file)?.name ?? hit.file };

  // Chairs first, then rooms — same priority as the Cesium click handler (getPickedChair before the room pick).
  const pickAt = (point: maplibregl.Point) => {
    const chair = layer.pick(point.x, point.y, (file) => chairInfo(file) !== null);
    if (chair) return chair;
    const room = layer.pick(point.x, point.y, (file) => file.startsWith("rooms:"));
    return room && roomOf.has(room.object) ? room : null;
  };

  let lastHover = 0;
  map.on("mousemove", (event) => {
    const now = performance.now();
    if (now - lastHover < HOVER_INTERVAL_MS) return;
    lastHover = now;

    const hit = pickAt(event.point);
    const next = hit ? describe(hit) : null;
    if (next?.object !== hovered?.object) {
      clearHover();
      if (next) {
        hovered = { kind: next.kind, object: next.object };
        if (next.kind === "chair") tintChair(next.object, true);
        else highlightRoom(next.object, true);
        map.getCanvas().style.cursor = "pointer";
      }
      map.triggerRepaint();
    }
    if (next) {
      tooltip.textContent = next.label;
      tooltip.hidden = false;
      tooltip.style.transform = `translate(${event.point.x + 14}px, ${event.point.y + 14}px)`;
    }
  });
  map.getCanvas().addEventListener("mouseleave", () => {
    clearHover();
    map.triggerRepaint();
  });

  map.on("click", (event) => {
    const hit = pickAt(event.point);
    if (!hit) {
      closePopup();
      return;
    }
    tooltip.hidden = true;
    openPopup(roomOf.has(hit.object) ? roomPopupHtml(hit.object) : chairPopupHtml(hit.file), hit.point);
  });
}
