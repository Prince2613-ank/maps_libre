import { GROUPS } from "./catalog";
import type { ModelLayer } from "./modelLayer";
import { ADJUSTMENTS, NO_ADJUSTMENT, savedAdjustment, type Adjustment } from "./adjustments";

const DRAFT_KEY = "maplibre-indoor:layer-adjustments";
const MOVE_STEPS = [0.01, 0.05, 0.1, 0.5, 1, 5];
const TURN_STEPS = [0.1, 0.5, 1, 5, 15, 45, 90];
const SCALE_STEP = 0.01;

type Field = { key: keyof Adjustment; label: string; step: number };

const FIELDS: Field[] = [
  { key: "east", label: "East (m)", step: 0.01 },
  { key: "north", label: "North (m)", step: 0.01 },
  { key: "up", label: "Up (m)", step: 0.01 },
  { key: "yaw", label: "Yaw (°)", step: 0.1 },
  { key: "pitch", label: "Tilt (°)", step: 0.1 },
  { key: "roll", label: "Roll (°)", step: 0.1 },
  { key: "scale", label: "Scale ×", step: 0.001 }
];

// One button: which field it changes, which way, and by which step ("move", "turn" or "scale").
type Nudge = { label: string; title: string; key: keyof Adjustment; sign: 1 | -1; step: "move" | "turn" | "scale"; keys?: string[] };

const MOVES: (Nudge & { area: string })[] = [
  { label: "▲ N", title: "North (↑)", key: "north", sign: 1, step: "move", area: "n", keys: ["ArrowUp"] },
  { label: "◀ W", title: "West (←)", key: "east", sign: -1, step: "move", area: "w", keys: ["ArrowLeft"] },
  { label: "E ▶", title: "East (→)", key: "east", sign: 1, step: "move", area: "e", keys: ["ArrowRight"] },
  { label: "▼ S", title: "South (↓)", key: "north", sign: -1, step: "move", area: "s", keys: ["ArrowDown"] },
  { label: "Up ⤒", title: "Up (Page Up)", key: "up", sign: 1, step: "move", area: "u", keys: ["PageUp"] },
  { label: "Down ⤓", title: "Down (Page Down)", key: "up", sign: -1, step: "move", area: "d", keys: ["PageDown"] }
];

const TURNS: Nudge[] = [
  { label: "⟲ Left", title: "Turn left / anticlockwise seen from above ([)", key: "yaw", sign: 1, step: "turn", keys: ["["] },
  { label: "⟳ Right", title: "Turn right / clockwise seen from above (])", key: "yaw", sign: -1, step: "turn", keys: ["]"] },
  { label: "Tilt +", title: "Tilt around the east-west axis", key: "pitch", sign: 1, step: "turn" },
  { label: "Tilt −", title: "Tilt around the east-west axis", key: "pitch", sign: -1, step: "turn" },
  { label: "Roll +", title: "Roll around the north-south axis", key: "roll", sign: 1, step: "turn" },
  { label: "Roll −", title: "Roll around the north-south axis", key: "roll", sign: -1, step: "turn" },
  { label: "Bigger", title: "Scale up 1%", key: "scale", sign: 1, step: "scale" },
  { label: "Smaller", title: "Scale down 1%", key: "scale", sign: -1, step: "scale" }
];

const round = (value: number) => Math.round(value * 1000) / 1000;
const same = (a: Adjustment, b: Adjustment) => FIELDS.every(({ key }) => a[key] === b[key]);

