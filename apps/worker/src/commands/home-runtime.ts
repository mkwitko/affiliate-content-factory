import { spawn as nodeSpawn } from "node:child_process";
import { isPrivateRuntimeHost } from "@money-maker/config";
import {
  HOME_CAPABILITIES,
  type HomeCapability,
  type RuntimeState,
} from "@money-maker/core/home-worker/tokens";

/**
 * Runtime supervisor for a home machine (8 GB VRAM: at most one model server alive). A capability
 * with a HOME_RUNTIMES entry is started on demand and stopped when another capability needs the
 * GPU or after an idle period; one without an entry is managed by hand and left alone.
 */
export type RuntimeConfig = Readonly<{
  command: readonly string[];
  healthUrl: string;
  startTimeoutMs: number;
  idleStopMs: number;
}>;
export type RuntimeConfigs = Readonly<Partial<Record<HomeCapability, RuntimeConfig>>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const privateHealthUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      isPrivateRuntimeHost(url.hostname)
    );
  } catch {
    return false;
  }
};

/** HOME_RUNTIMES JSON → configs; throws naming the bad field, never echoing argv. */
export const parseHomeRuntimes = (raw: string | undefined): RuntimeConfigs => {
  if (!raw?.trim()) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("HOME_RUNTIMES must be valid JSON.");
  }
  const bad = (path: string): never => {
    throw new Error(`HOME_RUNTIMES invalid at ${path}`);
  };
  if (!isRecord(json)) return bad("root");
  const out: Partial<Record<HomeCapability, RuntimeConfig>> = {};
  for (const [key, entry] of Object.entries(json)) {
    const capability = HOME_CAPABILITIES.find((known) => known === key);
    if (!capability) return bad(`${key} (unknown capability)`);
    if (!isRecord(entry)) return bad(key);
    const { command, healthUrl, startTimeoutMs, idleStopMs } = entry;
    if (Object.keys(entry).length !== 4) bad(`${key} (expected exactly 4 fields)`);
    if (
      !Array.isArray(command) ||
      command.length < 1 ||
      command.length > 100 ||
      !command.every((part) => typeof part === "string" && part.length > 0 && part.length <= 1000)
    )
      bad(`${key}.command`);
    if (!privateHealthUrl(healthUrl)) bad(`${key}.healthUrl`);
    const startMs = Number(startTimeoutMs);
    const idleMs = Number(idleStopMs);
    if (
      typeof startTimeoutMs !== "number" ||
      !Number.isInteger(startMs) ||
      startMs < 1 ||
      startMs > 300_000
    )
      bad(`${key}.startTimeoutMs`);
    if (typeof idleStopMs !== "number" || !Number.isInteger(idleMs) || idleMs < 0)
      bad(`${key}.idleStopMs`);
    out[capability] = {
      command: command as string[],
      healthUrl: healthUrl as string,
      startTimeoutMs: startMs,
      idleStopMs: idleMs,
    };
  }
  return out;
};

export type RuntimeChild = Readonly<{
  kill: (signal: "SIGTERM" | "SIGKILL") => void;
  onExit: (listener: () => void) => void;
}>;

export class RuntimeError extends Error {
  public constructor(public readonly code: "runtime_unhealthy" | "runtime_exited") {
    super(code);
  }
}

export type RuntimeSupervisorDeps = Readonly<{
  runtimes: RuntimeConfigs;
  spawn: (command: string, args: readonly string[]) => RuntimeChild;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (event: string, fields: Readonly<Record<string, string | number>>) => void;
}>;

const POLL_MS = 500;
const KILL_AFTER_MS = 10_000;
/** How long a task waits for agent requests on another model to finish before it switches. */
const TASK_WAIT_MS = 180_000;
const LEASE_POLL_MS = 1_000;
/**
 * Agents wait this long after the last production task: the task loop polls every 30 s, so a
 * queue of tasks keeps the GPU without an agent request (100-170 s on the copy model) slipping
 * in between two of them and timing the next one out (2026-10-15).
 */
const TASK_QUIET_MS = 90_000;

/** shell:false, stdio ignored: no argv, path or output ever reaches a log. */
export const spawnChild = (command: string, args: readonly string[]): RuntimeChild => {
  const child = nodeSpawn(command, [...args], { shell: false, stdio: "ignore" });
  child.on("error", () => undefined); // surfaces as an exit; the health loop reports runtime_exited
  return {
    kill: (signal) => void child.kill(signal),
    onExit: (listener) => {
      child.once("exit", listener);
      child.once("error", listener);
    },
  };
};

type Running = {
  capability: HomeCapability;
  child: RuntimeChild;
  exited: boolean;
  stopping: boolean;
};

