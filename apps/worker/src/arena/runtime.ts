import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { ArenaCandidate, ArenaTarget } from "@money-maker/core/arena/catalog";

/**
 * Arena plumbing: model downloads (resumable, disk-checked), runtime binaries and server
 * lifecycles. `cpu` runs Linux binaries on this machine; `desktop_amd` runs the Windows servers
 * of the RX 6650 XT through `scripts/local-ai/desktop.sh servir` (firewall, start, stop).
 */
export type ArenaEnv = Readonly<{
  target: ArenaTarget;
  /** Linux path of the model files (desktop: /mnt/e/ai/models). */
  modelsDir: string;
  /** How the runtime sees the same folder (desktop: E:\ai\models); equals modelsDir on cpu. */
  runtimeModelsDir: string;
  binDir: string;
  repoRoot: string;
  /** "corpus": the fixed benchmark fixtures; "real": the real Mercado Livre products (level 2). */
  dataset: "corpus" | "real";
  log: (line: string) => void;
}>;

export type RunningServer = Readonly<{
  baseUrl: string;
  stop: () => Promise<void>;
  logTail: () => string;
  /** Peak resident memory of a local process (VmHWM), MB; null for desktop servers. */
  peakRamMb: () => Promise<number | null>;
}>;

const execFileAsync = promisify(execFile);

export const freeBytes = async (dir: string): Promise<number> => {
  await mkdir(dir, { recursive: true });
  const s = await statfs(dir);
  return s.bavail * s.bsize;
};

const sizeOf = (path: string) =>
  stat(path)
    .then((s) => s.size)
    .catch(() => null);

/** Bytes still to download for a candidate (files already present cost nothing). */
export const missingBytes = async (candidate: ArenaCandidate, modelsDir: string) => {
  let total = 0;
  for (const file of candidate.files)
    if ((await sizeOf(join(modelsDir, file.file))) === null) total += file.bytes;
  return total;
};

/** Three attempts; each resumes from the partial file, so a dropped connection costs little. */
export const downloadFile = async (
  url: string,
  dest: string,
  doFetch: typeof fetch = fetch,
): Promise<"present" | "downloaded"> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await downloadOnce(url, dest, doFetch);
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
};

/** Resumes `<dest>.part` with a Range request; the finished file is renamed into place. */
const downloadOnce = async (
  url: string,
  dest: string,
  doFetch: typeof fetch = fetch,
): Promise<"present" | "downloaded"> => {
  if ((await sizeOf(dest)) !== null) return "present";
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const have = (await sizeOf(part)) ?? 0;
  const response = await doFetch(url, {
    redirect: "follow",
    ...(have > 0 ? { headers: { range: `bytes=${have}-` } } : {}),
  });
  if (!response.ok || !response.body) throw new Error(`download_failed_${response.status}`);
  const append = have > 0 && response.status === 206;
  const expected =
    Number(response.headers.get("content-length") ?? Number.NaN) + (append ? have : 0);
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    createWriteStream(part, { flags: append ? "a" : "w" }),
  );
  const got = await sizeOf(part);
  if (Number.isFinite(expected) && got !== expected) throw new Error("download_incomplete");
  await rename(part, dest);
  return "downloaded";
};

const RELEASES = {
  audiocpp: {
    url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.0/audio-v0.9.0-bin-ubuntu-x64-cpu.tar.gz",
    binary: "audiocpp_server",
  },
  llama: {
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b11417/llama-b11417-bin-ubuntu-x64.tar.gz",
    binary: "llama-server",
  },
} as const;

const findFile = async (dir: string, name: string): Promise<string | null> => {
  const { stdout } = await execFileAsync("find", [dir, "-name", name, "-type", "f"]).catch(() => ({
    stdout: "",
  }));
  return stdout.split("\n").find(Boolean) ?? null;
};

/** Pinned Linux release of a cpu runtime, extracted under binDir/<name>. */
export const ensureLinuxBinary = async (
  env: ArenaEnv,
  name: keyof typeof RELEASES,
): Promise<string> => {
  const release = RELEASES[name];
  const dir = join(env.binDir, name);
  const found = await findFile(dir, release.binary);
  if (found) return found;
  const archive = join(env.binDir, `${name}.tar.gz`);
  env.log(`downloading ${name} runtime`);
  await downloadFile(release.url, archive);
  await mkdir(dir, { recursive: true });
  await execFileAsync("tar", ["xzf", archive, "-C", dir]);
  const binary = await findFile(dir, release.binary);
  if (!binary) throw new Error(`runtime_binary_missing:${name}`);
  await execFileAsync("chmod", ["+x", binary]);
  return binary;
};

const tail = () => {
  const lines: string[] = [];
  return {
    push: (chunk: Buffer) => {
      lines.push(...chunk.toString("utf8").split("\n"));
      lines.splice(0, Math.max(0, lines.length - 60));
    },
    text: () => lines.join("\n"),
  };
};

