import * as THREE from "three";
import { pathToFileURL } from "node:url";
import { LONGITUDE, LATITUDE, MODEL_SCALE, ALT_GROUND, ALT_1ST, ALT_2ND, ALT_3RD, enuModelMatrix, ellipsoidCorrection } from "../src/placement.ts";

const Cesium: any = await import(pathToFileURL("C:/Users/Flodata Analytics/3d-model11/cesium_demo/node_modules/@cesium/engine/index.js").href);

// --- Cesium: exact copy of cesium_demo computeMatrix + Model's scale & glTF axis correction
function cesiumMatrix(altitude: number) {
  const position = Cesium.Cartesian3.fromDegrees(LONGITUDE, LATITUDE, altitude);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const rz = Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(50));
  const rx = Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(-139));
  const ry = Cesium.Matrix3.fromRotationY(Cesium.Math.toRadians(-90));
  const rotation = Cesium.Matrix3.multiply(rz, Cesium.Matrix3.multiply(ry, rx, new Cesium.Matrix3()), new Cesium.Matrix3());
  const m = Cesium.Matrix4.multiply(enu, Cesium.Matrix4.fromRotationTranslation(rotation), new Cesium.Matrix4());
  const axis = Cesium.ModelUtility.getAxisCorrectionMatrix(Cesium.Axis.Y, Cesium.Axis.Z, new Cesium.Matrix4());
  Cesium.Matrix4.multiplyTransformation(m, axis, m);
  return Cesium.Matrix4.multiplyByUniformScale(m, MODEL_SCALE, m);
}

// --- MapLibre side: same math as modelLayer.ts (Web Mercator)
const merc = (lon: number, lat: number) => [(180 + lon) / 360, (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360];
const unmerc = (x: number, y: number) => [x * 360 - 180, (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90];
const [ax, ay] = merc(LONGITUDE, LATITUDE);
const s = 1 / (40075016.68557849 * Math.cos((LATITUDE * Math.PI) / 180)); // meterInMercatorCoordinateUnits
function maplibrePoint(p: THREE.Vector3, altitude: number) {
  const m = new THREE.Matrix4().makeScale(ellipsoidCorrection().east, -ellipsoidCorrection().north, 1).multiply(new THREE.Matrix4().makeTranslation(0, 0, altitude)).multiply(enuModelMatrix());
  const q = p.clone().applyMatrix4(m); // x east, y south, z up (metres)
  const [lon, lat] = unmerc(ax + q.x * s, ay + q.y * s);
  return { lon, lat, h: q.z };
}

const R = 6378137;
let worst = 0;
for (const [name, alt] of [["ground", ALT_GROUND], ["1st", ALT_1ST], ["2nd", ALT_2ND], ["3rd", ALT_3RD]] as const) {
  for (const p of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, -0.3, 0.8], [-1, 0.2, -0.6]]) {
    const c = Cesium.Cartographic.fromCartesian(Cesium.Matrix4.multiplyByPoint(cesiumMatrix(alt), new Cesium.Cartesian3(...p), new Cesium.Cartesian3()));
    const ml = maplibrePoint(new THREE.Vector3(...p), alt);
    const dE = (ml.lon - Cesium.Math.toDegrees(c.longitude)) * (Math.PI / 180) * R * Math.cos(c.latitude);
    const dN = (ml.lat - Cesium.Math.toDegrees(c.latitude)) * (Math.PI / 180) * R;
    const dH = ml.h - c.height;
    const err = Math.hypot(dE, dN, dH);
    worst = Math.max(worst, err);
    console.log(name.padEnd(6), JSON.stringify(p).padEnd(16), `height cesium=${c.height.toFixed(3)} maplibre=${ml.h.toFixed(3)}`, `diff=${(err * 100).toFixed(2)} cm`);
  }
}
console.log(`worst difference: ${(worst * 100).toFixed(2)} cm`);
