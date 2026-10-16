import {
  ambientLoopPrompt,
  EXPLAINER_ART_STYLES,
  EXPLAINER_BACKGROUND_PROMPT_VERSION,
  EXPLAINER_BACKGROUND_SIZE,
  type ExplainerArtStyle,
  explainerBackgroundPrompt,
} from "@money-maker/core/explainer/background-art";
import { BACKGROUNDS } from "@money-maker/core/explainer/backgrounds";

/**
 * The locked prompts for one niche style, as JSON for scripts/local-ai/background-batch.py, so
 * the prompt text has one source (core) and needs no database.
 */
export const explainerPrompts = (style: ExplainerArtStyle, paletteHint: string) => ({
  promptVersion: EXPLAINER_BACKGROUND_PROMPT_VERSION,
  style,
  size: EXPLAINER_BACKGROUND_SIZE,
  items: BACKGROUNDS.map((setting) => ({
    setting,
    prompt: explainerBackgroundPrompt({ setting, style, paletteHint }),
    loopPrompt: ambientLoopPrompt({ setting, style, paletteHint }),
  })),
});

if (process.argv[1]?.endsWith("explainer-prompts.js")) {
  const style = process.argv[2];
  if (!style || !(EXPLAINER_ART_STYLES as readonly string[]).includes(style)) {
    console.error(`Usage: explainer-prompts.js <${EXPLAINER_ART_STYLES.join("|")}> [paletteHint]`);
    process.exitCode = 1;
  } else
    console.log(
      JSON.stringify(
        explainerPrompts(style as ExplainerArtStyle, process.argv[3] ?? "warm neutral"),
        null,
        2,
      ),
    );
}
