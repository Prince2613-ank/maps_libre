import * as THREE from "three";
import { ALT_2ND, ALT_3RD, lonLatToEnu } from "./placement";

// Room-to-room routing, ported from the Cesium app (cesium_demo/src/navigation.ts):
// - corridor centre-line points per floor, each linked to its 4 nearest neighbours within 8 m, Dijkstra between them
// - routes start/end at the room's door (door_*.geojson), falling back to the room polygon's centre
// - floors are joined by the same hand-placed stair path, with the same Pantry door special cases
// Everything here is in raw local East-North-Up metres (before any per-floor adjustment).

export type FloorId = "second" | "third";

export const NAV_FLOORS: Record<FloorId, { label: string; altitude: number; corridor: string; doors: string; rooms: string }> = {
  second: { label: "2nd Floor", altitude: ALT_2ND, corridor: "2nd_floor_corridor.geojson", doors: "door_2nd.geojson", rooms: "2nd_floor_room1.geojson" },
  third: { label: "3rd Floor", altitude: ALT_3RD, corridor: "3rd_floor_corridor.geojson", doors: "door_3rd.geojson", rooms: "3rd_floor_room1.geojson" }
};

const MAX_CORRIDOR_EDGE_METERS = 8.0;
const MAX_CORRIDOR_NEAREST_NEIGHBORS = 4;
const NODE_LIFT = 0.1; // corridor/door points sit 10 cm above the floor (Cesium: altitude + 0.1)
const ROUTE_LIFT = 0.5; // the drawn route floats another 50 cm higher (Cesium: zLift)
/** Rooms that are not navigation destinations (same filter as Cesium's getNavigableRoomNames). */
const NOT_DESTINATIONS = new Set(["employee sitting places", "stairs"]);

// Hand-placed door points and stair path from the Cesium app.
const SECOND_FLOOR_PANTRY_EMPLOYEE_SIDE_DOOR: [number, number] = [77.13362535043548, 28.670995911296629];
const THIRD_FLOOR_PANTRY_NEAR_CONFERENCE_DOOR: [number, number] = [77.13371705946003, 28.67095703850098];
const THIRD_FLOOR_PANTRY_LOWER_DOOR: [number, number] = [77.13372663090223, 28.67092052705272];
const CUSTOM_STAIR_PATH: [number, number][] = [
  [77.13369487589452, 28.67089514560174],
  [77.13369762958561, 28.670896829794504],
  [77.13370575798822, 28.670902046216586],
  [77.13368821772951, 28.670936267563533],
  [77.13368355420981, 28.67093314152187],
  [77.13369675630433, 28.670908889590613]
];

type GraphNode = { pos: THREE.Vector3; edges: { node: GraphNode; w: number }[] };

export type RoomChoice = {
  /** What the user sees, e.g. "Pantry (3rd Floor)" when a name exists on both floors. */
  label: string;
  roomName: string;
  floor: FloorId;
};

export type NavStep = { icon: string; title: string; text: string };

export type NavRoute = {
  from: RoomChoice;
  to: RoomChoice;
  /** Route on the start floor; for cross-floor routes it ends at the foot of the stairs. */
  partA: THREE.Vector3[];
  /** Stairs + route on the destination floor (empty for same-floor routes). */
  partB: THREE.Vector3[];
  steps: NavStep[];
  distance: number;
};

type FloorData = {
  graph: GraphNode[];
  doors: Map<string, THREE.Vector3>;
  roomCenters: Map<string, THREE.Vector3>;
  roomNames: string[];
};

const normalize = (name?: string | null) => name?.toLowerCase().trim() ?? "";

const at = ([lon, lat]: [number, number], altitude: number) => {
  const p = lonLatToEnu(lon, lat);
  return new THREE.Vector3(p.x, p.y, altitude);
};

async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

function buildGraph(points: THREE.Vector3[]): GraphNode[] {
  const graph: GraphNode[] = points.map((pos) => ({ pos, edges: [] }));
  const link = (a: GraphNode, b: GraphNode, w: number) => {
    if (!a.edges.some((e) => e.node === b)) a.edges.push({ node: b, w });
    if (!b.edges.some((e) => e.node === a)) b.edges.push({ node: a, w });
  };
  for (const node of graph) {
    graph
      .filter((other) => other !== node)
      .map((other) => ({ other, d: node.pos.distanceTo(other.pos) }))
      .filter(({ d }) => d <= MAX_CORRIDOR_EDGE_METERS)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_CORRIDOR_NEAREST_NEIGHBORS)
      .forEach(({ other, d }) => link(node, other, d));
  }
  return graph;
}

