// Outdoor routing to the building, ported from the Cesium app (cesium_demo/src/ui.ts + buildingPOI.ts):
// - places: "lat,lng", a few known places, then Nominatim, then Photon (same queries and scoring)
// - streets: OSRM (walking via FOSSGIS' foot router, driving via the OSRM demo server; each falls back to the other)
// - last stretch: the surveyed footpath points (Outdoor_navigation_points.geojson) from where the street route
//   lands to the building entrance, spliced onto the street route exactly like appendOutdoorModelApproach.

import { geojsonHeight } from "./placement";

export type LonLat = { lon: number; lat: number };
export type TravelMode = "walk" | "drive";

/** Where the outdoor route ends and indoor navigation takes over (cesium_demo/src/buildingPOI.ts). */
export const BUILDING_ENTRANCE: LonLat = { lon: 77.1337021703, lat: 28.6709007799 };

const KNOWN_PLACES: Record<string, LonLat & { label: string }> = {
  "punjabi bagh west metro station": { label: "Punjabi Bagh West Metro Station", lat: 28.6730178, lon: 77.1373636 },
  "shadipur metro station": { label: "Shadipur Metro Station", lat: 28.6518, lon: 77.1482 }
};
// Aliases the Cesium app accepts for the same places.
const KNOWN_ALIASES: Record<string, string> = {
  "punjabi bagh west metro": "punjabi bagh west metro station",
  "punjabi bagh west": "punjabi bagh west metro station",
  shadipur: "shadipur metro station",
  "shadipur metro": "shadipur metro station",
  "shadipur metro station new delhi": "shadipur metro station"
};

/** Suggestions offered before the user types anything. */
export const SUGGESTED_PLACES = Object.values(KNOWN_PLACES).map((p) => p.label);

const LINK_MAX_METERS = 8; // consecutive survey points closer than this are connected
const JOIN_MAX_METERS = 5; // any two survey points closer than this are connected

// --- Geometry

