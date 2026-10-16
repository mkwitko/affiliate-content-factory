import { describe, expect, it } from "vitest";
import { createMcpServer, type McpDependencies } from "./server.js";

/** JSON Schema shapes ChatGPT's connector refresh rejects ("Invalid MCP tool schema"). */
const unsupported = (node: unknown, path: string, found: string[]): string[] => {
  if (!node || typeof node !== "object") return found;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.items)) found.push(`${path}: tuple items`);
  if ("propertyNames" in record) found.push(`${path}: propertyNames`);
  for (const [key, value] of Object.entries(record)) unsupported(value, `${path}/${key}`, found);
  return found;
};

describe("MCP tool schemas", () => {
  it("use no tuple items or propertyNames, so ChatGPT accepts every tool", async () => {
    const server = createMcpServer({
      authenticate: async () => null,
    } as unknown as McpDependencies);
    const listed = (await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })) as unknown as {
      result: { tools: { name: string; inputSchema: unknown }[] };
    };
    expect(listed.result.tools.length).toBeGreaterThan(50);
    const problems = listed.result.tools.flatMap((tool) =>
      unsupported(tool.inputSchema, tool.name, []),
    );
    expect(problems).toEqual([]);
  });
});
