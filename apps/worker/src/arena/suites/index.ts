import type { ArenaTask } from "@money-maker/core/arena/catalog";
import type { Suite } from "../suite.js";
import { llmCopySuite } from "./llm.js";
import { asrSuite, ttsSuite } from "./speech.js";
import { imageEditSuite, plateSuite, upscaleSuite, videoSuite, visionSuite } from "./visual.js";

/** One suite per arena task; a task without a suite cannot run yet. */
export const ARENA_SUITES: Partial<Record<ArenaTask, Suite>> = {
  "tts.ptbr": ttsSuite,
  "asr.ptbr": asrSuite,
  "llm.offer_copy": llmCopySuite,
  "vision.product_verification": visionSuite,
  "image.character_product": imageEditSuite,
  "image.scene_plate": plateSuite,
  "upscale.illustration": upscaleSuite,
  "video.i2v": videoSuite,
};