export function distanceMeters(a: LonLat, b: LonLat): number {
  const r = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathMeters(path: LonLat[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distanceMeters(path[i - 1], path[i]);
  return total;
}

/** Evenly spaced points along a path. */
export function samplePath(path: LonLat[], spacing: number): LonLat[] {
  if (path.length < 2) return [...path];
  const out = [path[0]];
  let carry = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = distanceMeters(a, b);
    if (len < 0.001) continue;
    let d = spacing - carry;
    while (d < len) {
      const t = d / len;
      out.push({ lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t });
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  out.push(path[path.length - 1]);
  return out;
}

// --- Places

const normalizeText = (value: string) => value.toLowerCase().replace(/[,\s]+/g, " ").trim();
const looksIndian = (normalized: string) =>
  /metro|station|chowk|nagar|vihar|bagh|marg|delhi|mumbai|india|mandi|bazar|enclave|puri|kunj|puram/.test(normalized);

function parseCoordinates(value: string): LonLat | null {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (Math.abs(first) <= 90 && Math.abs(second) <= 180) return { lat: first, lon: second };
  if (Math.abs(first) <= 180 && Math.abs(second) <= 90) return { lon: first, lat: second };
  return null;
}

function searchQueries(input: string): string[] {
  const cleaned = input.trim();
  const normalized = normalizeText(cleaned);
  const queries = [cleaned];
  if (looksIndian(normalized) && !normalized.includes("india")) queries.push(`${cleaned}, India`);
  if (normalized.includes("metro") && !normalized.includes("delhi")) queries.push(`${cleaned}, Delhi`);
  return [...new Set(queries)];
}

type Candidate = LonLat & { label: string; kind: string; importance?: number };

function score(query: string, c: Candidate): number {
  const tokens = normalizeText(query).split(" ").filter(Boolean);
  const label = normalizeText(c.label);
  const kind = normalizeText(c.kind);
  let s = c.importance ?? 0;
  for (const t of tokens) {
    if (label.includes(t)) s += 2.5;
    if (kind.includes(t)) s += 1.25;
  }
  if (label.startsWith(normalizeText(query))) s += 4;
  if ((tokens.includes("metro") || tokens.includes("station")) && /station|subway|railway|halt|stop|transit|platform/.test(`${label} ${kind}`)) s += 8;
  if (tokens.includes("airport") && /airport|aerodrome/.test(`${label} ${kind}`)) s += 5;
  if (c.lat >= 20 && c.lat <= 37 && c.lon >= 68 && c.lon <= 97 && looksIndian(normalizeText(query))) s += 3;
  return s;
}

const best = (query: string, candidates: Candidate[]) =>
  candidates.length ? candidates.map((c) => ({ c, s: score(query, c) })).sort((a, b) => b.s - a.s)[0].c : null;

/** Box of about ±1° around the building: results inside it are preferred (or required, when `local`). */
const NEARBY_VIEWBOX = [BUILDING_ENTRANCE.lon - 1, BUILDING_ENTRANCE.lat + 1, BUILDING_ENTRANCE.lon + 1, BUILDING_ENTRANCE.lat - 1].join(",");

async function nominatim(query: string, limit = 10, local = false): Promise<Candidate[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({ format: "jsonv2", limit: String(limit), addressdetails: "1", "accept-language": "en", q: query, viewbox: NEARBY_VIEWBOX, bounded: local ? "1" : "0" }).toString();
  if (looksIndian(normalizeText(query))) url.searchParams.set("countrycodes", "in");
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return [];
    const results = (await response.json()) as { lat: string; lon: string; display_name?: string; class?: string; type?: string; importance?: number }[];
    return results
      .map((r) => ({ lat: Number(r.lat), lon: Number(r.lon), label: r.display_name ?? "", kind: `${r.class ?? ""} ${r.type ?? ""}`, importance: r.importance }))
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  } catch {
    return [];
  }
}

async function photon(query: string): Promise<Candidate[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.search = new URLSearchParams({ limit: "10", q: query, lang: "en" }).toString();
  if (looksIndian(normalizeText(query))) {
    url.searchParams.set("lat", "28.6448");
    url.searchParams.set("lon", "77.2167");
  }
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return [];
    const data = (await response.json()) as { features?: { geometry?: { coordinates?: [number, number] }; properties?: Record<string, string> }[] };
    return (data.features ?? []).flatMap((f) => {
      const [lon, lat] = f.geometry?.coordinates ?? [NaN, NaN];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const p = f.properties ?? {};
      return [{ lat, lon, label: [p.name, p.city, p.state, p.country].filter(Boolean).join(", "), kind: `${p.osm_value ?? ""} ${p.type ?? ""}` }];
    });
  } catch {
    return [];
  }
}

/** Resolve what the user typed into a point (null if nothing was found). */
export async function resolvePlace(input: string): Promise<LonLat | null> {
  const value = input.trim();
  if (!value) return null;
  const coordinates = parseCoordinates(value);
  if (coordinates) return coordinates;
  const key = normalizeText(value);
  const known = KNOWN_PLACES[KNOWN_ALIASES[key] ?? key];
  if (known) return known;
  for (const query of searchQueries(value)) {
    const found = best(query, await nominatim(query));
    if (found) return found;
  }
  for (const query of searchQueries(value)) {
    const found = best(query, await photon(query));
    if (found) return found;
  }
  return null;
}

/** Place name suggestions while typing: known places, then nearby Nominatim results (within ~100 km). */
export async function suggestPlaces(input: string): Promise<string[]> {
  const key = normalizeText(input);
  const known = SUGGESTED_PLACES.filter((label) => normalizeText(label).includes(key));
  if (key.length < 3 || parseCoordinates(input)) return known;
  let found: Candidate[] = [];
  for (const query of searchQueries(input)) {
    found = await nominatim(query, 5, true);
    if (found.length) break;
  }
  // Photon knows some places (e.g. metro stations) Nominatim can't match by name; keep only nearby ones.
  if (!found.length) found = (await photon(searchQueries(input)[0])).filter((c) => distanceMeters(c, BUILDING_ENTRANCE) < 100_000).slice(0, 5);
  return [...new Set([...known, ...found.map((c) => c.label)])].slice(0, 8);
}

// --- Street route (OSRM)

export type OutdoorStep = { icon: string; text: string; meters: number; location: LonLat };

export type OutdoorRoute = {
  points: LonLat[];
  meters: number;
  seconds: number;
  steps: OutdoorStep[];
  /** Index in `points` where the surveyed footpath to the entrance begins (the walk near the building). */
  approachStart: number;
  /** False when no street route was found and the line is a straight fallback. */
  routed: boolean;
};

const ROUTERS: Record<TravelMode, string> = {
  walk: "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
  drive: "https://router.project-osrm.org/route/v1/driving"
};

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const ICONS: Record<string, string> = {
  left: "↰", "slight left": "↖", "sharp left": "↰", right: "↱", "slight right": "↗", "sharp right": "↱", straight: "↑", uturn: "⤺"
};

function stepText(step: any): { icon: string; text: string } {
  const m = step.maneuver ?? {};
  const name = step.name ? ` onto ${step.name}` : "";
  const modifier: string = m.modifier ?? "straight";
  switch (m.type) {
    case "depart":
      return { icon: "↑", text: `Head ${COMPASS[Math.round(((m.bearing_after ?? 0) % 360) / 45) % 8]}${step.name ? ` on ${step.name}` : ""}` };
    case "arrive":
      return { icon: "🏁", text: "Arrive near the building" };
    case "roundabout":
    case "rotary":
      return { icon: "⟳", text: `At the roundabout, take exit ${m.exit ?? 1}${name}` };
    case "continue":
    case "new name":
      return { icon: ICONS[modifier] ?? "↑", text: modifier === "straight" ? `Continue${name || " straight"}` : `Keep ${modifier}${name}` };
    case "merge":
      return { icon: ICONS[modifier] ?? "↑", text: `Merge ${modifier}${name}` };
    case "fork":
      return { icon: ICONS[modifier] ?? "↑", text: `Keep ${modifier} at the fork${name}` };
    case "end of road":
      return { icon: ICONS[modifier] ?? "↑", text: `At the end of the road, turn ${modifier}${name}` };
    default:
      return { icon: ICONS[modifier] ?? "↑", text: modifier === "straight" ? `Go straight${name}` : modifier === "uturn" ? `Make a U-turn${name}` : `Turn ${modifier}${name}` };
  }
}

async function osrm(start: LonLat, end: LonLat, mode: TravelMode): Promise<Omit<OutdoorRoute, "approachStart"> | null> {
  const url = `${ROUTERS[mode]}/${start.lon},${start.lat};${end.lon},${end.lat}?overview=full&geometries=geojson&steps=true`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const route = (await response.json()).routes?.[0];
    const coordinates: [number, number][] = route?.geometry?.coordinates ?? [];
    if (coordinates.length < 2) return null;
    const steps = (route.legs?.[0]?.steps ?? []).map((s: any) => ({
      ...stepText(s),
      meters: s.distance ?? 0,
      location: { lon: s.maneuver.location[0], lat: s.maneuver.location[1] }
    }));
    return { points: coordinates.map(([lon, lat]) => ({ lon, lat })), meters: route.distance, seconds: route.duration, steps, routed: true };
  } catch (error) {
    console.warn(`Street routing (${mode}) failed`, error);
    return null;
  }
}

