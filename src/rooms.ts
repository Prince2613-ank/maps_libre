import * as THREE from "three";
import type { ModelLayer } from "./modelLayer";
import { lonLatToEnu } from "./placement";

// Room polygons from the Cesium app (cesium_demo/*_room1.geojson), drawn at the floor height like cesium_demo/src/rooms.ts.

export const BOOKABLE_ROOMS = new Set(["dojo", "eureka", "manthan", "meeting room", "conference room"]);

export type RoomInfo = {
  name: string;
  /** Catalog group (layer) of the room's floor, e.g. "second". */
  groupId: string;
  roomId: string | null;
  type: string | null;
  floorLabel: string;
  bookable: boolean;
};

export type RoomFloor = {
  /** Catalog group (layer) the rooms belong to, so they follow that layer's adjustment and visibility. */
  groupId: string;
  url: string;
  floorLabel: string;
};

/** Overlay file id used for a floor's rooms inside the ModelLayer. */
export const roomOverlayId = (groupId: string) => `rooms:${groupId}`;

const FILL = 0xffffff;
const FILL_OPACITY = 0.08;
const HOVER_FILL = 0x1f6feb;
const HOVER_OPACITY = 0.35;
const OUTLINE = 0x333333;
const LIFT_METRES = 0.05; // keep the shapes just above the floor surface

type Ring = [number, number][];

function toEnu([lon, lat]: [number, number]): THREE.Vector2 {
  return lonLatToEnu(lon, lat);
}

function polygonsOf(geometry: { type: string; coordinates: unknown }): Ring[][] {
  if (geometry.type === "Polygon") return [geometry.coordinates as Ring[]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as Ring[][];
  return [];
}

/** Room mesh → its info (for popups); also how interaction code recognises a room hit. */
export const roomOf = new WeakMap<THREE.Object3D, RoomInfo>();

const roomMeshes: THREE.Mesh[] = [];
const hovered = new WeakSet<THREE.Object3D>();

/** Fill colour/opacity a room shows when not hovered (white, or its booking status colour). */
function restingLook(mesh: THREE.Object3D): { color: THREE.ColorRepresentation; opacity: number } {
  return mesh.userData.statusLook ?? { color: FILL, opacity: FILL_OPACITY };
}

export function highlightRoom(mesh: THREE.Object3D, on: boolean): void {
  const material = (mesh as THREE.Mesh).material as THREE.MeshBasicMaterial;
  if (on) hovered.add(mesh);
  else hovered.delete(mesh);
  const look = on ? { color: HOVER_FILL, opacity: HOVER_OPACITY } : restingLook(mesh);
  material.color.set(look.color);
  material.opacity = look.opacity;
}

/**
 * Tint rooms by booking status: `status(roomName)` returns "free", "busy" or null (no tint).
 * Returns true if any room changed, so the caller can repaint.
 */
export function tintRooms(status: (roomName: string) => "free" | "busy" | null): boolean {
  let changed = false;
  for (const mesh of roomMeshes) {
    const s = status(roomOf.get(mesh)!.name);
    const look = s === "busy" ? { color: 0xef4444, opacity: 0.28 } : s === "free" ? { color: 0x22c55e, opacity: 0.2 } : undefined;
    if (JSON.stringify(look) === JSON.stringify(mesh.userData.statusLook)) continue;
    mesh.userData.statusLook = look;
    if (!hovered.has(mesh)) highlightRoom(mesh, false);
    changed = true;
  }
  return changed;
}

export async function loadRooms(layer: ModelLayer, floor: RoomFloor, altitude: number): Promise<void> {
  const response = await fetch(floor.url);
  if (!response.ok) throw new Error(`${floor.url}: ${response.status}`);
  const geojson = await response.json();

  const group = new THREE.Group();
  for (const feature of geojson.features) {
    const props = feature.properties ?? {};
    const name: string = props.room_name ?? "Room";
    const info: RoomInfo = {
      name,
      roomId: props.room_id ?? null,
      type: props.type ?? null,
      groupId: floor.groupId,
      floorLabel: floor.floorLabel,
      bookable: BOOKABLE_ROOMS.has(name.toLowerCase().trim())
    };

    for (const rings of polygonsOf(feature.geometry)) {
      const [outer, ...holes] = rings.map((ring) => ring.map(toEnu));
      if (!outer || outer.length < 3) continue;
      const shape = new THREE.Shape(outer);
      for (const hole of holes) shape.holes.push(new THREE.Path(hole));

      const fill = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({ color: FILL, transparent: true, opacity: FILL_OPACITY, depthWrite: false, side: THREE.DoubleSide })
      );
      fill.position.z = LIFT_METRES;
      roomOf.set(fill, info);
      roomMeshes.push(fill);
      group.add(fill);

      const outline = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(outer.map((p) => new THREE.Vector3(p.x, p.y, LIFT_METRES))),
        new THREE.LineBasicMaterial({ color: OUTLINE, transparent: true, opacity: 0.6 })
      );
      group.add(outline);
    }
  }

  const id = roomOverlayId(floor.groupId);
  layer.addOverlay(id, group, altitude);
  layer.addToSet(floor.groupId, id);
}
