import type * as maplibregl from "maplibre-gl";
import * as THREE from "three";
import type { ModelLayer } from "./modelLayer";
import { adjustmentMatrix, type Adjustment } from "./adjustments";

// Debug → 3D layers → corner handles: the four footprint corners of the selected layer are drawn on the map. Dragging
// one keeps the opposite corner where it is and turns + scales the layer (yaw, scale) so the dragged corner lands on
// the cursor; Shift-drag moves the whole layer instead.

const OVERLAY = "debug-corner-handles";
const HIT_RADIUS_PX = 14;
const LIFT = 0.1; // m above the layer's base so handles don't z-fight with the floor
const COLOR = { corner: 0xfbbf24, active: 0xef4444, outline: 0x3b82f6 };

const round = (value: number) => Math.round(value * 1000) / 1000;
const deg = THREE.MathUtils.radToDeg;

export type CornerHooks = {
  layerId: () => string;
  adjustment: () => Adjustment;
  /** Apply (and store) a new adjustment for the selected layer. */
  apply: (adjustment: Adjustment) => void;
};

function dotTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const c = canvas.getContext("2d")!;
  c.beginPath();
  c.arc(32, 32, 26, 0, Math.PI * 2);
  c.fillStyle = "#ffffff";
  c.fill();
  c.lineWidth = 9;
  c.strokeStyle = "#111827";
  c.stroke();
  return new THREE.CanvasTexture(canvas);
}