// --- Footpath to the entrance (surveyed points)

type Node = LonLat & { id: number; edges: { to: number; meters: number }[] };

export class OutdoorRouter {
  private nodes: Node[] | null = null;
  /** The points file's height offset in metres (Debug → GeoJSON → Up/Down); known once graph() has loaded. */
  heightOffset = 0;

  constructor(private readonly pointsUrl: string) {}

  /** The surveyed footpath graph (cesium_demo/src/ui.ts loadOutdoorNavigationGraph). */
  async graph(): Promise<Node[]> {
    if (this.nodes) return this.nodes;
    const response = await fetch(this.pointsUrl);
    if (!response.ok) throw new Error(`Outdoor navigation points: ${response.status}`);
    const data = await response.json();
    this.heightOffset = geojsonHeight(data);
    const nodes: Node[] = (data.features ?? [])
      .filter((f: any) => f.geometry?.type === "Point")
      .map((f: any, i: number) => ({ id: Number(f.properties?.id ?? i + 1), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], edges: [] }))
      .filter((n: Node) => Number.isFinite(n.lon) && Number.isFinite(n.lat))
      .sort((a: Node, b: Node) => a.id - b.id);
    const link = (a: number, b: number, max: number) => {
      const meters = distanceMeters(nodes[a], nodes[b]);
      if (meters > max) return;
      nodes[a].edges.push({ to: b, meters });
      nodes[b].edges.push({ to: a, meters });
    };
    for (let i = 0; i < nodes.length - 1; i++) link(i, i + 1, LINK_MAX_METERS);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 2; j < nodes.length; j++) link(i, j, JOIN_MAX_METERS);
    this.nodes = nodes;
    return nodes;
  }

  private nearest(nodes: Node[], p: LonLat): number {
    let bestIndex = 0;
    nodes.forEach((n, i) => {
      if (distanceMeters(n, p) < distanceMeters(nodes[bestIndex], p)) bestIndex = i;
    });
    return bestIndex;
  }

  private shortest(nodes: Node[], start: number, end: number): LonLat[] {
    const dist = nodes.map(() => Infinity);
    const prev = nodes.map(() => -1);
    const done = nodes.map(() => false);
    dist[start] = 0;
    for (;;) {
      let current = -1;
      for (let i = 0; i < nodes.length; i++) if (!done[i] && (current === -1 || dist[i] < dist[current])) current = i;
      if (current === -1 || dist[current] === Infinity || current === end) break;
      done[current] = true;
      for (const e of nodes[current].edges) {
        if (dist[current] + e.meters < dist[e.to]) {
          dist[e.to] = dist[current] + e.meters;
          prev[e.to] = current;
        }
      }
    }
    if (dist[end] === Infinity) return [];
    const path: LonLat[] = [];
    for (let i = end; i !== -1; i = prev[i]) {
      path.unshift({ lon: nodes[i].lon, lat: nodes[i].lat });
      if (i === start) break;
    }
    return path;
  }

  /** Route from anywhere to the building entrance: streets, then the surveyed footpath. */
  async routeToEntrance(start: LonLat, mode: TravelMode): Promise<OutdoorRoute> {
    const street = (await osrm(start, BUILDING_ENTRANCE, mode)) ?? (await osrm(start, BUILDING_ENTRANCE, mode === "walk" ? "drive" : "walk"));
    if (!street) {
      const points = [start, BUILDING_ENTRANCE];
      const meters = pathMeters(points);
      return { points, meters, seconds: meters / 1.3, steps: [{ icon: "↑", text: "Head to the building (no street route found)", meters, location: start }], approachStart: 0, routed: false };
    }

    // appendOutdoorModelApproach: from where the street route lands, follow the survey points to the entrance.
    const nodes = await this.graph().catch(() => []);
    if (!nodes.length) return { ...street, approachStart: Math.max(0, street.points.length - 2) };
    const landing = street.points[Math.max(0, street.points.length - 2)];
    const approach = this.shortest(nodes, this.nearest(nodes, landing), this.nearest(nodes, BUILDING_ENTRANCE));
    if (approach.length < 2) return { ...street, approachStart: Math.max(0, street.points.length - 2) };

    let splice = street.points.length - 1;
    street.points.forEach((p, i) => {
      if (distanceMeters(p, approach[0]) < distanceMeters(street.points[splice], approach[0])) splice = i;
    });
    const road = street.points.slice(0, splice + 1);
    const points = [...road, ...approach.slice(distanceMeters(road[road.length - 1], approach[0]) < 0.5 ? 1 : 0)];
    const meters = pathMeters(points);

    // Keep the street instructions up to the splice, then one instruction for the footpath.
    const roadMeters = pathMeters(road);
    let along = 0;
    const steps: OutdoorStep[] = [];
    for (const step of street.steps) {
      if (along >= roadMeters - 1 || step.text.startsWith("Arrive")) break;
      steps.push({ ...step, meters: Math.min(step.meters, roadMeters - along) });
      along += step.meters;
    }
    const footpath = pathMeters(approach);
    steps.push({ icon: "🚶", text: "Follow the footpath to the building entrance", meters: footpath, location: approach[0] });
    steps.push({ icon: "🏢", text: "Arrive at the building entrance", meters: 0, location: BUILDING_ENTRANCE });

    // Street time scaled to the spliced length, plus walking the footpath.
    const seconds = street.seconds * (roadMeters / Math.max(1, street.meters)) + footpath / 1.3;
    return { points, meters, seconds, steps, approachStart: Math.max(0, road.length - 1), routed: true };
  }
}
