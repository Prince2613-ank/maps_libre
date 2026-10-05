// Chair names and status rules copied from the Cesium app (cesium_demo/src/chairs.ts and ui.ts showChairPopup).

const THIRD_FLOOR_CHAIR_NAMES: Record<number, string> = {
  1: "Kush", 2: "Uthkarsh", 3: "Nitish", 4: "Sparsh", 5: "Nimit", 6: "Albin", 7: "Vikas", 8: "Shekhar",
  9: "Pratham", 10: "Jay", 11: "Desk Chair D", 12: "Desk Chair E", 13: "Harsh", 14: "Vikrant", 15: "Raghav",
  16: "Aniket", 17: "Manav", 18: "Pushkar", 19: "Astami", 20: "Carig", 21: "Anshika", 22: "Vanshika",
  23: "Kapil", 24: "Rohit", 26: "Unknown3", 27: "Prince", 28: "Samata", 29: "Payel", 30: "Akshay",
  31: "Aishwarya", 32: "unknown6", 33: "unknown7", 34: "unknown4"
};

const SECOND_FLOOR_CHAIR_NAMES: Record<number, string> = {
  1: "unknown1", 2: "Shuvankit", 3: "unknown2", 4: "Vidit", 5: "Diksha", 6: "Apoorva", 7: "unknown3",
  8: "unknown4", 9: "Kushi", 10: "Vishal", 11: "Rohit", 12: "Vibhu", 13: "Jiteswar", 14: "Swati",
  15: "Chair O", 16: "Chair P", 17: "Ankita", 18: "Himanshi"
};

export type ChairInfo = { name: string; index: number; floorLabel: string; available: boolean };

/** Chair details for a chair GLB file name, or null if the file is not a chair. */
export function chairInfo(file: string): ChairInfo | null {
  const second = /^final_2nd_floor_(\d+)\.glb$/.exec(file);
  const third = /^(\d+)\.glb$/.exec(file);
  if (!second && !third) return null;
  const index = Number((second ?? third)![1]);
  const name = (second ? SECOND_FLOOR_CHAIR_NAMES[index] ?? `2F Chair ${index}` : THIRD_FLOOR_CHAIR_NAMES[index] ?? `3F Chair ${index}`);
  return {
    name,
    index,
    floorLabel: second ? "2nd Floor" : "3rd Floor",
    // Cesium treats "unknown…" chairs as free seats.
    available: name.toLowerCase().startsWith("unknown")
  };
}
