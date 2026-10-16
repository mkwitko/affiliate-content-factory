import type { WorkspaceId } from "@money-maker/contracts";
import type { ContentRepository } from "../../../content/content-repository.js";
import { directionInputFor } from "../../../content/direction-input.js";
import type { ContentScript } from "../../../content/editorial.js";
import type { NicheRepository } from "../../../niches/niche-repository.js";
import {
  fixtureInput,
  type SceneDirectorFixture,
  type SceneDirectorFixtureFile,
} from "./fixtures.js";

/** Read-only sources the export needs; it never writes. */
export type ProductionExportDeps = Readonly<{
  scripts: Readonly<{
    listApprovedScripts(input: { workspaceId: WorkspaceId }): Promise<readonly ContentScript[]>;
  }>;
  content: Pick<ContentRepository, "findContentItemForWorkspace">;
  niches: Pick<NicheRepository, "findForWorkspace">;
}>;

export const EXPORT_SKIP_REASONS = [
  "checksum_mismatch",
  "superseded_version",
  "content_item_missing",
  "niche_missing",
  "niche_kind_mismatch",
  "voice_invalid",
  "fixture_not_reproducible",
  "over_limit",
] as const;
export type ExportSkipReason = (typeof EXPORT_SKIP_REASONS)[number];

export type ProductionExportReport = Readonly<{
  workspaceId: string;
  generatedAt: string;
  requestedLimit: number;
  candidateCount: number;
  exportedCount: number;
  exported: readonly Readonly<{
    scriptId: string;
    contentItemId: string;
    version: number;
    nicheId: string;
  }>[];
  skipped: readonly Readonly<{ scriptId: string; reason: ExportSkipReason }>[];
  selection: string;
}>;

const SELECTION =
  "latest approved version per content item; niches taken round-robin in niche id order, each " +
  "niche newest approval first (ties by script id); no other classification is inferred";

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Turns approved production scripts into director holdout fixtures that rebuild exactly the
 * input production sends (directionInputFor): copy, claims and beats verbatim, the niche cast and
 * locations, `expected` only `{ validator: "pass" }`. Scripts production would not direct are
 * skipped with a reason, never patched.
 */
export const exportProductionFixtures = async (
  deps: ProductionExportDeps,
  options: Readonly<{ workspaceId: WorkspaceId; limit: number; generatedAt: Date }>,
): Promise<Readonly<{ file: SceneDirectorFixtureFile; report: ProductionExportReport }>> => {
  const { workspaceId, limit } = options;
  const candidates = (await deps.scripts.listApprovedScripts({ workspaceId }))
    .filter((script) => script.workspaceId === workspaceId && script.status === "approved")
    .slice()
    .sort(
      (a, b) =>
        byText(a.contentItemId, b.contentItemId) || b.version - a.version || byText(a.id, b.id),
    );
  const skipped: { scriptId: string; reason: ExportSkipReason }[] = [];
  const eligible: { script: ContentScript; nicheId: string; fixture: SceneDirectorFixture }[] = [];
  const items = new Set<string>();
  for (const script of candidates) {
    const skip = (reason: ExportSkipReason) => void skipped.push({ scriptId: script.id, reason });
    if (script.approvedChecksum !== script.checksum) {
      skip("checksum_mismatch");
      continue;
    }
    if (items.has(script.contentItemId)) {
      skip("superseded_version");
      continue;
    }
    items.add(script.contentItemId);
    const item = await deps.content.findContentItemForWorkspace({
      workspaceId,
      contentItemId: script.contentItemId,
    });
    if (!item) {
      skip("content_item_missing");
      continue;
    }
    const niche = await deps.niches.findForWorkspace({ workspaceId, nicheId: item.nicheId });
    if (!niche) {
      skip("niche_missing");
      continue;
    }
    const prepared = directionInputFor(script, niche);
    if (!prepared.ok) {
      skip(prepared.reason);
      continue;
    }
    const { persona, locations = [] } = prepared.input;
    const fixture: SceneDirectorFixture = {
      id: script.id,
      case: "approved",
      source: `production:${script.id}`,
      language: script.language,
      body: script.body,
      claims: script.claims,
      beats: script.beats,
      cast: persona.map((character) => character.key),
      expected: { validator: "pass" },
      characters: persona,
      ...(locations.length ? { locations } : {}),
    };
    if (!reproduces(fixture, prepared.input)) {
      skip("fixture_not_reproducible");
      continue;
    }
    eligible.push({ script, nicheId: item.nicheId, fixture });
  }
  const byNiche = new Map<string, typeof eligible>();
  for (const entry of eligible)
    byNiche.set(entry.nicheId, [...(byNiche.get(entry.nicheId) ?? []), entry]);
  const queues = [...byNiche.entries()]
    .slice()
    .sort(([a], [b]) => byText(a, b))
    .map(([, entries]) =>
      entries
        .slice()
        .sort(
          (a, b) =>
            (b.script.approvedAt?.getTime() ?? 0) - (a.script.approvedAt?.getTime() ?? 0) ||
            byText(a.script.id, b.script.id),
        ),
    );
  const ordered: typeof eligible = [];
  while (queues.some((queue) => queue.length))
    for (const queue of queues) {
      const next = queue.shift();
      if (next) ordered.push(next);
    }
  const chosen = ordered.slice(0, limit);
  for (const entry of ordered.slice(limit))
    skipped.push({ scriptId: entry.script.id, reason: "over_limit" });
  return {
    file: { split: "holdout", characters: [], fixtures: chosen.map((entry) => entry.fixture) },
    report: {
      workspaceId,
      generatedAt: options.generatedAt.toISOString(),
      requestedLimit: limit,
      candidateCount: candidates.length,
      exportedCount: chosen.length,
      exported: chosen.map(({ script, nicheId }) => ({
        scriptId: script.id,
        contentItemId: script.contentItemId,
        version: script.version,
        nicheId,
      })),
      skipped: skipped.slice().sort((a, b) => byText(a.scriptId, b.scriptId)),
      selection: SELECTION,
    },
  };
};

/** The fixture must rebuild the production input: same copy, claims, beats, cast and places. */
const reproduces = (
  fixture: SceneDirectorFixture,
  input: ReturnType<typeof fixtureInput>,
): boolean => {
  try {
    const rebuilt = fixtureInput(
      { split: "holdout", characters: [], fixtures: [fixture] },
      fixture,
    );
    const pick = (value: ReturnType<typeof fixtureInput>) =>
      JSON.stringify({
        body: value.script.body,
        language: value.script.language,
        claims: value.script.claims,
        beats: value.script.beats,
        persona: value.persona,
        locations: value.locations ?? [],
      });
    return pick(rebuilt) === pick(input);
  } catch {
    return false;
  }
};
