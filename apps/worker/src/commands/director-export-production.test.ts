import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { createContentScript } from "@money-maker/core/content/editorial";
import type { ProductionExportDeps } from "@money-maker/core/explainer/fixtures/scene-director/production-export";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_OUT,
  parseExportArgs,
  runProductionExport,
} from "./director-export-production.js";

const ws = "11111111-1111-4111-8111-111111111111";
const body = "A geladeira gasta mais à noite. A borracha da porta vaza o frio. Troque a borracha.";
const script = (() => {
  const draft = createContentScript({
    id: "s1",
    workspaceId: parseWorkspaceId(ws),
    contentItemId: "item-1",
    version: 1,
    body,
    language: "pt-BR",
    claims: [],
    beats: [
      { kind: "hook", atChar: 0, label: "everyday_mystery" },
      { kind: "payoff", atChar: body.indexOf("Troque") },
    ],
    actorId: parseUserId("22222222-2222-4222-8222-222222222222"),
  });
  return { ...draft, status: "approved" as const, approvedChecksum: draft.checksum };
})();
const deps = (
  scripts: readonly (typeof script)[],
  kind: "media" | "affiliate" = "media",
): ProductionExportDeps => ({
  scripts: { listApprovedScripts: async () => scripts },
  content: { findContentItemForWorkspace: async () => ({ id: "item-1", nicheId: "n1" }) as never },
  niches: {
    findForWorkspace: async () =>
      ({
        id: "n1",
        kind,
        context: {
          voiceId: "pf_dora",
          characters: [
            {
              key: "lia",
              name: "Lia",
              role: "main",
              rigId: "stick-v1",
              rigVersion: 1,
              palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
            },
          ],
        },
      }) as never,
  },
});
const recorder = () => {
  const files = new Map<string, string>();
  return { files, write: async (path: string, data: string) => void files.set(path, data) };
};

describe("parseExportArgs", () => {
  it("defaults the limit and the output path and accepts a leading --", () => {
    expect(parseExportArgs(["--", "--workspace", ws])).toEqual({
      workspaceId: ws,
      limit: 20,
      out: DEFAULT_EXPORT_OUT,
    });
    expect(parseExportArgs(["--workspace", ws, "--limit", "5", "--out", "x/f.json"])).toMatchObject(
      {
        limit: 5,
        out: "x/f.json",
      },
    );
  });

  it("rejects a missing or invalid workspace and invalid arguments with a clear message", () => {
    expect(() => parseExportArgs([])).toThrow(/usage/);
    expect(() => parseExportArgs(["--workspace", "nope"])).toThrow(/invalid --workspace/);
    expect(() => parseExportArgs(["--workspace", ws, "--limit", "0"])).toThrow(/invalid --limit/);
    expect(() => parseExportArgs(["--workspace", ws, "--limit", "2.5"])).toThrow(/invalid --limit/);
    expect(() => parseExportArgs(["--workspace", ws, "--bogus", "1"])).toThrow(/usage/);
    expect(() => parseExportArgs(["--workspace"])).toThrow(/usage/);
  });
});

describe("runProductionExport", () => {
  const args = parseExportArgs(["--workspace", ws, "--out", "out/holdout/fixtures.json"]);

  it("writes the fixtures and the report next to them", async () => {
    const { files, write } = recorder();
    await runProductionExport(deps([script]), args, write, new Date(0));
    const fixtures = JSON.parse(files.get("out/holdout/fixtures.json") ?? "{}");
    const report = JSON.parse(files.get("out/holdout/production-export-report.json") ?? "{}");
    expect(fixtures.fixtures[0]).toMatchObject({ source: "production:s1", body, cast: ["lia"] });
    expect(report).toMatchObject({
      workspaceId: ws,
      generatedAt: "1970-01-01T00:00:00.000Z",
      requestedLimit: 20,
      candidateCount: 1,
      exportedCount: 1,
      skipped: [],
    });
    expect(JSON.stringify(report)).not.toMatch(/https?:|token|secret/i);
  });

  it("fails clearly with zero approved scripts and writes nothing", async () => {
    const { files, write } = recorder();
    await expect(runProductionExport(deps([]), args, write, new Date(0))).rejects.toThrow(
      /no approved scripts in workspace/,
    );
    expect(files.size).toBe(0);
  });

  it("writes only the report when no approved script can be exported", async () => {
    const { files, write } = recorder();
    await expect(
      runProductionExport(deps([script], "affiliate"), args, write, new Date(0)),
    ).rejects.toThrow(/no exportable scripts/);
    expect([...files.keys()]).toEqual(["out/holdout/production-export-report.json"]);
    expect(
      JSON.parse(files.get("out/holdout/production-export-report.json") ?? "{}").skipped,
    ).toEqual([{ scriptId: "s1", reason: "niche_kind_mismatch" }]);
  });
});