export function setupCornerAdjust(layer: ModelLayer, map: maplibregl.Map, hooks: CornerHooks) {
  const group = new THREE.Group();
  const dot = dotTexture();
  let enabled = true;
  let shown = false;
  let overlayAdded = false;
  let activeCorner: number | null = null;
  let drag: { corner: number; start: THREE.Vector3; before: Adjustment; moved: boolean; plane: THREE.Plane; shift: boolean } | null = null;
  let swallowClick = false;

  /** Footprint corners (ENU, at the layer's base) before the adjustment, in order SW, SE, NE, NW. */
  function baseCorners() {
    const geometry = layer.setGeometry(hooks.layerId());
    if (!geometry) return null;
    const { min, max } = geometry.bounds;
    const corners = [new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, max.y, min.z), new THREE.Vector3(min.x, max.y, min.z)];
    return { corners, pivot: geometry.pivot };
  }

  /** Corners after an adjustment. */
  function placed(adj: Adjustment) {
    const base = baseCorners();
    if (!base) return null;
    const matrix = adjustmentMatrix(adj, base.pivot);
    return { ...base, world: base.corners.map((c) => c.clone().applyMatrix4(matrix)) };
  }

  function ensureOverlay(): void {
    if (overlayAdded) return;
    layer.addOverlay(OVERLAY, group, 0); // in no set: drawn in plain ENU metres, so the adjusted corners line up
    overlayAdded = true;
  }

  function redraw(): void {
    const data = shown && enabled ? placed(hooks.adjustment()) : null;
    if (overlayAdded) layer.setOverlayVisible(OVERLAY, 0, data !== null);
    if (!data) return map.triggerRepaint();
    ensureOverlay();
    for (const child of [...group.children]) {
      group.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
      ((child as THREE.Mesh).material as THREE.Material)?.dispose();
    }
    const points = data.world.map((p) => p.clone().setZ(p.z + LIFT));
    const add = (object: THREE.Object3D, order: number) => {
      object.renderOrder = order;
      object.frustumCulled = false;
      group.add(object);
    };
    add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: COLOR.outline, depthTest: false, transparent: true })), 998);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(points.flatMap((_, i) => new THREE.Color(i === activeCorner ? COLOR.active : COLOR.corner).toArray()), 3)
    );
    add(new THREE.Points(geometry, new THREE.PointsMaterial({ size: 16, sizeAttenuation: false, map: dot, vertexColors: true, transparent: true, alphaTest: 0.4, depthTest: false })), 999);
    layer.setOverlayVisible(OVERLAY, 0, true);
    map.triggerRepaint();
  }

  const canvasPoint = (e: MouseEvent) => {
    const rect = map.getCanvas().getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  function hitTest(p: { x: number; y: number }): number | null {
    const data = shown && enabled ? placed(hooks.adjustment()) : null;
    const matrix = layer.overlayMatrix(OVERLAY, 0);
    if (!data || !matrix) return null;
    let best: number | null = null;
    let bestDistance = HIT_RADIUS_PX;
    data.world.forEach((w, i) => {
      const screen = layer.projectToScreen(w.clone().setZ(w.z + LIFT).applyMatrix4(matrix));
      if (!screen) return;
      const distance = Math.hypot(screen.x - p.x, screen.y - p.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    return best;
  }

  /** Where a screen point lands on a horizontal plane, in ENU metres. */
  function planePoint(p: { x: number; y: number }, plane: THREE.Plane): THREE.Vector3 | null {
    const ray = layer.screenRay(p.x, p.y);
    const matrix = layer.overlayMatrix(OVERLAY, 0);
    if (!ray || !matrix) return null;
    return ray.applyMatrix4(matrix.invert()).intersectPlane(plane, new THREE.Vector3());
  }

  /** The adjustment that puts `corner` at `target` while its opposite corner stays put (yaw + scale only). */
  function pinOpposite(before: Adjustment, corner: number, target: THREE.Vector3): Adjustment | null {
    const base = baseCorners();
    const now = placed(before);
    if (!base || !now) return null;
    const opposite = (corner + 2) % 4;
    const fixed = now.world[opposite];
    const v0 = base.corners[corner].clone().sub(base.corners[opposite]);
    const w = target.clone().sub(fixed);
    if (v0.lengthSq() < 1e-9 || w.lengthSq() < 1e-6) return null;
    const scale = Math.min(20, Math.max(0.01, Math.hypot(w.x, w.y) / Math.hypot(v0.x, v0.y)));
    // The yaw that turns v0 onto w (pitch and roll kept).
    const yaw = round(((((deg(Math.atan2(w.y, w.x) - Math.atan2(v0.y, v0.x)) + 180) % 360) + 360) % 360) - 180);
    const next: Adjustment = { ...before, yaw, scale: round(scale), east: 0, north: 0, up: 0 };
    // Translate so the opposite corner doesn't move.
    const landed = base.corners[opposite].clone().applyMatrix4(adjustmentMatrix(next, base.pivot));
    next.east = round(fixed.x - landed.x);
    next.north = round(fixed.y - landed.y);
    next.up = round(fixed.z - landed.z);
    return next;
  }

  const container = map.getCanvasContainer();
  container.addEventListener(
    "mousedown",
    (e) => {
      if (!shown || !enabled || e.button !== 0) return;
      const p = canvasPoint(e);
      const hit = hitTest(p);
      const data = placed(hooks.adjustment());
      if (hit === null || !data) return;
      e.stopPropagation(); // keep the map from panning and popups from opening
      e.preventDefault();
      swallowClick = true;
      activeCorner = hit;
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -data.world[hit].z);
      const start = planePoint(p, plane);
      if (start) drag = { corner: hit, start, before: hooks.adjustment(), moved: false, plane, shift: e.shiftKey };
      redraw();
    },
    true
  );
  container.addEventListener(
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true
  );
  window.addEventListener("mousemove", (e) => {
    if (!shown || !enabled) return;
    const p = canvasPoint(e);
    if (!drag) {
      if (e.target instanceof Node && container.contains(e.target)) map.getCanvas().style.cursor = hitTest(p) !== null ? "move" : "";
      return;
    }
    const now = planePoint(p, drag.plane);
    if (!now) return;
    let next: Adjustment | null;
    if (drag.shift) {
      next = { ...drag.before, east: round(drag.before.east + now.x - drag.start.x), north: round(drag.before.north + now.y - drag.start.y) };
    } else {
      const origin = placed(drag.before)!.world[drag.corner];
      next = pinOpposite(drag.before, drag.corner, origin.clone().add(now).sub(drag.start));
    }
    if (!next) return;
    drag.moved = true;
    hooks.apply(next);
  });
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = null;
    activeCorner = null;
    redraw();
  });

  return {
    /** Show the handles for the selected layer (the 3D layers tab is open). */
    setShown(on: boolean): void {
      shown = on;
      if (!on) map.getCanvas().style.cursor = "";
      redraw();
    },
    setEnabled(on: boolean): void {
      enabled = on;
      if (!on) map.getCanvas().style.cursor = "";
      redraw();
    },
    /** The layer or its adjustment changed. */
    update: redraw
  };
}
