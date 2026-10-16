import type { ExplainerCharacter } from "../../explainer-context.js";

/**
 * A fixture cast of six with character bibles (v2 slice 19): the recurring alex, Bia, Rafa and
 * Carla plus an elder and a kid, as the silhouette test's calibration set. Values are a
 * PROPOSAL for the owner; the production niches are not changed by this file.
 */
const rig = { rigId: "stick-v1", rigVersion: 1 } as const;
export const BIBLE_CAST: readonly ExplainerCharacter[] = [
  {
    ...rig,
    key: "alex",
    name: "Alex",
    role: "main",
    palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
    wardrobe: {
      hair: { style: "short", colour: "#2b1d12" },
      top: { style: "hoodie", colour: "#2f6fdb" },
    },
    bible: {
      version: 1,
      role: "narrator",
      body: { archetype: "average", head: "circle", scale: 1 },
      want: "explain money without jargon",
      flaw: "overconfident with numbers",
      traits: ["curious", "patient", "dry humour"],
      tics: ["taps the phone", "raises one brow"],
      defaults: { enterFrom: "left", facing: "right" },
    },
  },
  {
    ...rig,
    key: "bia",
    name: "Bia",
    role: "secondary",
    accessory: "glasses",
    palette: { line: "#161616", fill: "#ffe9d6", accent: "#2f7de1" },
    wardrobe: {
      hair: { style: "long", colour: "#6b3e26" },
      bottoms: { style: "skirt", colour: "#3d405b" },
    },
    bible: {
      version: 1,
      role: "foil",
      body: { archetype: "lanky", head: "oval_tall", scale: 1.04, signature: "glasses" },
      want: "never overpay",
      flaw: "overthinks every purchase",
    },
  },
  {
    ...rig,
    key: "rafa",
    name: "Rafa",
    role: "secondary",
    accessory: "cap",
    palette: { line: "#161616", fill: "#ffffff", accent: "#2a9d8f" },
    wardrobe: {
      hair: { style: "curly", colour: "#111111" },
      top: { style: "tshirt", colour: "#e07a5f" },
    },
    bible: {
      version: 1,
      role: "rival",
      body: { archetype: "heavy", head: "square_round", scale: 1, signature: "cap" },
      want: "win every deal",
      flaw: "buys on impulse",
    },
  },
  {
    ...rig,
    key: "carla",
    name: "Carla",
    role: "secondary",
    accessory: "headphones",
    palette: { line: "#161616", fill: "#fff3e6", accent: "#e76f51" },
    wardrobe: {
      hair: { style: "bun", colour: "#3a2418" },
      top: { style: "shirt", colour: "#264653" },
    },
    bible: {
      version: 1,
      role: "mentor",
      body: { archetype: "tall_strong", head: "egg", scale: 1.08, signature: "headphones" },
      want: "get her friends out of debt",
      flaw: "impatient",
    },
  },
  {
    ...rig,
    key: "vo",
    name: "Vô Zé",
    role: "secondary",
    accessory: "tie",
    palette: { line: "#161616", fill: "#ffffff", accent: "#8d6e63" },
    wardrobe: { bottoms: { style: "pants", colour: "#5d4037" } },
    bible: {
      version: 1,
      role: "mentor",
      body: { archetype: "elder", head: "bean", scale: 0.96, signature: "tie" },
    },
  },
  {
    ...rig,
    key: "leo",
    name: "Léo",
    role: "secondary",
    palette: { line: "#161616", fill: "#ffffff", accent: "#f4a261" },
    wardrobe: {
      hair: { style: "short", colour: "#c68642" },
      head: "big",
      bottoms: { style: "shorts", colour: "#2a9d8f" },
    },
    bible: {
      version: 1,
      role: "kid",
      body: { archetype: "tiny", head: "oval_wide", scale: 0.82 },
    },
  },
];
