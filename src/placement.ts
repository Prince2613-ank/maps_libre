import * as THREE from "three";

// Placement copied from the Cesium project (cesium_demo/src/viewer.ts) so the
// models land in exactly the same spot, orientation and size.
export const LONGITUDE = 77.13369474110053 + 0.0000053;
export const LATITUDE = 28.670948042901436 + 0.00001684;
export const MODEL_SCALE = 25;
export const BASE_ALT = 0.01;
export const FLOOR_H = 3.6;
export const STACK_COMPRESS = -0.6;
export const ALT_GROUND = BASE_ALT;
export const ALT_1ST = BASE_ALT + FLOOR_H + STACK_COMPRESS;
export const ALT_2ND = BASE_ALT + 2 * FLOOR_H + 2 * STACK_COMPRESS;
export const ALT_3RD = BASE_ALT + 3 * FLOOR_H + 3 * STACK_COMPRESS;

const YAW = 50;
const PITCH = -139;
const ROLL = -90;

const deg = THREE.MathUtils.degToRad;

/**
 * Cesium measures metres on the WGS84 ellipsoid; MapLibre's Web Mercator assumes a sphere of
 * radius 6378137 m. These factors convert ellipsoid east/north metres into "sphere metres" so
 * horizontal positions match Cesium exactly (otherwise ~0.44% off here, ~11 cm at 25 m).
 */
export function ellipsoidCorrection(latitude = LATITUDE): { east: number; north: number } {
  const a = 6378137;
  const e2 = 0.00669437999014;
  const sin = Math.sin(deg(latitude));
  const w = 1 - e2 * sin * sin;
  const primeVertical = a / Math.sqrt(w);
  const meridian = (a * (1 - e2)) / (w * Math.sqrt(w));
  return { east: a / primeVertical, north: a / meridian };
}

/**
 * Linear part of Cesium's model transform, expressed in local East-North-Up metres:
 *   Rz(yaw) * Ry(roll) * Rx(pitch) * glTF axis correction * scale
 * Cesium's glTF axis correction for glTF 2.0 is Y_UP_TO_Z_UP * Z_UP_TO_X_UP,
 * i.e. RotX(+90deg) * RotY(+90deg).
 */
export function enuModelMatrix(): THREE.Matrix4 {
  const rotation = new THREE.Matrix4()
    .makeRotationZ(deg(YAW))
    .multiply(new THREE.Matrix4().makeRotationY(deg(ROLL)))
    .multiply(new THREE.Matrix4().makeRotationX(deg(PITCH)));
  const axisCorrection = new THREE.Matrix4()
    .makeRotationX(deg(90))
    .multiply(new THREE.Matrix4().makeRotationY(deg(90)));
  return rotation
    .multiply(axisCorrection)
    .multiply(new THREE.Matrix4().makeScale(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE));
}

/** Lon/lat → local East-North metres around the anchor, on the WGS84 ellipsoid (same convention as Cesium). */
export function lonLatToEnu(lon: number, lat: number): THREE.Vector2 {
  const a = 6378137;
  const { east, north } = ellipsoidCorrection();
  return new THREE.Vector2(
    deg(lon - LONGITUDE) * (a / east) * Math.cos(deg(LATITUDE)),
    deg(lat - LATITUDE) * (a / north)
  );
}

/** Inverse of lonLatToEnu. */
export function enuToLonLat(east: number, north: number): [number, number] {
  const a = 6378137;
  const k = ellipsoidCorrection();
  const rad = THREE.MathUtils.radToDeg;
  return [LONGITUDE + rad(east / ((a / k.east) * Math.cos(deg(LATITUDE)))), LATITUDE + rad(north / (a / k.north))];
}
