import * as THREE from "three";
import saved from "./adjustments.json";

/** Fine-tuning of one layer on top of the shared placement, in local East-North-Up metres / degrees. */
export type Adjustment = { east: number; north: number; up: number; yaw: number; pitch: number; roll: number; scale: number };

export const NO_ADJUSTMENT: Adjustment = { east: 0, north: 0, up: 0, yaw: 0, pitch: 0, roll: 0, scale: 1 };

// Saved adjustments, keyed by layer id (catalog GROUPS). Written by the Debug panel's "Save" button (dev server only).
export const ADJUSTMENTS: Record<string, Partial<Adjustment>> = saved;

export function savedAdjustment(id: string): Adjustment {
  return { ...NO_ADJUSTMENT, ...ADJUSTMENTS[id] };
}

const deg = THREE.MathUtils.degToRad;

/** ENU transform for an adjustment. Rotation and scale pivot on `center` (ENU metres). */
export function adjustmentMatrix(adj: Adjustment, center: THREE.Vector3): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeTranslation(center.x + adj.east, center.y + adj.north, center.z + adj.up)
    .multiply(new THREE.Matrix4().makeRotationZ(deg(adj.yaw)))
    .multiply(new THREE.Matrix4().makeRotationX(deg(adj.pitch)))
    .multiply(new THREE.Matrix4().makeRotationY(deg(adj.roll)))
    .multiply(new THREE.Matrix4().makeScale(adj.scale, adj.scale, adj.scale))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
}
