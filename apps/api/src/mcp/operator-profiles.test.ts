import { describe, expect, it } from "vitest";
import {
  hermesMcpConfig,
  OPERATOR_OAUTH_SCOPES,
  OPERATOR_PROFILE_IDS,
  OPERATOR_PROFILES,
  operatorProfileProblems,
} from "./operator-profiles.js";
import { TOOL_RISK } from "./tool-risk.js";

describe("operator profiles", () => {
  it.each(OPERATOR_PROFILE_IDS)("%s lists only known read or safe_write tools", (id) => {
    expect(operatorProfileProblems(id)).toEqual([]);
  });

  it("never lists approval, publication, policy or credential tools", () => {
    const listed = new Set(Object.values(OPERATOR_PROFILES).flat());
    for (const [tool, risk] of Object.entries(TOOL_RISK))
      if (risk === "approval_required" || risk === "restricted")
        expect(listed.has(tool)).toBe(false);
    for (const tool of ["approve_content", "publish_content", "submit_affiliate_links"])
      expect(listed.has(tool)).toBe(false);
  });

  it("gives the autonomy cycle to one profile only, so agents do not race it", () => {
    const holders = OPERATOR_PROFILE_IDS.filter((id) =>
      OPERATOR_PROFILES[id].includes("run_autonomy_cycle"),
    );
    expect(holders).toEqual(["content_producer"]);
  });

  it("requests no approval or publication OAuth scope", () => {
    expect(OPERATOR_OAUTH_SCOPES).not.toContain("content:approve");
    expect(OPERATOR_OAUTH_SCOPES).not.toContain("publish:write");
  });

  it("renders a Hermes allowlist without any credential", () => {
    const yaml = hermesMcpConfig("affiliate_scout", "https://mcp.example.com/mcp");
    expect(yaml).toContain('scope: "workspace:read content:read content:write offline_access"');
    expect(yaml).not.toContain("content:approve");
    expect(yaml).toContain('url: "https://mcp.example.com/mcp"');
    expect(yaml).toContain("auth: oauth");
    expect(yaml).toContain("- list_affiliate_link_queue");
    expect(yaml).not.toContain("submit_affiliate_links");
    // The OAuth client comes only by env reference; no literal credential is ever rendered.
    expect(yaml).toContain('client_secret: "${MM_AGENTS_OAUTH_CLIENT_SECRET}"');
    const withoutKeys = yaml
      .replace(/client_secret:/g, "")
      .replace(/"\$\{MM_AGENTS_OAUTH_CLIENT_[A-Z]+\}"/g, "");
    expect(withoutKeys).not.toMatch(/token|secret|password/i);
  });

  it("refuses a plain-http public MCP URL", () => {
    expect(() => hermesMcpConfig("content_producer", "http://mcp.example.com/mcp")).toThrow(
      "operator_mcp_url_not_https",
    );
  });
});