function findPath(graph: GraphNode[], start: GraphNode, goal: GraphNode): THREE.Vector3[] | null {
  const unvisited = new Set(graph);
  const previous = new Map<GraphNode, GraphNode>();
  const dist = new Map<GraphNode, number>(graph.map((n) => [n, Infinity]));
  dist.set(start, 0);

  while (unvisited.size) {
    let current: GraphNode | null = null;
    for (const node of unvisited) if (current === null || dist.get(node)! < dist.get(current)!) current = node;
    if (!current || dist.get(current) === Infinity || current === goal) break;
    unvisited.delete(current);
    for (const { node, w } of current.edges) {
      if (!unvisited.has(node)) continue;
      const d = dist.get(current)! + w;
      if (d < dist.get(node)!) {
        dist.set(node, d);
        previous.set(node, current);
      }
    }
  }

  if (start !== goal && !previous.has(goal)) return null;
  const path: THREE.Vector3[] = [];
  for (let node: GraphNode | undefined = goal; node; node = previous.get(node)) path.unshift(node.pos);
  return path;
}

function nearest(graph: GraphNode[], position: THREE.Vector3): GraphNode {
  return graph.reduce((best, node) => (node.pos.distanceTo(position) < best.pos.distanceTo(position) ? node : best));
}

function headingOf(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function turnSteps(path: THREE.Vector3[]): NavStep[] {
  if (path.length < 2) return [];
  const steps: NavStep[] = [{ icon: "↑", title: "Start", text: "Go forward" }];
  let heading = headingOf(path[0], path[1]);
  let run = path[0].distanceTo(path[1]);

  for (let i = 1; i < path.length - 1; i++) {
    const d = path[i].distanceTo(path[i + 1]);
    if (d < 0.8) {
      run += d;
      continue;
    }
    const next = headingOf(path[i], path[i + 1]);
    let diff = next - heading;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    if (Math.abs(diff) > 0.45) {
      steps[steps.length - 1].text += ` for ${Math.max(1, Math.round(run))} m`;
      const dir = diff > 0 ? "left" : "right";
      steps.push({ icon: diff > 0 ? "↰" : "↱", title: `Turn ${dir}`, text: `Turn ${dir} and go ahead` });
      heading = next;
      run = d;
    } else {
      run += d;
    }
  }
  steps[steps.length - 1].text += ` for ${Math.max(1, Math.round(run))} m`;
  return steps;
}

export function pathLength(path: THREE.Vector3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += path[i - 1].distanceTo(path[i]);
  return total;
}

/** Evenly spaced points along a path (Cesium: samplePathByDistance). */
export function samplePath(path: THREE.Vector3[], spacing: number): THREE.Vector3[] {
  if (path.length < 2) return path.map((p) => p.clone());
  const out = [path[0].clone()];
  let carry = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = a.distanceTo(b);
    if (len < 0.001) continue;
    let d = spacing - carry;
    while (d < len) {
      out.push(a.clone().lerp(b, d / len));
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  out.push(path[path.length - 1].clone());
  return out;
}

export class Navigator {
  private floors = new Map<FloorId, FloorData>();

  constructor(private readonly dataUrl: string) {}

  async load(): Promise<void> {
    await Promise.all(
      (Object.keys(NAV_FLOORS) as FloorId[]).map(async (floor) => {
        const info = NAV_FLOORS[floor];
        const nodeAlt = info.altitude + NODE_LIFT;
        const [corridor, doors, rooms] = await Promise.all([
          fetchJson(this.dataUrl + info.corridor),
          fetchJson(this.dataUrl + info.doors),
          fetchJson(this.dataUrl + info.rooms)
        ]);

        const graph = buildGraph(
          corridor.features.filter((f: any) => f.geometry?.type === "Point").map((f: any) => at(f.geometry.coordinates, nodeAlt))
        );

        const doorMap = new Map<string, THREE.Vector3>();
        for (const f of doors.features) {
          // Rooms with two doors keep the last one, like Cesium (Pantry's doors are special-cased in door()).
          if (f.geometry?.type === "Point") doorMap.set(normalize(f.properties.room_name), at(f.geometry.coordinates, nodeAlt));
        }

        const centers = new Map<string, THREE.Vector3>();
        const names: string[] = [];
        for (const f of rooms.features) {
          const name: string | null = f.properties?.room_name ?? null;
          if (!name) continue;
          names.push(name);
          if (centers.has(normalize(name))) continue;
          const coords: [number, number][] = (f.geometry.type === "MultiPolygon" ? f.geometry.coordinates.flat(2) : f.geometry.coordinates.flat(1));
          const box = new THREE.Box3();
          for (const c of coords) box.expandByPoint(at(c, nodeAlt));
          centers.set(normalize(name), box.getCenter(new THREE.Vector3()));
        }

        this.floors.set(floor, { graph, doors: doorMap, roomCenters: centers, roomNames: names });
      })
    );
  }

  /** Destinations for the From/To lists, labelled like the Cesium app. */
  rooms(): RoomChoice[] {
    const all: { roomName: string; floor: FloorId }[] = [];
    for (const [floor, data] of this.floors) {
      for (const roomName of new Set(data.roomNames)) {
        if (!NOT_DESTINATIONS.has(normalize(roomName))) all.push({ roomName, floor });
      }
    }
    const count = new Map<string, number>();
    for (const r of all) count.set(normalize(r.roomName), (count.get(normalize(r.roomName)) ?? 0) + 1);
    return all
      .map((r) => ({ ...r, label: count.get(normalize(r.roomName))! > 1 ? `${r.roomName} (${NAV_FLOORS[r.floor].label})` : r.roomName }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  findRoom(roomName: string, floor: FloorId): RoomChoice | undefined {
    return this.rooms().find((r) => r.floor === floor && normalize(r.roomName) === normalize(roomName));
  }

  private door(room: RoomChoice, other: RoomChoice): THREE.Vector3 | undefined {
    const name = normalize(room.roomName);
    const alt = NAV_FLOORS[room.floor].altitude + NODE_LIFT;
    if (name === "pantry" && room.floor === "second") return at(SECOND_FLOOR_PANTRY_EMPLOYEE_SIDE_DOOR, alt);
    if (name === "pantry" && room.floor === "third") {
      // Cross-floor routes use the Pantry door near the conference room; same-floor routes the lower door.
      return at(other.floor !== "third" ? THIRD_FLOOR_PANTRY_NEAR_CONFERENCE_DOOR : THIRD_FLOOR_PANTRY_LOWER_DOOR, alt);
    }
    const data = this.floors.get(room.floor);
    return data?.doors.get(name) ?? data?.roomCenters.get(name);
  }

  route(from: RoomChoice, to: RoomChoice): NavRoute | string {
    const graphA = this.floors.get(from.floor)?.graph;
    const graphB = this.floors.get(to.floor)?.graph;
    const startDoor = this.door(from, to);
    const endDoor = this.door(to, from);
    if (!graphA?.length || !graphB?.length || !startDoor || !endDoor) return "No route data for the selected rooms.";

    const lift = (p: THREE.Vector3) => p.clone().setZ(p.z + ROUTE_LIFT);
    let partA: THREE.Vector3[];
    let partB: THREE.Vector3[] = [];

    if (from.floor === to.floor) {
      const path = findPath(graphA, nearest(graphA, startDoor), nearest(graphA, endDoor));
      if (!path) return "No route found.";
      partA = [startDoor, ...path, endDoor].map(lift);
    } else {
      const startAlt = NAV_FLOORS[from.floor].altitude;
      const targetAlt = NAV_FLOORS[to.floor].altitude;
      const landingAlt = (startAlt + targetAlt) / 2;
      const goingUp = from.floor === "second";
      const bridge = goingUp ? [...CUSTOM_STAIR_PATH] : [...CUSTOM_STAIR_PATH].reverse();
      const stairs = bridge.map((point, i) => {
        const h = goingUp
          ? i <= 2 ? startAlt : i <= 4 ? landingAlt : targetAlt
          : i <= 1 ? startAlt : i <= 3 ? landingAlt : targetAlt;
        return at(point, h + ROUTE_LIFT);
      });
      const part1 = findPath(graphA, nearest(graphA, startDoor), nearest(graphA, stairs[0]));
      const part2 = findPath(graphB, nearest(graphB, stairs[stairs.length - 1]), nearest(graphB, endDoor));
      if (!part1 || !part2) return "No route found.";
      partA = [...[startDoor, ...part1].map(lift), stairs[0]];
      partB = [...stairs, ...[...part2, endDoor].map(lift)];
    }

    const steps = [...turnSteps(partA)];
    if (partB.length) {
      steps.push({ icon: "🪜", title: "Use stairs", text: `Move to ${NAV_FLOORS[to.floor].label}` });
      steps.push(...turnSteps(partB));
    }
    steps.push({ icon: "🚩", title: "Arrive at destination", text: `You have reached ${to.label}` });

    return { from, to, partA, partB, steps, distance: pathLength(partA) + pathLength(partB) };
  }
}

/** How far a raw route point is from the 2nd floor towards the 3rd (0 = on 2nd, 1 = on 3rd); in between on the stairs. */
export function thirdFloorWeight(z: number): number {
  return THREE.MathUtils.clamp((z - ALT_2ND) / (ALT_3RD - ALT_2ND), 0, 1);
}
