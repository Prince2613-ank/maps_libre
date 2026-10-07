import * as maplibregl from "maplibre-gl";
import type { CustomLayerInterface, CustomRenderMethodInput } from "maplibre-gl";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { LATITUDE, LONGITUDE, ellipsoidCorrection, enuModelMatrix } from "./placement";
import { NO_ADJUSTMENT, adjustmentMatrix, type Adjustment } from "./adjustments";

type ModelEntry = {
  root: THREE.Group;
  file: string;
  altitude: number;
  center: THREE.Vector3;
  box: THREE.Box3Helper;
  /** Overlays (room shapes etc.) are authored directly in ENU metres, so they skip the Cesium model transform. */
  overlay?: boolean;
  /** Where most of the model's geometry is (see bulkBounds), computed on first use. */
  bulk?: THREE.Box3;
};

/**
 * Shrink every texture in `scene` larger than `maxSize` pixels before it reaches the GPU. Captured surroundings can
 * carry textures (8192², many 4096²) that need gigabytes of GPU memory; running out loses the whole WebGL context.
 */
function shrinkTextures(scene: THREE.Object3D, maxSize: number): void {
  const textures = new Set<THREE.Texture>();
  scene.traverse((child) => {
    const material = (child as THREE.Mesh).material;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  const originals = new Set<ImageBitmap>();
  for (const texture of textures) {
    // Textures sharing an image share one Source, so after the first resize the others already see the small one.
    const image = texture.image as (CanvasImageSource & { width: number; height: number }) | null;
    if (!image || Math.max(image.width, image.height) <= maxSize) continue;
    const scale = maxSize / Math.max(image.width, image.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d")!;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) originals.add(image);
    texture.image = canvas;
    texture.needsUpdate = true;
  }
  for (const bitmap of originals) bitmap.close(); // free the full-size decoded images
}

/** Share of each mesh's vertices ignored at each end of each axis, so a few stray vertices don't count. */
const BULK_OUTLIER_SHARE = 0.01;
const BULK_SAMPLES_PER_MESH = 20_000;
/** Meshes centred farther than this from the anchor (the building) are strays, not part of the building. */
const BULK_MAX_DISTANCE_M = 60;

/**
 * Box around the parts of a model that are actually at the building, in ENU metres around the anchor: vertices are
 * taken in `scene`'s own space (as when it was loaded) and mapped by `toEnu`. Some exported floors carry stray
 * objects far away (the ground floor file has a large plant ~350 m up in the sky), which makes their plain bounding
 * box — and so the adjustment pivot — useless.
 */
function bulkBounds(scene: THREE.Object3D, toEnu: THREE.Matrix4): THREE.Box3 {
  scene.updateMatrixWorld(true);
  const parentInverse = scene.parent ? scene.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
  const v = new THREE.Vector3();
  const toTarget = new THREE.Matrix4();
  const meshBoxes: THREE.Box3[] = [];
  scene.traverse((child) => {
    const position = (child as THREE.Mesh).isMesh ? (child as THREE.Mesh).geometry.getAttribute("position") : undefined;
    if (!position?.count) return;
    toTarget.multiplyMatrices(toEnu, parentInverse).multiply(child.matrixWorld);
    const stride = Math.max(1, Math.ceil(position.count / BULK_SAMPLES_PER_MESH));
    const axes: number[][] = [[], [], []];
    for (let i = 0; i < position.count; i += stride) {
      v.fromBufferAttribute(position, i).applyMatrix4(toTarget);
      axes[0].push(v.x);
      axes[1].push(v.y);
      axes[2].push(v.z);
    }
    const box = new THREE.Box3();
    axes.forEach((values, axis) => {
      values.sort((a, b) => a - b);
      box.min.setComponent(axis, values[Math.round(BULK_OUTLIER_SHARE * (values.length - 1))]);
      box.max.setComponent(axis, values[Math.round((1 - BULK_OUTLIER_SHARE) * (values.length - 1))]);
    });
    meshBoxes.push(box);
  });
  const nearby = meshBoxes.filter((box) => box.getCenter(v).length() <= BULK_MAX_DISTANCE_M);
  return (nearby.length ? nearby : meshBoxes).reduce((all, box) => all.union(box), new THREE.Box3());
}

/** Sun & sky lighting for the models (see setLighting). */
export type Lighting = {
  /** Unit vector pointing from the building towards the sun, in local East-North-Up. */
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  ambientColor: THREE.Color;
  ambientIntensity: number;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  hemiIntensity: number;
  /** Cast shadows from the sun onto the models and the ground. */
  shadows: boolean;
  /** Darkness of shadows on the ground (0..1). */
  groundShadowOpacity: number;
};

/** Metalness cap, so metallic surfaces stay lit without an environment map. */
const MAX_METALNESS = 0.2;

/** Half-size (m) of the square area around the building where sun shadows are computed. */
const SHADOW_EXTENT = 70;
const SHADOW_MAP_SIZE = 4096;
const SUN_DISTANCE = 300;

/** Result of a click/hover pick: which model or overlay was hit, the exact mesh, and where (three.js world space). */
export type PickHit = { file: string; object: THREE.Object3D; point: THREE.Vector3 };

/** Models adjusted together (one panel layer). Rotation/scale pivot on the pivot model's centre. */
type ModelSet = { files: Set<string>; pivotFile: string; adjustment: Adjustment };

/**
 * MapLibre custom layer that renders GLB models with three.js.
 *
 * Coordinate setup (keeps float32 precision good at high zoom):
 * - Projection  = MapLibre mainMatrix * translate(anchor) * scale(metres -> mercator units)
 * - Object      = flipY (ENU north -> mercator south) * WGS84 correction * debug adjustment of its set
 *                 * translate(0, 0, altitude) * Cesium rotation/scale
 * So everything inside three.js is in metres relative to the building anchor.
 */
export class ModelLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map!: maplibregl.Map;
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly loader: GLTFLoader;
  private readonly anchor: THREE.Matrix4;
  private readonly enuModel = enuModelMatrix();
  private readonly ellipsoid = ellipsoidCorrection();
  private readonly objects = new Map<string, ModelEntry>();
  private readonly pending = new Map<string, Promise<ModelEntry>>();
  private readonly sets = new Map<string, ModelSet>();
  private readonly textureLimits = new Map<string, number>();
  private readonly doubleSided = new Set<string>();
  private highlighted = new Set<string>();
  private readonly mercatorAnchor: maplibregl.MercatorCoordinate;
  private readonly afterRender = new Set<() => void>();
  private readonly ambient = new THREE.AmbientLight(0xffffff, 1.4);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x666666, 1.2);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1.6);
  /** Invisible ground plane that only shows the shadows falling on the map. */
  private readonly groundShadow: THREE.Mesh;
  private shadowsDirty = true;

  constructor(id: string, private readonly baseUrl: string) {
    this.id = id;

    const anchor = maplibregl.MercatorCoordinate.fromLngLat([LONGITUDE, LATITUDE], 0);
    this.mercatorAnchor = anchor;
    const s = anchor.meterInMercatorCoordinateUnits();
    this.anchor = new THREE.Matrix4().makeTranslation(anchor.x, anchor.y, anchor.z).scale(new THREE.Vector3(s, s, s));

    const draco = new DRACOLoader().setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
    this.loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);

    this.scene.add(this.ambient);
    this.hemi.position.set(0, 0, 1);
    this.scene.add(this.hemi);
    // three.js world = east, south (mercator y), up — the sun sits SUN_DISTANCE m away, aimed at the anchor.
    this.sun.position.set(0.5, -0.8, 1.5).setLength(SUN_DISTANCE);
    this.sun.target.position.set(0, 0, 0);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -SHADOW_EXTENT;
    cam.right = cam.top = SHADOW_EXTENT;
    cam.near = 1;
    cam.far = SUN_DISTANCE * 2;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);

    this.groundShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(SHADOW_EXTENT * 2, SHADOW_EXTENT * 2),
      // Double-sided: three.js world here has y flipped (mercator south), which reverses this plane's winding.
      new THREE.ShadowMaterial({ opacity: 0.35, depthWrite: false, side: THREE.DoubleSide })
    );
    this.groundShadow.receiveShadow = true;
    this.groundShadow.frustumCulled = false;
    this.groundShadow.visible = false;
    this.scene.add(this.groundShadow);
  }

  /** Sun direction/colour, sky light and shadows (driven by the Sun panel). */
  setLighting(l: Lighting): void {
    // ENU → three.js world (y flipped to mercator south).
    this.sun.position.set(l.sunDirection.x, -l.sunDirection.y, l.sunDirection.z).normalize().multiplyScalar(SUN_DISTANCE);
    this.sun.color.copy(l.sunColor);
    this.sun.intensity = l.sunIntensity;
    this.ambient.color.copy(l.ambientColor);
    this.ambient.intensity = l.ambientIntensity;
    this.hemi.color.copy(l.skyColor);
    this.hemi.groundColor.copy(l.groundColor);
    this.hemi.intensity = l.hemiIntensity;
    const castShadows = l.shadows && l.sunIntensity > 0.01;
    this.sun.castShadow = castShadows;
    this.groundShadow.visible = castShadows;
    (this.groundShadow.material as THREE.ShadowMaterial).opacity = l.groundShadowOpacity;
    this.shadowsDirty = true;
    this.map?.triggerRepaint();
  }

  onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The shadow map only depends on the sun and the models, not the camera: re-render it only when they change.
    this.renderer.shadowMap.autoUpdate = false;
  }

  /** Load (once) and show/hide a model. Resolves when the model is in the scene. */
  async setVisible(file: string, altitude: number, visible: boolean): Promise<void> {
    const key = `${file}@${altitude}`;
    if (!visible) {
      const entry = this.objects.get(key);
      if (entry) entry.root.visible = false;
      this.shadowsDirty = true;
      this.map?.triggerRepaint();
      return;
    }
    const entry = await this.load(key, file, altitude);
    entry.root.visible = true;
    this.shadowsDirty = true;
    this.map?.triggerRepaint();
  }

  isVisible(file: string, altitude: number): boolean {
    return this.objects.get(`${file}@${altitude}`)?.root.visible ?? false;
  }

  /** Load this file's textures at no more than `size` pixels (call before the file loads). */
  limitTextureSize(file: string, size: number): void {
    this.textureLimits.set(file, size);
  }

  /** Draw both faces of this file's triangles (call before the file loads). */
  setDoubleSided(file: string): void {
    this.doubleSided.add(file);
  }

  /** Declare models that are adjusted together with setSetAdjustment. */
  defineSet(id: string, files: string[], pivotFile: string): void {
    this.sets.set(id, { files: new Set(files), pivotFile, adjustment: this.sets.get(id)?.adjustment ?? NO_ADJUSTMENT });
  }

  /** Move / rotate / scale a whole set on top of the shared placement. */
  setSetAdjustment(id: string, adjustment: Adjustment): void {
    const set = this.sets.get(id);
    if (!set) return;
    set.adjustment = adjustment;
    for (const entry of this.objects.values()) if (set.files.has(entry.file)) this.updateMatrix(entry);
    this.shadowsDirty = true;
    this.map?.triggerRepaint();
  }

  /** Add a file (e.g. an overlay) to an existing set so it follows that set's adjustment. */
  addToSet(id: string, file: string): void {
    this.sets.get(id)?.files.add(file);
    for (const entry of this.objects.values()) if (entry.file === file) this.updateMatrix(entry);
  }

  /**
   * Add a non-GLB object authored in local East-North-Up metres around the anchor (x east, y north, z up).
   * It is lifted to `altitude` and follows the adjustment of whichever set contains `file`.
   */
  addOverlay(file: string, object: THREE.Object3D, altitude: number): void {
    const key = `${file}@${altitude}`;
    const existing = this.objects.get(key);
    if (existing) this.scene.remove(existing.root);
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.add(object);
    root.traverse((child) => (child.frustumCulled = false));
    root.visible = false;
    const box = new THREE.Box3Helper(new THREE.Box3(), 0xff00ff);
    box.visible = false;
    const entry: ModelEntry = { root, file, altitude, center: new THREE.Vector3(), box, overlay: true };
    this.scene.add(root);
    this.objects.set(key, entry);
    this.updateMatrix(entry);
    this.map?.triggerRepaint();
  }

  /** Show/hide an overlay added with addOverlay. */
  setOverlayVisible(file: string, altitude: number, visible: boolean): void {
    const entry = this.objects.get(`${file}@${altitude}`);
    if (entry) entry.root.visible = visible;
    this.map?.triggerRepaint();
  }

  /**
   * Nearest visible model/overlay under a screen point (CSS pixels relative to the map canvas),
   * considering only files accepted by `filter`. Like the Cesium app, big floor shells are not
   * pickable, so filter them out and chairs/rooms can be clicked through walls seen from above.
   */
  pick(x: number, y: number, filter: (file: string) => boolean): PickHit | null {
    const ray = this.screenRay(x, y);
    if (!ray) return null;
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
    raycaster.params.Line = { threshold: 0 };

    const roots = [...this.objects.values()].filter((e) => e.root.visible && filter(e.file));
    this.scene.updateMatrixWorld();
    const hits = raycaster.intersectObjects(roots.map((e) => e.root), true).filter((h) => h.object.visible && !(h.object instanceof THREE.Box3Helper) && !(h.object instanceof THREE.Line));
    if (!hits.length) return null;
    const hit = hits[0];
    const entry = roots.find((e) => isDescendant(hit.object, e.root))!;
    return { file: entry.file, object: hit.object, point: hit.point.clone() };
  }

  /** The view ray (three.js world space) under a screen point in CSS pixels relative to the map canvas. */
  screenRay(x: number, y: number): THREE.Ray | null {
    if (!this.map) return null;
    const canvas = this.map.getCanvas();
    const ndcX = (x / canvas.clientWidth) * 2 - 1;
    const ndcY = -(y / canvas.clientHeight) * 2 + 1;
    const inverse = this.camera.projectionMatrixInverse;
    const near = new THREE.Vector3(ndcX, ndcY, -1).applyMatrix4(inverse);
    const far = new THREE.Vector3(ndcX, ndcY, 1).applyMatrix4(inverse);
    return new THREE.Ray(near, far.sub(near).normalize());
  }

  /** Local → three.js world matrix of an overlay added with addOverlay (includes its set's adjustment). */
  overlayMatrix(file: string, altitude: number): THREE.Matrix4 | null {
    return this.objects.get(`${file}@${altitude}`)?.root.matrix.clone() ?? null;
  }

  /** Screen position (CSS pixels) of a three.js world point, or null when it is behind the camera. */
  projectToScreen(point: THREE.Vector3): { x: number; y: number } | null {
    if (!this.map) return null;
    const clip = new THREE.Vector4(point.x, point.y, point.z, 1).applyMatrix4(this.camera.projectionMatrix);
    if (clip.w <= 0) return null;
    const canvas = this.map.getCanvas();
    return {
      x: ((clip.x / clip.w + 1) / 2) * canvas.clientWidth,
      y: ((1 - clip.y / clip.w) / 2) * canvas.clientHeight
    };
  }

  /** Geographic position of a three.js world point (for MapLibre markers etc.). */
  toLngLat(point: THREE.Vector3): maplibregl.LngLat {
    const s = this.mercatorAnchor.meterInMercatorCoordinateUnits();
    return new maplibregl.MercatorCoordinate(this.mercatorAnchor.x + point.x * s, this.mercatorAnchor.y + point.y * s, 0).toLngLat();
  }

  /** Run after every frame (e.g. to keep HTML popups glued to a 3D point). Returns an unsubscribe function. */
  onAfterRender(callback: () => void): () => void {
    this.afterRender.add(callback);
    return () => this.afterRender.delete(callback);
  }

  /** Draw bounding boxes (visible through walls) around these models. */
  setHighlight(files: string[]): void {
    this.highlighted = new Set(files);
    for (const entry of this.objects.values()) entry.box.visible = this.highlighted.has(entry.file);
    this.map?.triggerRepaint();
  }

  private updateMatrix(entry: ModelEntry): void {
    entry.root.matrix
      .makeScale(this.ellipsoid.east, -this.ellipsoid.north, 1)
      .multiply(this.setMatrix(entry))
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, entry.altitude));
    if (!entry.overlay) entry.root.matrix.multiply(this.enuModel);
  }

  private setMatrix(entry: ModelEntry): THREE.Matrix4 {
    const set = [...this.sets.values()].find((s) => s.files.has(entry.file));
    return set ? this.adjustmentOf(set, entry.altitude) : new THREE.Matrix4();
  }

  private adjustmentOf(set: ModelSet, fallbackAltitude: number): THREE.Matrix4 {
    // Pivot = centre of the set's main model; until it has loaded, the point under the anchor at this height.
    const pivot = [...this.objects.values()].find((e) => e.file === set.pivotFile);
    const center = pivot ? pivot.center.clone().setZ(pivot.center.z + pivot.altitude) : new THREE.Vector3(0, 0, fallbackAltitude);
    return adjustmentMatrix(set.adjustment, center);
  }

  /**
   * For editing a set's adjustment: the point its rotation/scale pivots on, and the box around the bulk of its main
   * model (ENU metres, at its altitude, before the adjustment). Null until the main model has loaded.
   */
  setGeometry(id: string): { pivot: THREE.Vector3; bounds: THREE.Box3 } | null {
    const set = this.sets.get(id);
    const entry = set && [...this.objects.values()].find((e) => e.file === set.pivotFile && !e.overlay);
    if (!entry) return null;
    // The scene inside root is in model space; enuModel takes it to ENU metres like `center`.
    entry.bulk ??= bulkBounds(entry.root.children[0], this.enuModel).translate(new THREE.Vector3(0, 0, entry.altitude));
    return { pivot: entry.center.clone().setZ(entry.center.z + entry.altitude), bounds: entry.bulk.clone() };
  }

  /**
   * Current adjustment of a set as an ENU-metre matrix (identity for unknown sets), so other code can move
   * its own geometry (e.g. a navigation route) exactly like that set's models. Load the set's pivot model first.
   */
  setTransform(id: string, fallbackAltitude = 0): THREE.Matrix4 {
    const set = this.sets.get(id);
    return set ? this.adjustmentOf(set, fallbackAltitude) : new THREE.Matrix4();
  }

  /** Load a model without showing it. */
  async preload(file: string, altitude: number): Promise<void> {
    await this.load(`${file}@${altitude}`, file, altitude);
  }

  private load(key: string, file: string, altitude: number): Promise<ModelEntry> {
    const existing = this.objects.get(key);
    if (existing) return Promise.resolve(existing);
    const pending = this.pending.get(key);
    if (pending) return pending;

    const promise = this.loader.loadAsync(this.baseUrl + encodeURIComponent(file)).then((gltf) => {
      const textureLimit = this.textureLimits.get(file);
      if (textureLimit) shrinkTextures(gltf.scene, textureLimit);
      if (this.doubleSided.has(file)) {
        gltf.scene.traverse((child) => {
          const material = (child as THREE.Mesh).material;
          for (const m of Array.isArray(material) ? material : material ? [material] : []) m.side = THREE.DoubleSide;
        });
      }
      gltf.scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      const box = new THREE.Box3Helper(bounds, 0xff00ff);
      (box.material as THREE.Material).depthTest = false;
      box.renderOrder = 999;
      box.visible = this.highlighted.has(file);

      const root = new THREE.Group();
      root.matrixAutoUpdate = false;
      root.add(gltf.scene, box);
      root.traverse((child) => {
        child.frustumCulled = false; // projection is MapLibre's, three's culling can't trust it
        if (!(child as THREE.Mesh).isMesh) return;
        child.castShadow = child.receiveShadow = true;
        // The scene has no environment map, so fully metallic materials (no diffuse reflection) render pure black.
        const material = (child as THREE.Mesh).material;
        for (const m of Array.isArray(material) ? material : [material]) {
          const standard = m as THREE.MeshStandardMaterial;
          if (standard.isMeshStandardMaterial && standard.metalness > MAX_METALNESS) standard.metalness = MAX_METALNESS;
        }
      });
      root.visible = false;
      const center = bounds.getCenter(new THREE.Vector3()).applyMatrix4(this.enuModel);
      const entry: ModelEntry = { root, file, altitude, center, box };
      this.scene.add(root);
      this.objects.set(key, entry);
      this.pending.delete(key);
      this.updateMatrix(entry);
      // A set's pivot just became known: re-place the members that loaded before it.
      for (const set of this.sets.values()) {
        if (set.pivotFile !== file) continue;
        for (const other of this.objects.values()) if (set.files.has(other.file)) this.updateMatrix(other);
      }
      return entry;
    });
    promise.catch(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const main = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]);
    this.camera.projectionMatrix = main.multiply(this.anchor);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.renderer.resetState();
    // three.js restores this viewport after drawing the shadow map; keep it in sync with the map canvas.
    this.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    if (this.shadowsDirty && this.sun.castShadow) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowsDirty = false;
    }
    this.renderer.render(this.scene, this.camera);
    for (const callback of this.afterRender) callback();
  }
}

function isDescendant(object: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) if (o === ancestor) return true;
  return false;
}