const healthy = async (url: string) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
};

/** Spawns a local server and waits for a 2xx on healthUrl; throws runtime_start_failed. */
export const startLocalServer = async (
  command: string,
  args: readonly string[],
  baseUrl: string,
  healthPath: string,
  timeoutMs = 600_000,
): Promise<RunningServer> => {
  // A server left on the port would answer the health check for us: refuse instead.
  if (await healthy(`${baseUrl}${healthPath}`)) throw new Error(`runtime_port_busy:${baseUrl}`);
  const log = tail();
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", log.push);
  child.stderr.on("data", log.push);
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const stop = async () => {
    if (exited) return;
    child.kill("SIGTERM");
    for (let i = 0; i < 50 && !exited; i += 1) await new Promise((r) => setTimeout(r, 200));
    if (!exited) child.kill("SIGKILL");
  };
  const started = Date.now();
  while (!(await healthy(`${baseUrl}${healthPath}`))) {
    if (exited || Date.now() - started > timeoutMs) {
      await stop();
      throw Object.assign(new Error("runtime_start_failed"), { cause: log.text() });
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return {
    baseUrl,
    stop,
    logTail: log.text,
    peakRamMb: async () => {
      const status = await readFile(`/proc/${child.pid}/status`, "utf8").catch(() => "");
      const kb = /VmHWM:\s+(\d+)/.exec(status)?.[1];
      return kb ? Math.round(Number(kb) / 1024) : null;
    },
  };
};

/** 127.0.0.1:port -> host:port, for adapters that only accept loopback (llama-server). */
const loopbackProxy = (port: number, host: string) =>
  new Promise<net.Server>((resolve, reject) => {
    const server = net
      .createServer((client) => {
        const upstream = net.connect(port, host);
        const end = () => {
          client.destroy();
          upstream.destroy();
        };
        client.on("error", end);
        upstream.on("error", end);
        client.pipe(upstream);
        upstream.pipe(client);
      })
      .on("error", reject)
      .listen(port, "127.0.0.1", () => resolve(server));
  });

/**
 * Starts sd-server or llama-server on the Windows desktop through desktop.sh and waits for it.
 * One retry: a server that exits at start is usually the previous one still letting go.
 */
export const startDesktopServer = async (
  env: ArenaEnv,
  kind: "sd" | "llama",
  args: readonly string[],
): Promise<RunningServer> => {
  try {
    return await startDesktopServerOnce(env, kind, args);
  } catch (error) {
    env.log("  server did not start, retrying once in 15 s");
    await new Promise((r) => setTimeout(r, 15_000));
    return startDesktopServerOnce(env, kind, args).catch(() => {
      throw error;
    });
  }
};

const startDesktopServerOnce = async (
  env: ArenaEnv,
  kind: "sd" | "llama",
  args: readonly string[],
): Promise<RunningServer> => {
  const script = join(env.repoRoot, "scripts/local-ai/desktop.sh");
  const { stdout } = await execFileAsync("bash", [script, "servir", kind, ...args], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 900_000,
  }).catch((error: { stdout?: string; stderr?: string }) => {
    throw Object.assign(new Error("runtime_start_failed"), {
      cause: `${error.stdout ?? ""}\n${error.stderr ?? ""}`.slice(-4_000),
    });
  });
  const url = /ARENA_URL=(\S+)/.exec(stdout)?.[1];
  if (!url) throw Object.assign(new Error("runtime_start_failed"), { cause: stdout.slice(-2_000) });
  const parsed = new URL(url);
  const proxy =
    kind === "llama" && parsed.hostname !== "127.0.0.1"
      ? await loopbackProxy(Number(parsed.port), parsed.hostname)
      : null;
  return {
    baseUrl: proxy ? `http://127.0.0.1:${parsed.port}` : url,
    stop: async () => {
      proxy?.close();
      await execFileAsync("bash", [script, "servir-parar"]).catch(() => undefined);
    },
    logTail: () => "",
    peakRamMb: async () => null,
  };
};

export const removeFiles = async (
  candidate: ArenaCandidate,
  env: ArenaEnv,
  keep: ReadonlySet<string>,
) => {
  for (const file of candidate.files)
    if (!keep.has(file.file)) await rm(join(env.modelsDir, file.file), { force: true });
};

/** OOM and missing-device messages the runtimes print, mapped to arena statuses. */
export const classifyRuntimeFailure = (log: string): "OOM" | "RUNTIME_BLOCKED" =>
  /out of memory|ErrorOutOfDeviceMemory|failed to allocate|cudaMalloc|bad_alloc|vk::.*OutOfDeviceMemory/i.test(
    log,
  )
    ? "OOM"
    : "RUNTIME_BLOCKED";
