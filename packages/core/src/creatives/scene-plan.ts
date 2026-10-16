export type ScenePlan = Readonly<{
  role: "hero" | "secondary";
  productAnchor: "left" | "center" | "right";
  surface: "table" | "shelf" | "counter" | "abstract";
  lighting: "top-left" | "top-right" | "soft-front";
  nicheSetting: string;
  paletteHint: string;
}>;

export const SCENE_PROMPT_VERSION = 2;

export const scenePrompt = (plan: ScenePlan): string => {
  const opposite = { left: "right", center: "both sides", right: "left" }[plan.productAnchor];
  return `close-up of an empty ${plan.surface} top, blurred ${plan.nicheSetting} behind, nothing on the surface, ${plan.lighting} soft light, clear flat area on the ${plan.productAnchor} for an object, large negative space ${opposite}, ${plan.paletteHint} tones, photographic, shallow depth of field, no product, no packaging, no text, no logo, no people`;
};

export const sceneKey = (nicheId: string, plan: ScenePlan): string =>
  `${nicheId}:${plan.role}:${plan.productAnchor}:${plan.surface}:v${SCENE_PROMPT_VERSION}`;
