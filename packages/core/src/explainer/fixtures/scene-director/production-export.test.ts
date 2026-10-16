import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import { directionInputFor } from "../../../content/direction-input.js";
import { type ContentScript, createContentScript } from "../../../content/editorial.js";
import type { Niche } from "../../../niches/niche.js";
import { OFFICE_LOCATION } from "../cast/location-fixture.js";
import { fixtureInput } from "./fixtures.js";
import { exportProductionFixtures, type ProductionExportDeps } from "./production-export.js";

const ws = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const other = parseWorkspaceId("33333333-3333-4333-8333-333333333333");
const actorId = parseUserId("22222222-2222-4222-8222-222222222222");
const body =
  "Sua conta de luz subiu 30% e ninguém mexeu em nada. A geladeira velha puxa mais energia. Troque a borracha da porta e ela volta ao normal.";

const approved = (
  id: string,
  over: Partial<{ item: string; version: number; at: number; workspaceId: typeof ws }> = {},
): ContentScript => {
  const script = createContentScript({
    id,
    workspaceId: over.workspaceId ?? ws,
    contentItemId: over.item ?? `item-${id}`,
    version: over.version ?? 1,
    body,
    language: "pt-BR",
    claims: [
      {
        text: "A conta subiu 30%.",
        kind: "verified_fact",
        evidence: [{ kind: "research_observation", observationId: "obs-1" }],
      },
      {
        text: "A borracha resolve.",
        kind: "reasonable_simplification",
        note: "Nem sempre.",
        evidence: [],
      },
    ],
    beats: [
      { kind: "hook", atChar: 0, label: "number_proof" },
      { kind: "payoff", atChar: body.indexOf("Troque") },
    ],
    actorId,
  });
  return {
    ...script,
    status: "approved",
    approvedChecksum: script.checksum,
    approvedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, over.at ?? 0)),
  };
};

const character = (key: string, role: "main" | "secondary") => ({
  key,
  name: key,
  role,
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
});
const media = (id: string, over: Partial<Niche> = {}): Niche => ({
  id,
  workspaceId: ws,
  name: id,
  audience: "a",
  problem: "p",
  editorialVoice: "v",
  languages: ["pt-BR"],
  monetizationHypothesis: "m",
  state: "active",
  kind: "media",
  context: {
    voiceId: "pf_dora",
    characters: [character("lia", "main"), character("teo", "secondary")],
    explainer: {
      locations: [{ ...OFFICE_LOCATION, plate: { assetId: "plate-1", overscan: 1.2 } }],
    },
  },
  ...over,
});

/** Fakes that record every call, so a test can prove the export only reads. */
const fakes = (
  scripts: readonly ContentScript[],
  itemNiche: Readonly<Record<string, string | null>>,
  niches: readonly Niche[],
) => {
  const calls: string[] = [];
  const deps: ProductionExportDeps = {
    scripts: {
      listApprovedScripts: async (input) => {
        calls.push(`listApprovedScripts:${input.workspaceId}`);
        return scripts;
      },
    },
    content: {
      findContentItemForWorkspace: async (input) => {
        calls.push(`findContentItemForWorkspace:${input.workspaceId}`);
        const nicheId = itemNiche[input.contentItemId];
        return nicheId ? ({ id: input.contentItemId, nicheId } as never) : null;
      },
    },
    niches: {
      findForWorkspace: async (input) => {
        calls.push(`findForWorkspace:${input.workspaceId}`);
        return niches.find((niche) => niche.id === input.nicheId) ?? null;
      },
    },
  };
  return { deps, calls };
};

const run = (deps: ProductionExportDeps, limit = 20) =>
  exportProductionFixtures(deps, { workspaceId: ws, limit, generatedAt: new Date(0) });

