import type { LostItemKind, LostTier } from "../../../shared/lost-found";

// The lost and found pins' colours, kept apart from the drawing like the panda's: Relay's warm palette of
// russet, burnt orange, cream and chocolate, with bamboo green for wood and leaves.

/** Named colours the pins draw with. */
export const PIN = {
  white: "#fff",
  black: "#000",
  ink: "#45291d",
  cream: "#fcebd3",
  creamShade: "#efd8b8",
  russet: "#b94b19",
  russetDark: "#963b12",
  orange: "#e96b28",
  orangeShade: "#c4581f",
  brass: "#f0b43c",
  brassShade: "#c98a1e",
  brassLight: "#f9d77c",
  wood: "#8a5a2b",
  woodDark: "#6b4421",
  woodLight: "#a8743f",
  bamboo: "#9fb060",
  bambooShade: "#788d45",
  bambooDark: "#53683d",
  bambooPale: "#dbe3b0",
  glass: "#e9f3f1",
  sand: "#e9a04a",
  sandShade: "#cf8330",
  sweat: "#a9dcee",
  teal: "#2c6e68",
  tealDeep: "#21564f",
  tealLight: "#3f8a80",
  track: "#c4572a",
  trackDeep: "#a8461f",
  sky: "#fcebd3",
  skyWarm: "#f6d3ab",
  chocolate: "#5a3524",
  chocolateRay: "#73472f",
  forest: "#f2e4c4",
  forestStalk: "#d9e1ad",
  slate: "#3f5f7a",
  slateDeep: "#33506a",
  slateLine: "#557895",
  sage: "#c3cd8c",
  sageDeep: "#adb877",
  peach: "#f4c7a1",
  peachDeep: "#eab084",
  road: "#cfc2ad",
  roadDeep: "#b9aa92",
  tyre: "#4a3a30",
  tread: "#66544a",
  hub: "#bdb6ad",
  hubEdge: "#8d857b",
  bolt: "#7d756b",
  web: "#efe7da",
  midnight: "#2c3557",
  midnightDeep: "#1f2744",
  moonlight: "#f6d67a",
  dawn: "#f3b27a",
  dawnDeep: "#ec9a5f",
  sun: "#fde7b0",
  sunGlow: "#f9cd8c",
  tea: "#b5401f",
  teaShade: "#8e2f15",
  saucerShade: "#c9ad86",
  parcel: "#c99a62",
  parcelShade: "#a97d4b",
  twine: "#7a5a36",
  sealField: "#dcd3c6",
  sealInk: "#9a8f80",
} as const;

/** Rim metal per finish: face, inner edge and highlight. */
export const METALS: Record<
  LostTier,
  { face: string; edge: string; light: string }
> = {
  bronze: { face: "#c27a45", edge: "#7c4523", light: "#e6ad7c" },
  silver: { face: "#c4ccd5", edge: "#6f7a87", light: "#f1f4f7" },
  gold: { face: "#e8b641", edge: "#93650f", light: "#fde48c" },
};

/** The ribbon tails under silver and gold pins: face and fold. */
export const RIBBONS: Record<"silver" | "gold", [string, string]> = {
  silver: ["#5f7d97", "#465f75"],
  gold: ["#c2362b", "#902721"],
};

/** The scene's sky behind each panda, chosen so neighbours on a shelf differ. */
export const FIELDS: Record<LostItemKind, string> = {
  hourglass: PIN.teal,
  baton: PIN.track,
  boomerang: PIN.sky,
  trophy: PIN.chocolate,
  scroll: PIN.bambooShade,
  tally: PIN.forest,
  compass: PIN.slate,
  scarf: PIN.sage,
  clocks: PIN.peach,
  spare: PIN.road,
  feather: PIN.midnight,
  teaglass: PIN.dawn,
};

/** Account colours when the pin has none to show (a removed account, a locked pin). */
export const TINT_FALLBACKS = ["#f58a52", "#5cb8a0", "#e6b84c"];

/** The app's card colours in light and dark mode, for the review sheet. */
export const SHEET_CARDS = [
  { bg: "#ffffff", fg: "#19232f" },
  { bg: "#2b2622", fg: "#f3ece4" },
];
