import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeSupervisor,
  parseHomeRuntimes,
  type RuntimeChild,
  type RuntimeConfigs,
} from "./home-runtime.js";

const configs: RuntimeConfigs = {
  scene_director: {
    command: ["/secret/path/llama-server", "-m", "/secret/model.gguf"],
    healthUrl: "http://127.0.0.1:8080/health",
    startTimeoutMs: 5_000,
    idleStopMs: 60_000,
  },
  image_generation: {
    command: ["/secret/path/sd-server"],
    healthUrl: "http://127.0.0.1:8081/health",
    startTimeoutMs: 5_000,
    idleStopMs: 0,
  },
};

const harness = (overrides: { healthy?: () => boolean; exitOnSpawn?: boolean } = {}) => {
  let clock = 0;
  const held: { at: number; resolve: () => void }[] = [];
  const alive = new Set<number>();
  let spawned = 0;
  let maxAlive = 0;
  const logs: unknown[] = [];
  const spawn = vi.fn((): RuntimeChild => {
    const id = ++spawned;
    const listeners: (() => void)[] = [];
    const exit = () => {
      if (alive.delete(id)) for (const listener of listeners) listener();
    };
    alive.add(id);
    maxAlive = Math.max(maxAlive, alive.size);
    if (overrides.exitOnSpawn) queueMicrotask(exit);
    return { kill: () => exit(), onExit: (listener) => void listeners.push(listener) };
  });
  const supervisor = createRuntimeSupervisor({
    runtimes: configs,
    spawn,
    fetch: (async () => ({ ok: overrides.healthy?.() ?? true })) as unknown as typeof fetch,
    now: () => clock,
    sleep: (ms) => {
      if (ms <= 500) {
        clock += ms;
        return Promise.resolve();
      }
      return new Promise((resolve) => held.push({ at: clock + ms, resolve }));
    },
    log: (...entry) => void logs.push(entry),
  });
  const advance = async (ms: number) => {
    clock += ms;
    for (const timer of held.filter((due) => due.at <= clock)) timer.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { supervisor, spawn, alive, maxAlive: () => maxAlive, advance, logs };
};

describe("runtime supervisor", () => {
  it("keeps one child alive across a capability switch", async () => {
    const h = harness();
    await h.supervisor.ensure("scene_director");
    expect(h.supervisor.status()).toEqual({
      busy: "scene_director",
      runtimes: { scene_director: "healthy", image_generation: "stopped" },
    });
    await h.supervisor.release("scene_director");
    await h.supervisor.ensure("image_generation");
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.maxAlive()).toBe(1);
    expect(h.supervisor.status().runtimes.scene_director).toBe("stopped");
    await h.supervisor.release("image_generation"); // idleStopMs 0 stops now
    expect(h.alive.size).toBe(0);
  });

  it("reuses a healthy runtime and stops it after the idle period", async () => {
    const h = harness();
    await h.supervisor.ensure("scene_director");
    await h.supervisor.release("scene_director");
    await h.supervisor.ensure("scene_director");
    expect(h.spawn).toHaveBeenCalledTimes(1);
    await h.supervisor.release("scene_director");
    await h.advance(59_000);
    expect(h.alive.size).toBe(1);
    await h.advance(2_000);
    expect(h.alive.size).toBe(0);
    expect(h.supervisor.status().runtimes.scene_director).toBe("stopped");
  });

  it("a new task cancels a pending idle stop", async () => {
    const h = harness();
    await h.supervisor.ensure("scene_director");
    await h.supervisor.release("scene_director");
    await h.supervisor.ensure("scene_director");
    await h.advance(120_000);
    expect(h.alive.size).toBe(1);
  });

  it("an agent lease shares the runtime without taking the task slot, and idles it out after the last lease", async () => {
    const h = harness();
    const end = await h.supervisor.lease("scene_director", 30_000);
    expect(end).not.toBeNull();
    expect(h.supervisor.status()).toEqual({
      busy: null,
      runtimes: { scene_director: "healthy", image_generation: "stopped" },
    });
    await end?.();
    await h.advance(59_000);
    expect(h.alive.size).toBe(1);
    await h.advance(2_000);
    expect(h.alive.size).toBe(0);
  });

  it("an agent waits while a task holds another model, then gives up", async () => {
    const h = harness();
    await h.supervisor.ensure("image_generation");
    const pending = h.supervisor.lease("scene_director", 2_000);
    await h.advance(1_000);
    await h.advance(1_000);
    expect(await pending).toBeNull();
    expect(h.supervisor.status().busy).toBe("image_generation");
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it("a task waits for an agent answer on another model, blocks new leases, then switches", async () => {
    const h = harness();
    const end = await h.supervisor.lease("scene_director", 30_000);
    const task = h.supervisor.ensure("image_generation");
    await h.advance(1_000);
    const late = h.supervisor.lease("scene_director", 1_000);
    await h.advance(1_000);
    expect(await late).toBeNull();
    expect(h.alive.size).toBe(1); // the agent's model is still serving
    await end?.();
    await h.advance(1_000);
    await task;
    expect(h.supervisor.status().busy).toBe("image_generation");
    expect(h.maxAlive()).toBe(1);
  });

  it("a task on the same model waits for the agent answer instead of queueing behind it", async () => {
    const h = harness();
    const end = await h.supervisor.lease("scene_director", 30_000);
    let started = false;
    const task = h.supervisor.ensure("scene_director").then(() => {
      started = true;
    });
    await h.advance(1_000);
    expect(started).toBe(false);
    await end?.();
    await h.advance(1_000);
    await task;
    expect(started).toBe(true);
  });

  it("an agent gets no lease while production ran in the last 90 seconds", async () => {
    const h = harness();
    const tryLease = async () => {
      const pending = h.supervisor.lease("scene_director", 1_000);
      await h.advance(1_000);
      await h.advance(1_000);
      return pending;
    };
    await h.supervisor.ensure("scene_director");
    expect(await tryLease()).toBeNull();
    await h.supervisor.release("scene_director");
    expect(await tryLease()).toBeNull();
    await h.advance(90_000);
    expect(await h.supervisor.lease("scene_director", 1_000)).not.toBeNull();
  });

  it("fails with runtime_unhealthy and leaves no child behind", async () => {
    const h = harness({ healthy: () => false });
    await expect(h.supervisor.ensure("scene_director")).rejects.toMatchObject({
      code: "runtime_unhealthy",
    });
    expect(h.alive.size).toBe(0);
    expect(h.supervisor.status().runtimes.scene_director).toBe("failed");
  });

  it("fails with runtime_exited when the child dies during start", async () => {
    const h = harness({ exitOnSpawn: true, healthy: () => false });
    await expect(h.supervisor.ensure("scene_director")).rejects.toMatchObject({
      code: "runtime_exited",
    });
  });

  it("leaves externally managed capabilities alone and never logs argv", async () => {
    const h = harness();
    await h.supervisor.ensure("visual_qa");
    expect(h.spawn).not.toHaveBeenCalled();
    await h.supervisor.ensure("scene_director");
    await h.supervisor.stopAll();
    expect(h.alive.size).toBe(0);
    const text = JSON.stringify([h.logs, h.supervisor.status()]);
    expect(text).not.toContain("secret");
  });
});

describe("HOME_RUNTIMES parsing", () => {
  const entry = {
    command: ["llama-server"],
    healthUrl: "http://192.168.0.5:8080/health",
    startTimeoutMs: 1000,
    idleStopMs: 0,
  };
  it("accepts private hosts and rejects everything unsafe", () => {
    expect(parseHomeRuntimes(JSON.stringify({ scene_director: entry }))).toHaveProperty(
      "scene_director",
    );
    expect(parseHomeRuntimes(undefined)).toEqual({});
    for (const bad of [
      { other: entry },
      { scene_director: { ...entry, healthUrl: "http://example.com/health" } },
      { scene_director: { ...entry, healthUrl: "ftp://127.0.0.1/" } },
      { scene_director: { ...entry, command: [] } },
      { scene_director: { ...entry, command: "llama-server -m x" } },
      { scene_director: { ...entry, startTimeoutMs: 300_001 } },
      { scene_director: { ...entry, idleStopMs: -1 } },
      { scene_director: { ...entry, shell: true } },
    ])
      expect(() => parseHomeRuntimes(JSON.stringify(bad))).toThrow(/HOME_RUNTIMES/);
    expect(() => parseHomeRuntimes("{")).toThrow(/JSON/);
  });
});
