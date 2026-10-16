import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entrypoint = fileURLToPath(new URL("../dist/server.js", import.meta.url));

beforeAll(async () => {
  await promisify(execFile)("pnpm", ["--filter", "@money-maker/api...", "build"], { cwd: root });
}, 30_000);

const unusedPort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port available");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
};

describe("API executable startup", () => {
  it.each([undefined, "not-a-postgres-url-private-value"])(
    "fails closed with safe actionable configuration errors (%s)",
    async (databaseUrl) => {
      const env = { ...process.env };
      if (databaseUrl) env.DATABASE_URL = databaseUrl;
      else delete env.DATABASE_URL;
      const child = spawn(process.execPath, [entrypoint], { env });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const [code] = await once(child, "exit");
      expect(code).not.toBe(0);
      expect(stderr).toContain("Invalid environment configuration");
      expect(stderr).not.toContain("private-value");
      expect(stderr).not.toContain("at ");
    },
  );

  it("serves health from the real composition while rejecting forged identity headers", async () => {
    const port = await unusedPort();
    const child = spawn(process.execPath, [entrypoint], {
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
        PORT: String(port),
        SECRET_STORE_MASTER_KEY: Buffer.alloc(32).toString("base64url"),
      },
    });
    const exited = once(child, "exit");
    try {
      const deadline = Date.now() + 5_000;
      let health: Response | undefined;
      while (Date.now() < deadline && child.exitCode === null) {
        health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined);
        if (health) break;
        await setTimeout(25);
      }
      expect(health?.status).toBe(200);
      expect(await health?.json()).toEqual({ status: "ok", version: "1.0.0+dev" });
      const response = await fetch(`http://127.0.0.1:${port}/v1/invitations/forged/accept`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": "033bffd2-d9fb-4795-841d-6d83193a7707",
        },
        body: JSON.stringify({ email: "friend@example.test" }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Authentication required" },
      });
      child.kill("SIGTERM");
      const [code, signal] = await exited;
      expect(code).toBe(0);
      expect(signal).toBeNull();
    } finally {
      child.kill();
      await exited;
    }
  });
});