export const createRuntimeSupervisor = (deps: RuntimeSupervisorDeps) => {
  const states: Partial<Record<HomeCapability, RuntimeState>> = {};
  for (const capability of Object.keys(deps.runtimes) as HomeCapability[])
    states[capability] = "stopped";
  let running: Running | null = null;
  let busy: HomeCapability | null = null;
  let idleGeneration = 0;
  let chain: Promise<unknown> = Promise.resolve();
  // Leases held by requests outside the task loop (the agents' LLM calls), per capability.
  const leases = new Map<HomeCapability, number>();
  let tasksWaiting = 0;
  let lastTaskAt = Number.NEGATIVE_INFINITY;
  const agentLeased = () => [...leases.values()].some((count) => count > 0);
  const leasedElsewhere = (capability: HomeCapability) =>
    [...leases].some(([held, count]) => held !== capability && count > 0);
  // Serialise start/stop so two callers can never leave two children alive.
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  const stopChild = async (): Promise<void> => {
    const current = running;
    if (!current) return;
    current.stopping = true;
    if (!current.exited) {
      const gone = new Promise<void>((resolve) => current.child.onExit(resolve));
      current.child.kill("SIGTERM");
      const timedOut = await Promise.race([
        gone.then(() => false),
        deps.sleep(KILL_AFTER_MS).then(() => true),
      ]);
      if (timedOut && !current.exited) {
        current.child.kill("SIGKILL");
        await gone;
      }
    }
    states[current.capability] = "stopped";
    if (running === current) running = null;
    deps.log("runtime_stopped", { capability: current.capability });
  };

  const start = async (capability: HomeCapability, config: RuntimeConfig): Promise<void> => {
    const [command, ...args] = config.command;
    const current: Running = {
      capability,
      child: deps.spawn(command ?? "", args),
      exited: false,
      stopping: false,
    };
    current.child.onExit(() => {
      current.exited = true;
      if (!current.stopping) states[capability] = "failed";
    });
    running = current;
    states[capability] = "starting";
    deps.log("runtime_starting", { capability });
    const deadline = deps.now() + config.startTimeoutMs;
    for (;;) {
      if (current.exited) {
        running = null;
        states[capability] = "failed";
        throw new RuntimeError("runtime_exited");
      }
      const healthy = await deps
        .fetch(config.healthUrl, { signal: AbortSignal.timeout(2_000) })
        .then((response) => response.ok)
        .catch(() => false);
      if (healthy && !current.exited) {
        states[capability] = "healthy";
        deps.log("runtime_healthy", { capability });
        return;
      }
      if (deps.now() >= deadline) {
        await stopChild();
        states[capability] = "failed";
        throw new RuntimeError("runtime_unhealthy");
      }
      await deps.sleep(POLL_MS);
    }
  };

  /**
   * Make `capability` ready, stopping any other runtime first. No-op when externally managed.
   * `byTask` marks the task loop as the holder (status `busy`); an agent lease never does.
   */
  const ensureFor = async (capability: HomeCapability, byTask: boolean): Promise<void> => {
    const config = deps.runtimes[capability];
    if (!config) return;
    // A task never kills an agent request mid-answer: it waits (and blocks new agent leases)
    // until agent leases end, at most TASK_WAIT_MS. On the same model too: one slot serves one
    // request, and a task queued behind a long agent prompt times out.
    if (byTask) lastTaskAt = deps.now();
    const blocked = () => (byTask ? agentLeased() : leasedElsewhere(capability));
    if (blocked()) {
      tasksWaiting += 1;
      const deadline = deps.now() + TASK_WAIT_MS;
      try {
        while (blocked() && deps.now() < deadline) await deps.sleep(LEASE_POLL_MS);
      } finally {
        tasksWaiting -= 1;
      }
    }
    idleGeneration += 1;
    return exclusive(async () => {
      if (running && (running.capability !== capability || running.exited)) await stopChild();
      if (byTask) busy = capability;
      if (running && states[capability] === "healthy") return;
      await start(capability, config);
    }).catch((error: unknown) => {
      if (byTask) busy = null;
      throw error;
    });
  };

  /** Stop after idleStopMs (0 = now) unless a task or a lease uses the runtime meanwhile. */
  const scheduleIdleStop = (capability: HomeCapability): Promise<void> => {
    const config = deps.runtimes[capability];
    if (!config) return Promise.resolve();
    const generation = ++idleGeneration;
    const stopIfIdle = () =>
      exclusive(async () => {
        if (
          generation === idleGeneration &&
          running?.capability === capability &&
          busy !== capability &&
          (leases.get(capability) ?? 0) === 0
        )
          await stopChild();
      });
    if (config.idleStopMs === 0) return stopIfIdle();
    void deps.sleep(config.idleStopMs).then(stopIfIdle);
    return Promise.resolve();
  };

  return {
    ensure: (capability: HomeCapability): Promise<void> => ensureFor(capability, true),
    /** Task done: the runtime stops after its idle period unless used again meanwhile. */
    release: (capability: HomeCapability): Promise<void> => {
      if (busy === capability) busy = null;
      lastTaskAt = deps.now();
      return scheduleIdleStop(capability);
    },
    /**
     * A shared lease for a request outside the task loop (an agent's LLM call). Waits up to
     * `waitMs` while a task holds another model or is waiting for the GPU; null when it is still
     * busy, so the caller sends the request elsewhere. The returned function ends the lease.
     */
    lease: async (
      capability: HomeCapability,
      waitMs: number,
    ): Promise<(() => Promise<void>) | null> => {
      const deadline = deps.now() + waitMs;
      while (busy !== null || tasksWaiting > 0 || deps.now() - lastTaskAt < TASK_QUIET_MS) {
        if (deps.now() >= deadline) return null;
        await deps.sleep(LEASE_POLL_MS);
      }
      leases.set(capability, (leases.get(capability) ?? 0) + 1);
      const end = async () => {
        const left = Math.max(0, (leases.get(capability) ?? 1) - 1);
        leases.set(capability, left);
        if (left === 0) await scheduleIdleStop(capability);
      };
      try {
        await ensureFor(capability, false);
      } catch (error) {
        await end();
        throw error;
      }
      return end;
    },
    stopAll: (): Promise<void> => {
      idleGeneration += 1;
      busy = null;
      return exclusive(stopChild);
    },
    status: () => ({
      busy,
      runtimes: { ...states } as Readonly<Record<string, RuntimeState>>,
    }),
  };
};

export type RuntimeSupervisor = ReturnType<typeof createRuntimeSupervisor>;
