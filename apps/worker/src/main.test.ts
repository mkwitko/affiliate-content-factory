import { describe, expect, it } from "vitest";
import { createPollingLoop } from "./main.js";

describe("createPollingLoop", () => {
  it("aborts the between-tick sleep promptly on requestStop instead of waiting the full interval", async () => {
    const loop = createPollingLoop({ run: async () => {}, intervalMs: 60_000 });
    const runPromise = loop.run();
    // Let the loop run once and enter its sleep before requesting a stop.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const start = Date.now();
    loop.requestStop();
    await runPromise;
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
