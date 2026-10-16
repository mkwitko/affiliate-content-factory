import { spawn } from "node:child_process";

export type RunProcessOptions = Readonly<{
  signal?: AbortSignal | undefined;
  /** SIGKILLs the process past this many ms and rejects with process_timeout. */
  timeoutMs: number;
  /** Keeps at most this many bytes of stdout and of stderr (the tail of stderr). */
  maxBuffer?: number;
  /** Written to stdin and closed; absent leaves stdin ignored. */
  stdin?: "pipe";
  /** Working directory and full environment of the child; absent inherits. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onSpawn?: (child: import("node:child_process").ChildProcess) => void;
}>;

export type RunProcessResult = Readonly<{ stdout: string; stderr: string }>;

/**
 * Spawns a binary with an argument array (never a shell) and settles only after the process has
 * exited, so a caller's `finally` cleanup never races a dying encoder. Abort and timeout both
 * SIGKILL; `execFile` resolves on abort before the process is gone, which is why this exists.
 * Rejects with render_aborted, process_timeout, or process_failed:<code>.
 */
export const runProcess = (
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("render_aborted"));
      return;
    }
    const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
    const child = spawn(command, [...args], {
      stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    options.onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    let outcome: "aborted" | "timeout" | undefined;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < maxBuffer) stdout += chunk.slice(0, maxBuffer - stdout.length);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-maxBuffer);
    });
    const kill = (reason: "aborted" | "timeout") => {
      outcome ??= reason;
      child.kill("SIGKILL");
    };
    const onAbort = () => kill("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (outcome === "aborted") reject(new Error("render_aborted"));
      else if (outcome === "timeout") reject(new Error("process_timeout"));
      else if (spawnError || code !== 0)
        reject(Object.assign(new Error(`process_failed:${code ?? "spawn"}`), { stderr }));
      else resolve({ stdout, stderr });
    });
  });
