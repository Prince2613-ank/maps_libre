import * as THREE from "three";

// Route drawing in the style of the Cesium app (cesium_demo/src/navigation.ts drawRoute / startRouteGlowAnimation):
// cyan dots every 40 cm with brightness waves flowing start → end, two glow orbs riding each part,
// a blue start marker, a pulsing red end marker and a pulsing cyan "you are here" marker.
// Everything is screen-sized and drawn on top of the building (Cesium: disableDepthTestDistance = ∞).

const KIND_DOT = 0;
const KIND_GLOW = 1;
const KIND_MARKER = 2;

const WAVES = 3;
const WAVE_SPEED = 0.55; // path traversals per second
const WAVE_SIGMA = 0.16; // gaussian half-width (fraction of path)
const GLOWS_PER_PART = 2;

const START_COLOR = new THREE.Color("#0055FF");
const END_COLOR = new THREE.Color("#FF2200");
const LIVE_COLOR = new THREE.Color("#00CCFF");

const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColor;
  attribute float aKind;
  uniform float uPixelRatio;
  varying vec4 vColor;
  varying float vKind;
  void main() {
    vColor = aColor;
    vKind = aKind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec4 vColor;
  varying float vKind;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0; // 0 at the centre, 1 at the edge
    if (d > 1.0) discard;
    vec4 c;
    if (vKind < 0.5) {
      // route dot: white ring, cyan fill, soft white centre
      vec3 cyan = vec3(0.0, 0.8, 1.0);
      c = d > 0.78 ? vec4(1.0, 1.0, 1.0, 0.92) : vec4(d < 0.34 ? mix(cyan, vec3(1.0), 0.65) : cyan, 1.0);
    } else if (vKind < 1.5) {
      // glow orb: white → cyan → blue → transparent
      if (d < 0.2) c = mix(vec4(1.0, 1.0, 1.0, 0.95), vec4(0.0, 0.867, 1.0, 0.8), d / 0.2);
      else if (d < 0.55) c = mix(vec4(0.0, 0.867, 1.0, 0.8), vec4(0.0, 0.4, 1.0, 0.35), (d - 0.2) / 0.35);
      else c = mix(vec4(0.0, 0.4, 1.0, 0.35), vec4(0.0, 0.267, 1.0, 0.0), (d - 0.55) / 0.45);
    } else {
      // marker: coloured disc with a white outline
      c = d > 0.7 ? vec4(1.0) : vec4(vColor.rgb, 1.0);
    }
    gl_FragColor = vec4(c.rgb, c.a * vColor.a);
  }
`;

type Part = { points: THREE.Vector3[]; floor: string; t: number[] };

export class RouteOverlay {
  readonly object: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private parts: Part[] = [];
  private start: { point: THREE.Vector3; floor: string } | null = null;
  private end: { point: THREE.Vector3; floor: string } | null = null;
  private live: { point: THREE.Vector3; floor: string } | null = null;
  /** Dots up to this index of the whole route (part A then part B) are already walked and hidden. */
  private walked = -1;
  private startTime = performance.now();

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uPixelRatio: { value: 1 } },
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    this.object = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.object.renderOrder = 1000;
    this.object.frustumCulled = false;
  }

  /** Set the route. Parts are already-sampled points (three.js ENU metres) with the floor each is shown on. */
  setRoute(parts: { points: THREE.Vector3[]; floor: string }[]): void {
    this.parts = parts
      .filter((p) => p.points.length > 1)
      .map((p) => ({ ...p, t: p.points.map((_, i) => i / (p.points.length - 1)) }));
    const first = this.parts[0];
    const last = this.parts[this.parts.length - 1];
    this.start = first ? { point: first.points[0], floor: first.floor } : null;
    this.end = last ? { point: last.points[last.points.length - 1], floor: last.floor } : null;
    this.live = null;
    this.walked = -1;
    this.startTime = performance.now();

    const count = this.parts.reduce((n, p) => n + p.points.length + GLOWS_PER_PART, 0) + 3;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aKind", new THREE.BufferAttribute(new Float32Array(count), 1));
    this.object.geometry.dispose();
    this.object.geometry = geometry;
  }

  clear(): void {
    this.setRoute([]);
  }

  get active(): boolean {
    return this.parts.length > 0;
  }

  /** Walking marker position (or null to hide it) and how many route dots are behind it. */
  setLive(point: THREE.Vector3 | null, floor: string, walkedIndex: number): void {
    this.live = point ? { point, floor } : null;
    this.walked = walkedIndex;
  }

  /** Update the animation. `floorVisible` hides parts/markers whose floor is not shown, like the Cesium app. */
  update(pixelRatio: number, floorVisible: (floor: string) => boolean): void {
    this.material.uniforms.uPixelRatio.value = pixelRatio;
    const geometry = this.object.geometry;
    const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
    if (!pos) return;
    const size = geometry.getAttribute("aSize") as THREE.BufferAttribute;
    const color = geometry.getAttribute("aColor") as THREE.BufferAttribute;
    const kind = geometry.getAttribute("aKind") as THREE.BufferAttribute;

    const now = performance.now();
    const elapsed = (now - this.startTime) / 1000;
    const cycle = elapsed * WAVE_SPEED;
    let i = 0;
    const put = (p: THREE.Vector3, s: number, c: THREE.Color, a: number, k: number) => {
      pos.setXYZ(i, p.x, p.y, p.z);
      size.setX(i, s);
      color.setXYZW(i, c.r, c.g, c.b, a);
      kind.setX(i, k);
      i++;
    };
    const white = new THREE.Color(1, 1, 1);

    let routeIndex = 0;
    for (const part of this.parts) {
      const shown = floorVisible(part.floor);
      part.points.forEach((p, j) => {
        let peak = 0;
        for (let w = 0; w < WAVES; w++) {
          let dist = Math.abs(((cycle + w / WAVES) % 1) - part.t[j]);
          if (dist > 0.5) dist = 1 - dist;
          peak = Math.max(peak, Math.exp(-(dist * dist) / (2 * WAVE_SIGMA * WAVE_SIGMA)));
        }
        const ahead = routeIndex > this.walked;
        put(p, 5 + 7.5 * peak, white, shown && ahead ? 0.3 + 0.7 * peak : 0, KIND_DOT);
        routeIndex++;
      });
      for (let g = 0; g < GLOWS_PER_PART; g++) {
        const waveT = (cycle + g / GLOWS_PER_PART) % 1;
        const p = part.points[Math.min(Math.floor(waveT * part.points.length), part.points.length - 1)];
        put(p, 40 + 14 * Math.sin(elapsed * 4.5 + g * 2.5), white, shown ? 0.75 + 0.2 * Math.sin(elapsed * 3 + g) : 0, KIND_GLOW);
      }
    }

    const marker = (m: { point: THREE.Vector3; floor: string } | null, px: number, c: THREE.Color) => {
      if (m) put(m.point, px, c, floorVisible(m.floor) ? 1 : 0, KIND_MARKER);
      else put(new THREE.Vector3(), 0, c, 0, KIND_MARKER);
    };
    marker(this.start, 22, START_COLOR);
    marker(this.end, 20 + 6 * Math.abs(Math.sin(now * 0.004)), END_COLOR);
    marker(this.live, 16 + 5 * Math.abs(Math.sin(now * 0.005)), LIVE_COLOR);

    geometry.setDrawRange(0, i);
    pos.needsUpdate = size.needsUpdate = color.needsUpdate = kind.needsUpdate = true;
  }
}
