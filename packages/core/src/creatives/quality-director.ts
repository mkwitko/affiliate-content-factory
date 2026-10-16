/**
 * QA v2 (owner brief 2026-10-08, sections 19, 21, 22): one verdict per quality dimension of a
 * package, on the PASS < WARN < REVIEW < BLOCK scale, and the repair each finding calls for.
 * Advisory: it reads what the gates already stored (scene fidelity, slide legibility, carousel
 * sequence, Reel checks) and never approves or blocks by itself; approval stays fail-closed on
 * the gates.
 */
export const QA_LEVELS = ["PASS", "WARN", "REVIEW", "BLOCK"] as const;
export type QaLevel = (typeof QA_LEVELS)[number];
export type QaDimension = "product" | "legibility" | "sequence" | "audio" | "render";
export type RepairAction =
  | "redraw_scene"
  | "composite_product"
  | "redraw_duplicate_scene"
  | "relayout_text"
  | "rewrite_copy"
  | "reorder_slides"
  | "add_licensed_music"
  | "record_music_licence"
  | "regenerate_voice"
  | "owner_review";
export type QaFinding = Readonly<{
  dimension: QaDimension;
  level: QaLevel;
  reason: string;
  repair: RepairAction;
}>;
export type QualityDirection = Readonly<{
  level: QaLevel;
  dimensions: Readonly<Record<QaDimension, QaLevel>>;
  findings: readonly QaFinding[];
}>;

export type QualityDirectorInput = Readonly<{
  render?: Readonly<{
    state: string;
    reason?: string | null;
    /** Scene fidelity verdict: pass | warn | review | block. */
    fidelity?: string | null;
    /** Slide legibility verdict: pass | warn | block. */
    quality?: string | null;
    sequence?: readonly string[];
  }> | null;
  reel?: Readonly<{
    checks: readonly Readonly<{ id: string; verdict: string; detail?: string | null }>[];
    /** ASR narration check verdict, when a home machine ran it. */
    narration?: string | null;
  }> | null;
}>;

const rank = (level: QaLevel) => QA_LEVELS.indexOf(level);
const worst = (levels: readonly QaLevel[]): QaLevel =>
  levels.reduce<QaLevel>((a, b) => (rank(b) > rank(a) ? b : a), "PASS");
const levelOf = (verdict: string | null | undefined): QaLevel | null =>
  verdict === "block"
    ? "BLOCK"
    : verdict === "review"
      ? "REVIEW"
      : verdict === "warn"
        ? "WARN"
        : verdict === "pass"
          ? "PASS"
          : null;
/** Same reasons as offer-scenes `productFailed`: the drawn product is wrong. */
const PRODUCT_WRONG =
  /(product_differs_from_reference|colour_mismatch|count_mismatch|invented_text_or_logo)/;

const AUDIO_CHECKS: ReadonlySet<string> = new Set(["audio_stream", "loudness", "true_peak"]);
const SEQUENCE_REPAIR: Readonly<Record<string, readonly [QaLevel, RepairAction]>> = {
  duplicate_scene: ["BLOCK", "redraw_duplicate_scene"],
  duplicate_headline: ["WARN", "rewrite_copy"],
  cover_not_hero: ["WARN", "reorder_slides"],
  cta_not_last: ["WARN", "reorder_slides"],
  same_framing_run: ["WARN", "redraw_scene"],
};

export const directQuality = (input: QualityDirectorInput): QualityDirection => {
  const findings: QaFinding[] = [];
  const add = (dimension: QaDimension, level: QaLevel, reason: string, repair: RepairAction) =>
    findings.push({ dimension, level, reason, repair });
  const render = input.render;
  if (render) {
    if (render.state === "failed")
      add("render", "BLOCK", render.reason ?? "render_failed", "owner_review");
    const reason = render.reason ?? "";
    // Partial or whole cut-out fallback: the scene plan was not met for some slots.
    if (render.state !== "failed" && /in_scene_partial|attempts_exhausted/.test(reason))
      add(
        "product",
        "WARN",
        reason,
        PRODUCT_WRONG.test(reason) ? "composite_product" : "redraw_scene",
      );
    const fidelity = levelOf(render.fidelity);
    if (fidelity && fidelity !== "PASS")
      add(
        "product",
        fidelity,
        `fidelity_${render.fidelity}`,
        fidelity === "BLOCK" ? "composite_product" : "owner_review",
      );
    const legibility = levelOf(render.quality);
    if (legibility && legibility !== "PASS")
      add("legibility", legibility, `slide_quality_${render.quality}`, "relayout_text");
    for (const entry of render.sequence ?? []) {
      const [level, repair] = SEQUENCE_REPAIR[entry.split(":")[0] ?? ""] ?? [
        "WARN",
        "owner_review",
      ];
      add("sequence", level, entry, repair);
    }
  }
  for (const check of input.reel?.checks ?? []) {
    const level = levelOf(check.verdict);
    if (!level || level === "PASS") continue;
    const reason = check.detail ? `${check.id}:${check.detail}` : check.id;
    if (check.id === "music")
      add(
        "audio",
        level,
        reason,
        /licence not recorded/.test(check.detail ?? "")
          ? "record_music_licence"
          : "add_licensed_music",
      );
    else if (AUDIO_CHECKS.has(check.id)) add("audio", level, reason, "owner_review");
    else add("render", level, reason, "owner_review");
  }
  const narration = levelOf(input.reel?.narration);
  if (narration && narration !== "PASS")
    add("audio", narration, `narration_${input.reel?.narration}`, "regenerate_voice");
  const dimensions = Object.fromEntries(
    (["product", "legibility", "sequence", "audio", "render"] as const).map((dimension) => [
      dimension,
      worst(findings.filter((f) => f.dimension === dimension).map((f) => f.level)),
    ]),
  ) as Record<QaDimension, QaLevel>;
  return {
    level: worst(findings.map((f) => f.level)),
    dimensions,
    findings: [...findings].sort((a, b) => rank(b.level) - rank(a.level)),
  };
};
