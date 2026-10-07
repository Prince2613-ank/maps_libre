import { ALT_1ST, ALT_2ND, ALT_3RD, ALT_GROUND, BASE_ALT } from "./placement";

/**
 * `maxTextureSize`: load the file's textures at no more than this many pixels (for very large textures).
 * `doubleSided`: draw both faces of every triangle (captured meshes whose faces come out inside-out here).
 */
export type ModelRef = { file: string; altitude: number; maxTextureSize?: number; doubleSided?: boolean };

export type ModelGroup = {
  id: string;
  label: string;
  models: ModelRef[];
};

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const at = (altitude: number, files: string[]): ModelRef[] => files.map((file) => ({ file, altitude }));

// Same files and altitudes the Cesium project loads (cesium_demo/src/models.ts, chairs.ts).
// Each floor layer includes that floor's cameras and chairs.
export const GROUPS: ModelGroup[] = [
  { id: "building", label: "Building exterior", models: at(BASE_ALT, ["Building_model.glb"]) },
  // Captured surroundings, shown together with the building exterior. The file is optimized (one copy of the
  // capture, WebP textures ≤ 2048², Meshopt); the texture limit guards against re-exports with 8192² textures,
  // which need ~1.9 GB of GPU memory and lose the WebGL context on many machines.
  { id: "outdoor", label: "Outdoor area", models: [{ file: "outdoor_model.glb", altitude: BASE_ALT, maxTextureSize: 2048, doubleSided: true }] },
  { id: "ground", label: "Ground floor", models: at(ALT_GROUND, ["ground_floor_final.glb"]) },
  { id: "first", label: "1st floor", models: at(ALT_1ST, ["1st_floor_up_final.glb"]) },
  {
    id: "second",
    label: "2nd floor",
    models: at(ALT_2ND, [
      "final_2nd_floor_without_chair_fast.glb",
      // cameras
      "2nd_cc1.glb", "2nd_cc2.glb", "2nd_cc3.glb", "2nd_cc4.glb", "2nd_cc5.glb", "2nd_cc6.glb",
      // chairs
      ...range(18).map((i) => `final_2nd_floor_${i}.glb`)
    ])
  },
  {
    id: "third",
    label: "3rd floor",
    models: at(ALT_3RD, [
      "3rd_floor_without_chairs.glb", "3rd_floor_piller.glb",
      // cameras
      "3rd_cc1.glb", "3rd_cc2.glb", "3rd_cc3.glb", "3rd_cc4.glb", "3rd_cc5.glb",
      "3rd_cc6.glb", "3rd_cc6 (1).glb", "3rd_cc_meeting_room.glb", "3rd_cc8.glb",
      // chairs (32 removed)
      ...range(34).filter((i) => i !== 32).map((i) => `${i}.glb`)
    ])
  }
];

/** `short` is the floor switcher's button text; "building" shows an icon instead. */
export type Preset = { id: string; label: string; short: string; groups: string[] };

// Bottom (outside) to top, as the floor switcher stacks them.
export const PRESETS: Preset[] = [
  { id: "building", label: "Building exterior + outdoor area", short: "", groups: ["building", "outdoor"] },
  { id: "ground", label: "Ground floor", short: "G", groups: ["ground"] },
  { id: "first", label: "1st floor", short: "1", groups: ["first"] },
  { id: "second", label: "2nd floor", short: "2", groups: ["second"] },
  { id: "third", label: "3rd floor", short: "3", groups: ["third"] }
];
