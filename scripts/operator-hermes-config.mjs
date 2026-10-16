#!/usr/bin/env node
// Prints the Hermes `mcp_servers` block (URL + tool allowlist) for one operator profile.
// Usage: node scripts/operator-hermes-config.mjs <profile> [mcpUrl]
// Holds no credential: Hermes keeps its OAuth tokens in its own store after the first login.
import {
  hermesMcpConfig,
  OPERATOR_OAUTH_SCOPES,
  OPERATOR_PROFILE_IDS,
} from "../apps/api/dist/mcp/operator-profiles.js";

const [profile, mcpUrl = "https://mcp.example.com/mcp"] = process.argv.slice(2);
if (!OPERATOR_PROFILE_IDS.includes(profile)) {
  console.error(`usage: operator-hermes-config.mjs <${OPERATOR_PROFILE_IDS.join("|")}> [mcpUrl]`);
  process.exit(2);
}
process.stdout.write(
  `# profile ${profile}; OAuth scopes to grant: ${OPERATOR_OAUTH_SCOPES.join(" ")}\n`,
);
process.stdout.write(hermesMcpConfig(profile, mcpUrl));
