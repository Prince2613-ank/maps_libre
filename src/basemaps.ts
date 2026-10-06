import type * as maplibregl from "maplibre-gl";
import { LATITUDE, LONGITUDE } from "./placement";

// Base map switcher: raster tile maps drawn under the 3D models. A base map's layers are added the first time it
// is picked and only shown/hidden after that, so the model layer and overlays above them are never rebuilt
// (a full setStyle() swap would drop the custom layer).

type RasterLayer = { tiles: string[]; maxzoom: number; attribution: string };
export type Basemap = { id: string; label: string; layers: string[] };

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI_ATTRIBUTION = 'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics';
const CARTO_ATTRIBUTION = `&copy; <a href="https://carto.com/attributions">CARTO</a>, ${OSM_ATTRIBUTION}`;

const esri = (service: string) => [`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`];
const carto = (style: string) => ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}@2x.png`);

// Layer ids double as source ids. "osm" keeps the id the map has always used.
const LAYERS: Record<string, RasterLayer> = {
  osm: { tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], maxzoom: 19, attribution: OSM_ATTRIBUTION },
  "basemap:imagery": { tiles: esri("World_Imagery"), maxzoom: 19, attribution: ESRI_ATTRIBUTION },
  "basemap:roads": { tiles: esri("Reference/World_Transportation"), maxzoom: 19, attribution: ESRI_ATTRIBUTION },
  "basemap:places": { tiles: esri("Reference/World_Boundaries_and_Places"), maxzoom: 19, attribution: ESRI_ATTRIBUTION },
  "basemap:light": { tiles: carto("light_all"), maxzoom: 20, attribution: CARTO_ATTRIBUTION },
  "basemap:dark": { tiles: carto("dark_all"), maxzoom: 20, attribution: CARTO_ATTRIBUTION }
};

/** Bottom layer first. */
export const BASEMAPS: Basemap[] = [
  { id: "streets", label: "Streets", layers: ["osm"] },
  { id: "satellite", label: "Satellite", layers: ["basemap:imagery"] },
  { id: "hybrid", label: "Hybrid", layers: ["basemap:imagery", "basemap:roads", "basemap:places"] },
  { id: "light", label: "Light", layers: ["basemap:light"] },
  { id: "dark", label: "Dark", layers: ["basemap:dark"] }
];

/** Every layer id a base map can use, for code that restyles the base map (e.g. the day/night tint). */
export const BASEMAP_LAYER_IDS = Object.keys(LAYERS);

const STORAGE_KEY = "indoor.basemap";

function savedBasemap(): Basemap {
  let id: string | null = null;
  try {
    id = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked; fall back to the default.
  }
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
}

const source = (id: string): maplibregl.RasterSourceSpecification => ({ type: "raster", tileSize: 256, ...LAYERS[id] });

/** Map style that starts on the viewer's last base map, so its tiles are the first ones fetched. */
export function initialStyle(): maplibregl.StyleSpecification {
  const { layers } = savedBasemap();
  return {
    version: 8,
    sources: Object.fromEntries(layers.map((id) => [id, source(id)])),
    layers: layers.map((id) => ({ id, type: "raster", source: id }))
  };
}

/** One tile around the building, as a CSS background (top layer first) for the switcher's previews. */
function thumbnail(basemap: Basemap): string {
  const z = 17;
  const n = 2 ** z;
  const lat = (LATITUDE * Math.PI) / 180;
  const x = Math.floor(((LONGITUDE + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * n);
  return [...basemap.layers]
    .reverse()
    .map((id) => `url("${LAYERS[id].tiles[0].replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y))}")`)
    .join(", ");
}

export class BasemapControl implements maplibregl.IControl {
  private map?: maplibregl.Map;
  private current = savedBasemap();
  private readonly container = document.createElement("div");
  private readonly toggle = document.createElement("button");
  private readonly menu = document.createElement("div");
  private readonly closeOnOutsideClick = (event: MouseEvent) => {
    if (!this.container.contains(event.target as Node)) this.setOpen(false);
  };

  /** `onChange` runs after a switch, once the new base map's layers exist. */
  constructor(private readonly onChange?: (basemap: Basemap) => void) {
    this.container.className = "maplibregl-ctrl basemap-ctrl";
    this.toggle.type = "button";
    this.toggle.className = "basemap-card basemap-toggle";
    this.toggle.title = "Change base map";
    this.toggle.addEventListener("click", () => this.setOpen(this.menu.hidden === true));
    this.menu.className = "basemap-menu";
    this.menu.hidden = true;
    for (const basemap of BASEMAPS) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "basemap-card";
      option.dataset.basemap = basemap.id;
      option.append(this.card(basemap));
      option.addEventListener("click", () => {
        this.select(basemap.id);
        this.setOpen(false);
      });
      this.menu.appendChild(option);
    }
    this.container.append(this.toggle, this.menu);
    this.container.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.setOpen(false);
    });
    this.render();
  }

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;
    document.addEventListener("click", this.closeOnOutsideClick);
    return this.container;
  }

  onRemove(): void {
    document.removeEventListener("click", this.closeOnOutsideClick);
    this.container.remove();
    this.map = undefined;
  }

  select(id: string): void {
    const basemap = BASEMAPS.find((b) => b.id === id);
    const map = this.map;
    if (!basemap || !map) return;
    // Base map layers always sit under everything else (models, overlays).
    const firstOverlay = map.getLayersOrder().find((layerId) => !(layerId in LAYERS));
    for (const layerId of basemap.layers) {
      if (map.getLayer(layerId)) continue;
      if (!map.getSource(layerId)) map.addSource(layerId, source(layerId));
      map.addLayer({ id: layerId, type: "raster", source: layerId }, firstOverlay);
    }
    for (const layerId of BASEMAP_LAYER_IDS) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", basemap.layers.includes(layerId) ? "visible" : "none");
    }
    this.current = basemap;
    try {
      localStorage.setItem(STORAGE_KEY, basemap.id);
    } catch {
      // Not remembering the choice is fine.
    }
    this.render();
    this.onChange?.(basemap);
  }

  private card(basemap: Basemap): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const thumb = document.createElement("span");
    thumb.className = "basemap-thumb";
    thumb.style.backgroundImage = thumbnail(basemap);
    const label = document.createElement("span");
    label.className = "basemap-label";
    label.textContent = basemap.label;
    fragment.append(thumb, label);
    return fragment;
  }

  private render(): void {
    this.toggle.replaceChildren(this.card(this.current));
    this.toggle.setAttribute("aria-label", `Base map: ${this.current.label}. Change base map`);
    for (const option of this.menu.querySelectorAll<HTMLButtonElement>("button")) {
      const active = option.dataset.basemap === this.current.id;
      option.classList.toggle("active", active);
      option.setAttribute("aria-pressed", String(active));
    }
  }

  private setOpen(open: boolean): void {
    this.menu.hidden = !open;
    this.toggle.setAttribute("aria-expanded", String(open));
  }
}
