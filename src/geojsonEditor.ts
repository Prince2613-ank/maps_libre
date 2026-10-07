import type * as maplibregl from "maplibre-gl";
import * as THREE from "three";
import type { ModelLayer } from "./modelLayer";
import { ALT_2ND, ALT_3RD, GEOJSON_HEIGHT_KEY, enuToLonLat, geojsonHeight, lonLatToEnu } from "./placement";

// Debug → GeoJSON: edit the data files in public/data on the map. Each file is drawn where the app uses it (on its
// floor, with that floor layer's adjustment), so corners can be dragged onto the model's walls; the edit is turned
// back into the file's raw lon/lat. Save writes the file through the dev server (vite.config.ts).

type EditFile = {
  file: string;
  label: string;
  /** Catalog layer whose debug adjustment the data follows (null: none, e.g. outdoor ground points). */
  set: string | null;
  altitude: number;
  /** Floor preset to show while editing. */
  preset: string;
};

const FILES: EditFile[] = [
  { file: "2nd_floor_room1.geojson", label: "2nd floor · room shapes", set: "second", altitude: ALT_2ND, preset: "second" },
  { file: "2nd_floor_corridor.geojson", label: "2nd floor · corridor points", set: "second", altitude: ALT_2ND, preset: "second" },
  { file: "door_2nd.geojson", label: "2nd floor · doors", set: "second", altitude: ALT_2ND, preset: "second" },
  { file: "3rd_floor_room1.geojson", label: "3rd floor · room shapes", set: "third", altitude: ALT_3RD, preset: "third" },
  { file: "3rd_floor_corridor.geojson", label: "3rd floor · corridor points", set: "third", altitude: ALT_3RD, preset: "third" },
  { file: "door_3rd.geojson", label: "3rd floor · doors", set: "third", altitude: ALT_3RD, preset: "third" },
  // Outdoor navigation draws these at ground level, with no layer adjustment (outdoorNavUi.ts).
  { file: "outdoor_navigation_points.geojson", label: "Outdoor path points", set: null, altitude: 0, preset: "building" }
];

const LIFT = 0.12; // m above the floor, just over the room shapes (5 cm) and nav points (10 cm)
const HIT_RADIUS_PX = 12;
const SHARED_TOLERANCE_M = 0.02; // corners closer than this count as one shared corner
const STEPS = [0.01, 0.05, 0.1, 0.5, 1];
const DECIMALS = 10; // lon/lat digits written (~0.01 mm)

const COLOR = { outline: 0xf59e0b, corner: 0xfbbf24, point: 0x22d3ee, selected: 0x3b82f6, active: 0xef4444 };

type Coord = number[];
/** One draggable corner: the coordinate arrays it writes (a ring's first corner also closes the ring). */
type Handle = { feature: number; targets: Coord[]; corner: number; corners: number };
type Outline = { feature: number; handles: number[]; closed: boolean };
type Doc = { meta: EditFile; data: any; eol: string; handles: Handle[]; outlines: Outline[]; dirty: boolean; undo: string[] };

export type GeojsonEditorHooks = { showFloor: (preset: string) => void };

const sameCoord = (a: Coord, b: Coord) => a[0] === b[0] && a[1] === b[1];

function index(data: any): Pick<Doc, "handles" | "outlines"> {
  const handles: Handle[] = [];
  const outlines: Outline[] = [];
  const addRing = (feature: number, ring: Coord[], closed: boolean) => {
    const n = closed && ring.length > 1 && sameCoord(ring[0], ring[ring.length - 1]) ? ring.length - 1 : ring.length;
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(handles.length);
      handles.push({ feature, targets: i === 0 && n < ring.length ? [ring[0], ring[ring.length - 1]] : [ring[i]], corner: i + 1, corners: n });
    }
    outlines.push({ feature, handles: ids, closed });
  };
  data.features.forEach((f: any, i: number) => {
    const g = f.geometry;
    if (!g) return;
    if (g.type === "Point") handles.push({ feature: i, targets: [g.coordinates], corner: 1, corners: 1 });
    else if (g.type === "MultiPoint") g.coordinates.forEach((c: Coord, k: number) => handles.push({ feature: i, targets: [c], corner: k + 1, corners: g.coordinates.length }));
    else if (g.type === "LineString") addRing(i, g.coordinates, false);
    else if (g.type === "MultiLineString") g.coordinates.forEach((line: Coord[]) => addRing(i, line, false));
    else if (g.type === "Polygon") g.coordinates.forEach((ring: Coord[]) => addRing(i, ring, true));
    else if (g.type === "MultiPolygon") g.coordinates.forEach((poly: Coord[][]) => poly.forEach((ring) => addRing(i, ring, true)));
  });
  return { handles, outlines };
}