describe("exportProductionFixtures", () => {
  it("copies the approved script verbatim and rebuilds the production director input", async () => {
    const script = approved("s1");
    const niche = media("n1");
    const { deps } = fakes([script], { "item-s1": "n1" }, [niche]);
    const { file, report } = await run(deps);
    const [fixture] = file.fixtures;
    expect(report.exportedCount).toBe(1);
    expect(fixture).toMatchObject({
      id: "s1",
      source: "production:s1",
      case: "approved",
      body: script.body,
      language: script.language,
      claims: script.claims,
      beats: script.beats,
      cast: ["lia", "teo"],
      expected: { validator: "pass" },
    });
    expect(fixture).not.toHaveProperty("class");
    const production = directionInputFor(script, niche);
    if (!production.ok || !fixture) throw new Error("expected an input");
    const rebuilt = fixtureInput(file, fixture);
    expect(rebuilt.persona).toEqual(production.input.persona);
    expect(rebuilt.locations).toEqual(production.input.locations);
    expect(rebuilt.locations?.[0]?.plate).toEqual({ overscan: 1.2 });
    expect(rebuilt.script.claims).toEqual(script.claims);
    expect(rebuilt.script.beats).toEqual(script.beats);
  });

  it("only reads, and only in the requested workspace", async () => {
    const { deps, calls } = fakes(
      [approved("s1"), approved("s2", { workspaceId: other })],
      { "item-s1": "n1", "item-s2": "n1" },
      [media("n1")],
    );
    const { report } = await run(deps);
    expect(report.exported.map((entry) => entry.scriptId)).toEqual(["s1"]);
    expect(report.candidateCount).toBe(1);
    expect(calls.every((call) => call.endsWith(`:${ws}`))).toBe(true);
    expect(new Set(calls.map((call) => call.split(":")[0]))).toEqual(
      new Set(["listApprovedScripts", "findContentItemForWorkspace", "findForWorkspace"]),
    );
  });

  it("exports only approved scripts whose approval matches the current checksum", async () => {
    const draft = { ...approved("s1"), status: "draft" as const };
    const tampered = { ...approved("s2"), approvedChecksum: "0".repeat(64) };
    const { deps } = fakes(
      [draft, tampered, approved("s3")],
      { "item-s2": "n1", "item-s3": "n1" },
      [media("n1")],
    );
    const { report } = await run(deps);
    expect(report.exported.map((entry) => entry.scriptId)).toEqual(["s3"]);
    expect(report.skipped).toEqual([{ scriptId: "s2", reason: "checksum_mismatch" }]);
  });

  it("skips what production would not direct, with a reason, instead of inventing context", async () => {
    const affiliate = media("n2", { kind: "affiliate" as Niche["kind"], context: {} });
    const noVoice = media("n3", { context: { characters: [character("lia", "main")] } });
    const { deps } = fakes(
      [
        approved("old", { item: "item-a", version: 1 }),
        approved("new", { item: "item-a", version: 2 }),
        approved("lost"),
        approved("orphan"),
        approved("shop"),
        approved("mute"),
      ],
      {
        "item-a": "n1",
        "item-lost": null,
        "item-orphan": "gone",
        "item-shop": "n2",
        "item-mute": "n3",
      },
      [media("n1"), affiliate, noVoice],
    );
    const { report } = await run(deps);
    expect(report.exported.map((entry) => entry.scriptId)).toEqual(["new"]);
    expect(report.skipped).toEqual([
      { scriptId: "lost", reason: "content_item_missing" },
      { scriptId: "mute", reason: "voice_invalid" },
      { scriptId: "old", reason: "superseded_version" },
      { scriptId: "orphan", reason: "niche_missing" },
      { scriptId: "shop", reason: "niche_kind_mismatch" },
    ]);
  });

  it("selects deterministically: niches round-robin, newest approval first, then the limit", async () => {
    const scripts = [
      approved("a1", { at: 1 }),
      approved("a2", { at: 2 }),
      approved("a3", { at: 3 }),
      approved("b1", { at: 1 }),
    ];
    const items = { "item-a1": "na", "item-a2": "na", "item-a3": "na", "item-b1": "nb" };
    const niches = [media("na"), media("nb")];
    const first = await run(fakes(scripts, items, niches).deps, 3);
    const second = await run(fakes(scripts.toReversed(), items, niches).deps, 3);
    expect(first.report.exported.map((entry) => entry.scriptId)).toEqual(["a3", "b1", "a2"]);
    expect(first.file).toEqual(second.file);
    expect(first.report).toEqual(second.report);
    expect(first.report.skipped).toEqual([{ scriptId: "a1", reason: "over_limit" }]);
    expect(first.file.fixtures).toHaveLength(3);
  });
});
