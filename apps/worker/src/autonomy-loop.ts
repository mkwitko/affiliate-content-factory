import type { AutonomyCycleDeps } from "@money-maker/core/autonomy/cycle";
import { listAutonomyWorkspaces, runAutonomyCycle } from "@money-maker/core/autonomy/cycle";
import type { JobWorker } from "@money-maker/core/jobs/job";

export const AUTONOMY_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Runs the autonomy cycle for every workspace with an active research policy. On by default
 * (AUTONOMY_ENABLED=false stops it), and only on the full profile, so other workers never
 * duplicate it.
 * Logs counters and error codes only.
 */
export const autonomyTick = async (
  deps: AutonomyCycleDeps,
  now: () => Date = () => new Date(),
  log: (message: string, fields: unknown) => void = console.info,
): Promise<void> => {
  for (const workspaceId of await listAutonomyWorkspaces(deps.policies, now())) {
    const counters = await runAutonomyCycle(deps, { workspaceId, now: now() });
    log("autonomy_cycle", { workspaceId, ...counters });
  }
};

export const autonomyLoops = (
  input: Readonly<{
    enabled: boolean;
    profile: string;
    deps: AutonomyCycleDeps;
    createLoop: (input: {
      run: () => Promise<void>;
      intervalMs: number;
      onError: (error: unknown) => void;
    }) => JobWorker;
  }>,
): readonly JobWorker[] =>
  input.enabled && input.profile === "full"
    ? [
        input.createLoop({
          run: () => autonomyTick(input.deps),
          intervalMs: AUTONOMY_INTERVAL_MS,
          onError: () => console.error("autonomy cycle failed"),
        }),
      ]
    : [];