function featureName(data: any, i: number): string {
  const p = data.features[i]?.properties ?? {};
  const name = p.room_name ?? p.name ?? null;
  const id = p.id ?? p.room_id ?? null;
  return [name, id !== null && id !== undefined ? `#${id}` : null].filter(Boolean).join(" ") || `Feature ${i + 1}`;
}

/** QGIS-style layout (one feature per line), keeping the file's own line endings. */
function serialize(doc: Doc): string {
  const head = Object.entries(doc.data)
    .filter(([key]) => key !== "features")
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  return ["{", ...head, '"features": [', doc.data.features.map((f: unknown) => JSON.stringify(f)).join("," + doc.eol), "]", "}", ""].join(doc.eol);
}

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

export function setupGeojsonEditor(container: HTMLElement, map: maplibregl.Map, layer: ModelLayer, hooks: GeojsonEditorHooks) {
  const docs = new Map<string, Doc>();
  const groups = new Map<string, THREE.Group>();
  const dot = dotTexture();
  let doc: Doc | null = null;
  let active = false;
  let selected: { handle: number | null; feature: number | null } = { handle: null, feature: null };
  let mode: "corner" | "shape" | "all" = "corner";
  let drag: { start: THREE.Vector3; moving: { handle: number; from: THREE.Vector2 }[]; snapshot: string; moved: boolean } | null = null;
  let swallowClick = false;

  // --- Panel
  container.innerHTML = `
    <select class="geo-file"></select>
    <div class="readout geo-readout"></div>
    <select class="geo-feature"></select>
    <div class="section"><strong>Adjust</strong><label>Step <select class="geo-step"></select></label></div>
    <div class="segmented geo-mode">
      <button type="button" data-mode="corner" title="Move the selected corner">Corner</button>
      <button type="button" data-mode="shape" title="Move the selected shape / point">Whole shape</button>
      <button type="button" data-mode="all" title="Move every feature in this file">All features</button>
    </div>
    <label class="geo-linked"><input type="checkbox" class="geo-shared" checked /> Move shared corners together</label>
    <div class="pad geo-pad"></div>
    <div class="actions">
      <button type="button" class="primary geo-save">💾 Save</button>
      <button type="button" class="geo-undo" title="Ctrl+Z">↶ Undo</button>
      <button type="button" class="geo-revert" title="Discard unsaved edits to this file">Revert</button>
    </div>
    <div class="debug-status geo-status"></div>
    <p class="geo-hint">Drag a corner on the map. Arrow keys nudge the selection, Page Up / Down raise or lower the whole file, Ctrl+Z undoes, Esc deselects.</p>`;
  const $ = <T extends HTMLElement>(selector: string) => container.querySelector(selector) as T;
  const fileSelect = $<HTMLSelectElement>(".geo-file");
  const featureSelect = $<HTMLSelectElement>(".geo-feature");
  const stepSelect = $<HTMLSelectElement>(".geo-step");
  const shared = $<HTMLInputElement>(".geo-shared");
  const readout = $<HTMLElement>(".geo-readout");
  const status = $<HTMLElement>(".geo-status");
  const saveButton = $<HTMLButtonElement>(".geo-save");
  for (const f of FILES) fileSelect.appendChild(new Option(f.label, f.file));
  for (const step of STEPS) stepSelect.appendChild(new Option(`${step} m`, String(step), false, step === 0.05));
  const pad = $<HTMLElement>(".geo-pad");
  for (const [label, area, dx, dy] of [["▲ N", "n", 0, 1], ["◀ W", "w", -1, 0], ["E ▶", "e", 1, 0], ["▼ S", "s", 0, -1]] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.gridArea = area;
    b.addEventListener("click", () => nudge(dx, dy));
    pad.appendChild(b);
  }
  // Height has no per-feature value in GeoJSON: Up / Down raise or lower the whole file.
  for (const [label, area, sign, title] of [["Up ⤒", "u", 1, "Raise every feature in this file (Page Up)"], ["Down ⤓", "d", -1, "Lower every feature in this file (Page Down)"]] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.style.gridArea = area;
    b.addEventListener("click", () => raise(sign));
    pad.appendChild(b);
  }
  container.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      mode = b.dataset.mode as typeof mode;
      updatePanel();
    })
  );

  // --- Data
  const enuOf = (h: Handle) => lonLatToEnu(h.targets[0][0], h.targets[0][1]);
  const overlayId = (d: Doc) => `geojson-edit:${d.meta.file}`;
  /** Height the file's handles are drawn and dragged at, above its floor (lift + the file's height offset). */
  const zOf = (d: Doc) => LIFT + geojsonHeight(d.data);

  function setEnu(d: Doc, h: Handle, x: number, y: number): void {
    const [lon, lat] = enuToLonLat(x, y).map((v) => Number(v.toFixed(DECIMALS)));
    for (const t of h.targets) {
      t[0] = lon;
      t[1] = lat;
    }
    // Point files repeat their position in the properties; keep those in step.
    const feature = d.data.features[h.feature];
    if (feature.geometry.type !== "Point") return;
    for (const key of Object.keys(feature.properties ?? {})) {
      if (/^lat(itude)?$/i.test(key)) feature.properties[key] = typeof feature.properties[key] === "string" ? String(lat) : lat;
      else if (/^(lon|long|lng|longitude)$/i.test(key)) feature.properties[key] = typeof feature.properties[key] === "string" ? String(lon) : lon;
    }
  }

  async function load(meta: EditFile): Promise<Doc> {
    const response = await fetch(`${import.meta.env.BASE_URL}data/${meta.file}?t=${Date.now()}`);
    if (!response.ok) throw new Error(`${meta.file}: ${response.status}`);
    const text = await response.text();
    const data = JSON.parse(text);
    return { meta, data, eol: text.includes("\r\n") ? "\r\n" : "\n", ...index(data), dirty: false, undo: [] };
  }

  // --- Drawing
  function redraw(): void {
    for (const file of groups.keys()) layer.setOverlayVisible(`geojson-edit:${file}`, FILES.find((f) => f.file === file)!.altitude, active && doc?.meta.file === file);
    if (!doc || !active) return map.triggerRepaint();
    let group = groups.get(doc.meta.file);
    if (!group) {
      group = new THREE.Group();
      groups.set(doc.meta.file, group);
      layer.addOverlay(overlayId(doc), group, doc.meta.altitude);
      if (doc.meta.set) layer.addToSet(doc.meta.set, overlayId(doc));
      layer.setOverlayVisible(overlayId(doc), doc.meta.altitude, true);
    }
    for (const child of [...group.children]) {
      group.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
      ((child as THREE.Mesh).material as THREE.Material)?.dispose();
    }
    const z = zOf(doc);
    const at = (h: Handle) => {
      const p = enuOf(h);
      return new THREE.Vector3(p.x, p.y, z);
    };
    const add = (object: THREE.Object3D, order: number) => {
      object.renderOrder = order;
      object.frustumCulled = false;
      group!.add(object);
    };
    for (const outline of doc.outlines) {
      const points = outline.handles.map((i) => at(doc!.handles[i]));
      const material = new THREE.LineBasicMaterial({ color: outline.feature === selected.feature ? COLOR.selected : COLOR.outline, depthTest: false, transparent: true });
      add(outline.closed ? new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), material) : new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material), 998);
    }
    const dots = (indices: number[], size: number, color: (h: Handle) => number) => {
      if (!indices.length) return;
      const geometry = new THREE.BufferGeometry().setFromPoints(indices.map((i) => at(doc!.handles[i])));
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(indices.flatMap((i) => new THREE.Color(color(doc!.handles[i])).toArray()), 3));
      add(new THREE.Points(geometry, new THREE.PointsMaterial({ size, sizeAttenuation: false, map: dot, vertexColors: true, transparent: true, alphaTest: 0.4, depthTest: false })), 999);
    };
    const all = doc.handles.map((_, i) => i).filter((i) => i !== selected.handle);
    dots(all, 10, (h) => (h.feature === selected.feature ? COLOR.selected : h.corners === 1 ? COLOR.point : COLOR.corner));
    if (selected.handle !== null) dots([selected.handle], 16, () => COLOR.active);
    map.triggerRepaint();
  }

  // --- Panel state
  function updatePanel(): void {
    container.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    for (const option of fileSelect.options) {
      const label = FILES.find((f) => f.file === option.value)!.label;
      option.textContent = label + (docs.get(option.value)?.dirty ? " *" : "");
    }
    saveButton.disabled = !doc?.dirty;
    saveButton.textContent = doc?.dirty ? "💾 Save" : "💾 Saved";
    $<HTMLButtonElement>(".geo-undo").disabled = !doc?.undo.length;
    if (!doc) return;
    featureSelect.value = selected.feature === null ? "" : String(selected.feature);
    const height = geojsonHeight(doc.data);
    const heightLine = `\nFile height ${height >= 0 ? "+" : ""}${height.toFixed(2)} m`;
    if (mode === "all") {
      readout.textContent = `All ${doc.data.features.length} features (${doc.handles.length} corners/points)\nNudge or drag moves them all.` + heightLine;
    } else if (selected.handle !== null) {
      const h = doc.handles[selected.handle];
      const p = enuOf(h);
      const sharedCount = movingHandles(selected.handle, "corner").length - 1;
      readout.textContent =
        `${featureName(doc.data, h.feature)} · ${h.corners > 1 ? `corner ${h.corner} of ${h.corners}` : "point"}${sharedCount ? ` (+${sharedCount} shared)` : ""}\n` +
        `E ${p.x.toFixed(3)}  N ${p.y.toFixed(3)} m\n${h.targets[0][0].toFixed(9)}, ${h.targets[0][1].toFixed(9)}` +
        heightLine;
    } else if (selected.feature !== null) {
      readout.textContent = `${featureName(doc.data, selected.feature)}\n${mode === "shape" ? "Nudge moves the whole shape." : "Pick a corner on the map."}` + heightLine;
    } else {
      readout.textContent = `${doc.data.features.length} features, ${doc.handles.length} corners/points\nPick a corner on the map.` + heightLine;
    }
  }

  function select(handle: number | null, feature: number | null): void {
    selected = { handle, feature: handle !== null ? doc!.handles[handle].feature : feature };
    redraw();
    updatePanel();
  }

  async function openFile(file: string): Promise<void> {
    const meta = FILES.find((f) => f.file === file)!;
    status.textContent = "Loading…";
    try {
      if (!docs.has(file)) docs.set(file, await load(meta));
    } catch (error) {
      status.textContent = `Could not load ${file}: ${error instanceof Error ? error.message : error}`;
      return;
    }
    doc = docs.get(file)!;
    status.textContent = "";
    selected = { handle: null, feature: null };
    featureSelect.replaceChildren(new Option(`All features (${doc.data.features.length})`, ""));
    doc.data.features.forEach((_: unknown, i: number) => featureSelect.appendChild(new Option(featureName(doc!.data, i), String(i))));
    if (active) hooks.showFloor(meta.preset);
    redraw();
    updatePanel();
  }

  // --- Editing
  /** The selected corner plus corners sharing its position, the whole feature, or every feature. */
  function movingHandles(handle: number, how = mode): number[] {
    const d = doc!;
    const h = d.handles[handle];
    if (how === "all") return d.handles.map((_, i) => i);
    if (how === "shape") return d.handles.map((_, i) => i).filter((i) => d.handles[i].feature === h.feature);
    if (!shared.checked) return [handle];
    const p = enuOf(h);
    return d.handles.map((_, i) => i).filter((i) => i === handle || enuOf(d.handles[i]).distanceTo(p) < SHARED_TOLERANCE_M);
  }

  function changed(snapshot: string): void {
    doc!.undo.push(snapshot);
    doc!.dirty = true;
    status.textContent = "";
    redraw();
    updatePanel();
  }

  function nudge(dx: number, dy: number): void {
    if (!doc) return;
    const step = Number(stepSelect.value);
    let ids: number[];
    if (mode === "all") ids = doc.handles.map((_, i) => i);
    else if (selected.handle !== null) ids = movingHandles(selected.handle);
    else if (mode === "shape" && selected.feature !== null) ids = doc.handles.map((_, i) => i).filter((i) => doc!.handles[i].feature === selected.feature);
    else return;
    const snapshot = JSON.stringify(doc.data);
    for (const i of ids) {
      const p = enuOf(doc.handles[i]);
      setEnu(doc, doc.handles[i], p.x + dx * step, p.y + dy * step);
    }
    changed(snapshot);
  }

  /** Raise (+1) or lower (−1) the whole file by one step; stored as its top-level height offset. */
  function raise(sign: 1 | -1): void {
    if (!doc) return;
    const snapshot = JSON.stringify(doc.data);
    const height = Math.round((geojsonHeight(doc.data) + sign * Number(stepSelect.value)) * 1000) / 1000;
    if (height === 0) delete doc.data[GEOJSON_HEIGHT_KEY];
    else doc.data[GEOJSON_HEIGHT_KEY] = height;
    changed(snapshot);
  }

  function undo(): void {
    if (!doc?.undo.length) return;
    doc.data = JSON.parse(doc.undo.pop()!);
    Object.assign(doc, index(doc.data));
    doc.dirty = true;
    redraw();
    updatePanel();
  }

  async function save(): Promise<void> {
    if (!doc) return;
    if (!import.meta.env.DEV) {
      status.textContent = "Save only works with the dev server (npm run dev).";
      return;
    }
    status.textContent = "Saving…";
    try {
      const response = await fetch(`/__save-geojson?file=${encodeURIComponent(doc.meta.file)}`, { method: "POST", body: serialize(doc) });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    } catch (error) {
      status.textContent = `Save failed: ${error instanceof Error ? error.message : error}`;
      return;
    }
    doc.dirty = false;
    updatePanel();
    status.innerHTML = `Saved public/data/${doc.meta.file}. <button type="button" class="geo-reload">Reload page</button> to use it in rooms &amp; navigation.`;
    status.querySelector(".geo-reload")!.addEventListener("click", () => location.reload());
  }

  async function revert(): Promise<void> {
    if (!doc) return;
    if (doc.dirty && !confirm(`Discard unsaved edits to ${doc.meta.file}?`)) return;
    docs.delete(doc.meta.file);
    await openFile(doc.meta.file);
  }

  // --- Map interaction (only while the GeoJSON tab is open)
  const canvasPoint = (e: MouseEvent) => {
    const rect = map.getCanvas().getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /** Where a screen point lands on the edited file's floor plane, in its raw ENU metres. */
  function floorPoint(p: { x: number; y: number }): THREE.Vector3 | null {
    if (!doc) return null;
    const ray = layer.screenRay(p.x, p.y);
    const matrix = layer.overlayMatrix(overlayId(doc), doc.meta.altitude);
    if (!ray || !matrix) return null;
    return ray.applyMatrix4(matrix.invert()).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -zOf(doc)), new THREE.Vector3());
  }

  function hitTest(p: { x: number; y: number }): number | null {
    if (!doc) return null;
    const matrix = layer.overlayMatrix(overlayId(doc), doc.meta.altitude);
    if (!matrix) return null;
    let best: number | null = null;
    let bestDistance = HIT_RADIUS_PX;
    const z = zOf(doc);
    doc.handles.forEach((h, i) => {
      const e = enuOf(h);
      const screen = layer.projectToScreen(new THREE.Vector3(e.x, e.y, z).applyMatrix4(matrix));
      if (!screen) return;
      // Prefer corners of the selected shape when corners overlap.
      const distance = Math.hypot(screen.x - p.x, screen.y - p.y) - (h.feature === selected.feature ? 3 : 0);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    return best;
  }

  const canvasContainer = map.getCanvasContainer();
  canvasContainer.addEventListener(
    "mousedown",
    (e) => {
      if (!active || !doc || e.button !== 0) return;
      const p = canvasPoint(e);
      const hit = hitTest(p);
      if (hit === null) return;
      // Ours: keep the map from panning and the room popups from opening.
      e.stopPropagation();
      e.preventDefault();
      swallowClick = true;
      select(hit, null);
      const start = floorPoint(p);
      if (!start) return;
      drag = { start, moving: movingHandles(hit).map((i) => ({ handle: i, from: enuOf(doc!.handles[i]) })), snapshot: JSON.stringify(doc.data), moved: false };
    },
    true
  );
  canvasContainer.addEventListener(
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
    if (!active || !doc) return;
    const p = canvasPoint(e);
    if (!drag) {
      if (e.target instanceof Node && canvasContainer.contains(e.target)) map.getCanvas().style.cursor = hitTest(p) !== null ? "move" : "";
      return;
    }
    const now = floorPoint(p);
    if (!now) return;
    const dx = now.x - drag.start.x;
    const dy = now.y - drag.start.y;
    for (const { handle, from } of drag.moving) setEnu(doc, doc.handles[handle], from.x + dx, from.y + dy);
    drag.moved = true;
    redraw();
    updatePanel();
  });
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    if (drag.moved) changed(drag.snapshot);
    drag = null;
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (!active || !doc || e.altKey || e.metaKey) return;
      if ((e.target as HTMLElement).closest("input, select, textarea")) return;
      const arrows: Record<string, [number, number]> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
      if (e.ctrlKey && e.key.toLowerCase() === "z") undo();
      else if (!e.ctrlKey && arrows[e.key]) nudge(...arrows[e.key]);
      else if (!e.ctrlKey && (e.key === "PageUp" || e.key === "PageDown")) raise(e.key === "PageUp" ? 1 : -1);
      else if (e.key === "Escape") select(null, null);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation(); // don't also pan / rotate the map
    },
    true
  );
  window.addEventListener("beforeunload", (e) => {
    if ([...docs.values()].some((d) => d.dirty)) e.preventDefault();
  });

  fileSelect.addEventListener("change", () => void openFile(fileSelect.value));
  featureSelect.addEventListener("change", () => {
    if (!doc) return;
    const feature = featureSelect.value === "" ? null : Number(featureSelect.value);
    select(null, feature);
    // Bring the shape into view.
    const matrix = layer.overlayMatrix(overlayId(doc), doc.meta.altitude);
    const ids = doc.handles.map((_, i) => i).filter((i) => feature === null || doc!.handles[i].feature === feature);
    if (!matrix || !ids.length) return;
    const z = zOf(doc);
    const centre = ids.reduce((sum, i) => sum.add(new THREE.Vector3(enuOf(doc!.handles[i]).x, enuOf(doc!.handles[i]).y, z)), new THREE.Vector3()).divideScalar(ids.length);
    map.easeTo({ center: layer.toLngLat(centre.applyMatrix4(matrix)), zoom: Math.max(map.getZoom(), feature === null ? 19.5 : 20.5), duration: 600 });
  });
  saveButton.addEventListener("click", () => void save());
  $<HTMLButtonElement>(".geo-undo").addEventListener("click", undo);
  $<HTMLButtonElement>(".geo-revert").addEventListener("click", () => void revert());

  void openFile(FILES[0].file);

  return {
    /** Show the handles and take map clicks (the GeoJSON tab is open). */
    setActive(on: boolean): void {
      if (active === on) return;
      active = on;
      if (!on) map.getCanvas().style.cursor = "";
      if (on && doc) hooks.showFloor(doc.meta.preset);
      redraw();
    }
  };
}
