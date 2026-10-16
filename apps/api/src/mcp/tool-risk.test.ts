import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMcpServer, type McpDependencies } from "./server.js";
import { RISK_META_KEY, TOOL_RISK, type ToolRisk } from "./tool-risk.js";

type Listed = {
  name: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  _meta: Record<string, unknown>;
};

const listTools = async (): Promise<Listed[]> => {
  const server = createMcpServer({
    authenticate: async () => null,
    // Truthy stand-ins switch on the conditionally registered tools; none is called here.
    homeWorkerTokens: {},
    generationSettings: {},
    generationRoutes: {},
    designExporterForWorkspace: () => null,
    sceneDirectionAvailable: true,
  } as unknown as McpDependencies);
  const listed = (await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  })) as unknown as { result: { tools: Listed[] } };
  return listed.result.tools;
};

describe("tool risk metadata", () => {
  it("covers exactly the registered tools and publishes the class in _meta", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOL_RISK).sort());
    for (const tool of tools) expect(tool._meta[RISK_META_KEY]).toBe(TOOL_RISK[tool.name]);
  });

  it("keeps read tools read-only and non-destructive, and flags every high-risk tool", async () => {
    for (const tool of await listTools()) {
      const risk = TOOL_RISK[tool.name];
      if (risk === "read") {
        expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
        expect(tool.annotations.destructiveHint, tool.name).toBe(false);
      } else {
        expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
      }
      if (risk === "approval_required" || risk === "restricted") {
        expect(tool.annotations.destructiveHint, tool.name).toBe(true);
      }
    }
  });

  it("never lets publish, approval, rejection, cancellation or credential tools run unattended", () => {
    const gated = [
      "approve_content",
      "approve_content_script",
      "publish_content",
      "reject_content",
      "cancel_content",
      "record_manual_publication",
      "set_asset_rights",
      "create_home_worker_token",
      "revoke_home_worker_token",
      "create_provider_connection",
      "revoke_provider_connection",
      "connect_cloud_provider",
      "set_generation_budget",
      "create_invitation",
      "create_automation_policy",
      "revoke_automation_policy",
    ];
    for (const name of gated) {
      expect(["approval_required", "restricted"], name).toContain(TOOL_RISK[name]);
    }
  });

  it("matches the tables in docs/agents/paperclip-contract.md", () => {
    const doc = readFileSync(
      new URL("../../../../docs/agents/paperclip-contract.md", import.meta.url),
      "utf8",
    );
    const documented: Record<string, ToolRisk> = {};
    for (const match of doc.matchAll(
      /^\| `([a-z_0-9]+)` \| (read|safe_write|approval_required|restricted) \|/gm,
    )) {
      documented[match[1] as string] = match[2] as ToolRisk;
    }
    expect(documented).toEqual(TOOL_RISK);
  });
});