function loadDraft(): Record<string, Adjustment> {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function storeDraft(adjustments: Map<string, Adjustment> | null): void {
  try {
    if (adjustments) localStorage.setItem(DRAFT_KEY, JSON.stringify(Object.fromEntries(adjustments)));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage blocked (private window etc.): edits still apply until the page closes.
  }
}

/** Only the fields that differ from no adjustment, for src/adjustments.json. */
function toSaved(adjustments: Map<string, Adjustment>): Record<string, Partial<Adjustment>> {
  const out: Record<string, Partial<Adjustment>> = {};
  for (const [id, adj] of adjustments) {
    const changed: Partial<Adjustment> = {};
    for (const { key } of FIELDS) if (adj[key] !== NO_ADJUSTMENT[key]) changed[key] = round(adj[key]);
    if (Object.keys(changed).length) out[id] = changed;
  }
  return out;
}

function stepSelect(steps: number[], unit: string, initial: number): HTMLSelectElement {
  const select = document.createElement("select");
  for (const step of steps) select.appendChild(new Option(`${step} ${unit}`, String(step), false, step === initial));
  return select;
}

/**
 * Debug panel: move, rotate and scale each panel layer (Building exterior, Ground, 1st, 2nd, 3rd) as one piece,
 * then Save to src/adjustments.json through the dev server. Unsaved edits are kept in this browser as a draft.
 * Opened with the "Debug" button or by loading the page with ?debug.
 */
export function setupDebugPanel(layer: ModelLayer, toggle: HTMLButtonElement): void {
  const layerFiles = new Map(GROUPS.map((g) => [g.id, g.models.map((m) => m.file)]));
  for (const group of GROUPS) layer.defineSet(group.id, layerFiles.get(group.id)!, group.models[0].file);

  const adjustments = new Map<string, Adjustment>();
  for (const id of Object.keys(ADJUSTMENTS)) adjustments.set(id, savedAdjustment(id));
  for (const [id, adj] of Object.entries(loadDraft())) if (layerFiles.has(id)) adjustments.set(id, { ...NO_ADJUSTMENT, ...adj });
  for (const [id, adj] of adjustments) layer.setSetAdjustment(id, adj);

  const panel = document.createElement("div");
  panel.id = "debug";
  panel.hidden = true;
  panel.innerHTML = `<h2>Adjust layer</h2>`;

  const select = document.createElement("select");
  for (const group of GROUPS) {
    const option = new Option(group.label, group.id);
    option.dataset.label = group.label;
    select.appendChild(option);
  }

  const readout = document.createElement("div");
  readout.className = "readout";

  const section = (title: string, step: HTMLSelectElement) => {
    const row = document.createElement("div");
    row.className = "section";
    const label = document.createElement("label");
    label.append("Step ", step);
    row.append(Object.assign(document.createElement("strong"), { textContent: title }), label);
    return row;
  };
  const nudgeButton = (nudge: Nudge) => {
    const b = document.createElement("button");
    b.textContent = nudge.label;
    b.title = nudge.title;
    b.addEventListener("click", () => applyNudge(nudge));
    return b;
  };

  // --- Move
  const moveStep = stepSelect(MOVE_STEPS, "m", 0.1);
  const pad = document.createElement("div");
  pad.className = "pad";
  for (const move of MOVES) {
    const b = nudgeButton(move);
    b.style.gridArea = move.area;
    pad.appendChild(b);
  }

  // --- Rotate / scale
  const turnStep = stepSelect(TURN_STEPS, "°", 1);
  const turns = document.createElement("div");
  turns.className = "turns";
  for (const turn of TURNS) turns.appendChild(nudgeButton(turn));

  // --- Exact values
  const fine = document.createElement("details");
  fine.innerHTML = "<summary>Exact values</summary>";
  const inputs = new Map<keyof Adjustment, HTMLInputElement>();
  const grid = document.createElement("div");
  grid.className = "fields";
  for (const field of FIELDS) {
    const label = document.createElement("label");
    label.textContent = field.label;
    const input = document.createElement("input");
    input.type = "number";
    input.step = String(field.step);
    input.addEventListener("input", () => {
      const value = Number(input.value);
      if (input.value === "" || !Number.isFinite(value)) return;
      apply({ ...current(), [field.key]: value }, false);
    });
    grid.append(label, input);
    inputs.set(field.key, input);
  }
  fine.appendChild(grid);

  // --- Actions
  const actions = document.createElement("div");
  actions.className = "actions";
  const button = (text: string, title: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", onClick);
    actions.appendChild(b);
    return b;
  };
  const saveButton = button("💾 Save", "Write all layers to src/adjustments.json (Shift+S)", () => void save());
  saveButton.classList.add("primary");
  button("Reset layer", "Put this layer back to its last saved position", () => apply(savedAdjustment(select.value)));
  button("Discard unsaved", "Drop every unsaved edit and go back to src/adjustments.json", () => {
    if (!confirm("Discard all unsaved layer adjustments?")) return;
    adjustments.clear();
    for (const id of layerFiles.keys()) {
      if (id in ADJUSTMENTS) adjustments.set(id, savedAdjustment(id));
      layer.setSetAdjustment(id, savedAdjustment(id));
    }
    storeDraft(null);
    refresh();
  });

  const status = document.createElement("div");
  status.className = "debug-status";

  panel.append(select, readout, section("Move", moveStep), pad, section("Rotate / scale", turnStep), turns, fine, actions, status);
  document.body.appendChild(panel);

  const adjustmentOf = (id: string) => adjustments.get(id) ?? savedAdjustment(id);
  const current = () => adjustmentOf(select.value);

  function applyNudge(nudge: Nudge): void {
    const step = nudge.step === "move" ? Number(moveStep.value) : nudge.step === "turn" ? Number(turnStep.value) : SCALE_STEP;
    const adj = current();
    let value = round(adj[nudge.key] + nudge.sign * step);
    if (nudge.key === "scale") value = Math.max(0.01, value);
    else if (nudge.step === "turn") value = round(((((value + 180) % 360) + 360) % 360) - 180); // keep within -180..180
    apply({ ...adj, [nudge.key]: value });
  }

  function apply(adj: Adjustment, updateInputs = true): void {
    adjustments.set(select.value, adj);
    layer.setSetAdjustment(select.value, adj);
    storeDraft(adjustments);
    if (updateInputs) refresh();
    else updateState();
  }

  const unsavedLayers = () => [...layerFiles.keys()].filter((id) => !same(adjustmentOf(id), savedAdjustment(id)));

  async function save(): Promise<void> {
    if (!import.meta.env.DEV) {
      status.textContent = "Save only works with the dev server (npm run dev).";
      return;
    }
    const data = toSaved(adjustments);
    status.textContent = "Saving…";
    try {
      const response = await fetch("/__save-adjustments", { method: "POST", body: JSON.stringify(data) });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    } catch (error) {
      status.textContent = `Save failed: ${error instanceof Error ? error.message : error}`;
      return;
    }
    for (const id of Object.keys(ADJUSTMENTS)) delete ADJUSTMENTS[id];
    Object.assign(ADJUSTMENTS, data);
    storeDraft(null);
    updateState();
    status.textContent = `Saved to src/adjustments.json`;
  }

  // Readout, "*" on layers with unsaved edits, Save button state.
  function updateState(): void {
    const a = current();
    readout.textContent =
      `E ${a.east.toFixed(2)}  N ${a.north.toFixed(2)}  Up ${a.up.toFixed(2)} m\n` +
      `Yaw ${a.yaw}°  Tilt ${a.pitch}°  Roll ${a.roll}°  ×${a.scale}`;
    const unsaved = new Set(unsavedLayers());
    for (const option of select.options) option.textContent = option.dataset.label + (unsaved.has(option.value) ? " *" : "");
    saveButton.disabled = unsaved.size === 0;
    saveButton.textContent = unsaved.size ? `💾 Save (${unsaved.size})` : "💾 Saved";
    if (unsaved.size) status.textContent = "";
  }

  function refresh(): void {
    const adj = current();
    for (const [key, input] of inputs) input.value = String(adj[key]);
    updateState();
    layer.setHighlight(panel.hidden ? [] : layerFiles.get(select.value)!);
  }

  select.addEventListener("change", refresh);

  // Keyboard while the panel is open: arrows / Page Up / Page Down move, [ ] turn, Shift+S saves.
  window.addEventListener(
    "keydown",
    (event) => {
      if (panel.hidden || event.ctrlKey || event.altKey || event.metaKey) return;
      if ((event.target as HTMLElement).closest("input, select, textarea")) return;
      if (event.key === "S" && event.shiftKey) {
        event.preventDefault();
        void save();
        return;
      }
      const nudge = [...MOVES, ...TURNS].find((n) => n.keys?.includes(event.key));
      if (!nudge) return;
      event.preventDefault();
      event.stopImmediatePropagation(); // don't also pan / rotate the map
      applyNudge(nudge);
    },
    true
  );

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    toggle.classList.toggle("active", open);
    refresh();
  }
  toggle.addEventListener("click", () => setOpen(panel.hidden === true));
  setOpen(new URLSearchParams(location.search).has("debug"));
}
