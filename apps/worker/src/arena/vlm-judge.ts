import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { championFor, profileIdOf } from "@money-maker/core/arena/catalog";
import {
  judgmentsFromAnswer,
  parsePairwiseJudgeAnswer,
} from "@money-maker/core/arena/pairwise-judge";
import {
  PLATE_CHECK_PROMPT,
  parsePlateCheck,
  plateCheckJsonSchema,
} from "@money-maker/core/arena/plate-check";
import type { PairwiseJudgment } from "@money-maker/core/arena/ranking";
import {
  judgeInSceneFidelity,
  parseReferenceAnswer,
  parseVlmFidelityAnswer,
  productVisualSpecFor,
  type ReferenceCheck,
} from "@money-maker/core/creatives/in-scene-fidelity";
import { fitImage } from "@money-maker/providers/http/fit-image";
import {
  createLlamaServerFidelityVlm,
  type FidelityVlmImage,
} from "@money-maker/providers/llm/llama-server-fidelity-vlm";
import { createLlamaServerPairwiseJudge } from "@money-maker/providers/llm/llama-server-pairwise-judge";
import { createLlamaServerVisionJson } from "@money-maker/providers/llm/llama-server-vision-json";
import { colourEvidence } from "@money-maker/providers/media/sharp-colour-evidence";
import { type ArenaEnv, downloadFile } from "./runtime.js";
import { startLlama } from "./servers.js";

/**
 * The fixed visual judge of the image, plate and video arenas: the vision champion (Qwen3-VL 4B)
 * on llama-server. Product fidelity uses the production gate (VLM + colour evidence); plates use
 * a three-question check; quality uses the blind pairwise judge in both display orders.
 */
export const readImage = async (file: string): Promise<FidelityVlmImage> => {
  const bytes = new Uint8Array(await readFile(file));
  return { bytes, mimeType: (await fitImage(bytes)).mimeType };
};

/** Where the approved scenes and their reference photos live (`desktop.sh cenas` output). */
export const scenesDir = (env: ArenaEnv) =>
  process.env.ARENA_SCENES ?? join(env.repoRoot, "edit-bench-out");

export type VlmJudge = Readonly<{
  /** 1 pass, 0.5 needs review, 0 blocked; null when the VLM gave no usable answer. */
  productFidelity(
    scene: FidelityVlmImage,
    reference: FidelityVlmImage,
    title: string,
  ): Promise<number | null>;
  /** Fidelity plus the VLM's people count (null when not answered); null without a usable answer. */
  sceneCheck(
    scene: FidelityVlmImage,
    reference: FidelityVlmImage,
    title: string,
  ): Promise<Readonly<{
    fidelity: number;
    peopleCount: number | null;
    reasons: readonly string[];
    counts: Readonly<Record<string, number | null>>;
  }> | null>;
  plate(image: FidelityVlmImage): Promise<boolean | null>;
  /** Listing photo alone: clean single product? null without a usable answer (brief 11.1). */
  referenceCheck(photo: FidelityVlmImage, title: string): Promise<ReferenceCheck | null>;
  /** Raw structured question to the same model (probes and calibration only). */
  ask(input: {
    prompt: string;
    images: readonly FidelityVlmImage[];
    schemaName: string;
    schema: unknown;
  }): Promise<unknown>;
  pairwise(input: {
    caseId: string;
    brief: string;
    references: readonly Readonly<{ kind: "product" | "character"; image: FidelityVlmImage }>[];
    left: Readonly<{ id: string; image: FidelityVlmImage }>;
    right: Readonly<{ id: string; image: FidelityVlmImage }>;
  }): Promise<readonly PairwiseJudgment[]>;
  stop(): Promise<void>;
}>;

export const startVlmJudge = async (env: ArenaEnv): Promise<VlmJudge> => {
  const judge = championFor("vision.product_verification");
  if (!judge) throw new Error("vision_champion_missing");
  for (const file of judge.files) await downloadFile(file.url, join(env.modelsDir, file.file));
  const server = await startLlama(env, judge);
  const model = profileIdOf(judge.id);
  const fidelity = createLlamaServerFidelityVlm({ baseUrl: server.baseUrl, model });
  const vision = createLlamaServerVisionJson({ baseUrl: server.baseUrl, model });
  const pairwise = createLlamaServerPairwiseJudge({ baseUrl: server.baseUrl, model });
  const sceneCheck: VlmJudge["sceneCheck"] = async (scene, reference, title) => {
    const spec = productVisualSpecFor(title);
    const answer = await fidelity
      .compare({ reference, scene, spec, offerTitle: title })
      .catch(() => null);
    const vlm = parseVlmFidelityAnswer(answer, spec) ?? undefined;
    if (!vlm) return null;
    const colour = await colourEvidence(reference.bytes, scene.bytes).catch(() => undefined);
    const { verdict, reasons } = judgeInSceneFidelity({
      spec,
      vlm,
      ...(colour ? { colour } : {}),
    });
    return {
      fidelity: verdict === "pass" ? 1 : verdict === "review" ? 0.5 : 0,
      peopleCount: vlm.peopleCount ?? null,
      reasons,
      counts: vlm.counts,
    };
  };
  return {
    productFidelity: async (scene, reference, title) =>
      (await sceneCheck(scene, reference, title))?.fidelity ?? null,
    sceneCheck,
    ask: (input) => vision.ask(input),
    referenceCheck: async (photo, title) =>
      parseReferenceAnswer(
        await fidelity.reference({ photo, offerTitle: title }).catch(() => null),
      ),
    async plate(image) {
      const raw = await vision
        .ask({
          prompt: PLATE_CHECK_PROMPT,
          images: [image],
          schemaName: "plate_check",
          schema: plateCheckJsonSchema,
        })
        .catch(() => null);
      return parsePlateCheck(raw)?.clean ?? null;
    },
    async pairwise({ caseId, brief, references, left, right }) {
      const judgments: PairwiseJudgment[] = [];
      for (const [a, b] of [
        [left, right],
        [right, left],
      ] as const) {
        const answer = parsePairwiseJudgeAnswer(
          await pairwise.judge({ brief, references, a: a.image, b: b.image }).catch(() => null),
        );
        if (answer)
          judgments.push(
            ...judgmentsFromAnswer(
              { caseId, left: a.id, right: b.id, judge: `vlm:${model}` },
              answer,
            ),
          );
      }
      return judgments;
    },
    stop: server.stop,
  };
};
