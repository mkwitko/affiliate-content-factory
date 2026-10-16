import type { ExplainerCharacter } from "../../explainer-context.js";
import { BIBLE_CAST } from "./bible-cast.js";

/**
 * Sam, the Cost Curious main character (narration stays the niche voice; Sam's dialogue voice is
 * am_michael), plus Bia as the foil. A fixture for comparison benches; the niche context is
 * the source of truth in production.
 */
export const SAM: ExplainerCharacter = {
  key: "sam",
  name: "Sam",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
  wardrobe: {
    hair: { style: "short", colour: "#2b1d12" },
    top: { style: "hoodie", colour: "#2f6fdb" },
  },
  bible: {
    version: 1,
    role: "narrator",
    body: { archetype: "average", head: "circle", scale: 1 },
    voice: { voiceId: "am_michael" },
  },
};

export const COST_CURIOUS_CAST: readonly ExplainerCharacter[] = [
  SAM,
  ...BIBLE_CAST.filter((c) => c.key === "bia"),
];
