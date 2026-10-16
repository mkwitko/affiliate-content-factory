/**
 * Generation routes (spec 2026-10-14, generation orchestrator): a route is task × model ×
 * executor. The router orders a task's qualified, healthy routes: free routes by the owner's
 * rank (best quality while free lasts), then paid routes by measured cost. Pure; the run log and
 * budgets feed it.
 */
export const ROUTE_TASKS = [
  "image.offer_scene",
  "image.scene_plate",
  "video.i2v",
  "vision.qa",
  "llm.copy",
  "llm.director",
  "llm.agent",
  "tts.ptbr",
  "asr.ptbr",
] as const;
export type RouteTask = (typeof ROUTE_TASKS)[number];
export type RouteState = "candidate" | "qualifying" | "qualified" | "rejected" | "demoted";
/**
 * always_free: never costs money (the desktop, a daily free tier); credit: a provider's free
 * credit first, then paid; paid: money from the first run.
 */
export type RouteCost = "always_free" | "credit" | "paid";
export type GenerationRoute = Readonly<{
  id: string;
  task: RouteTask;
  model: string;
  executor: string;
  cost: RouteCost;
  /** Budget provider name (free credit and paid month), null for an always-free route. */
  provider: string | null;
  state: RouteState;
  /** Owner's blind ranking among finalists, 1 = best; null until ranked. */
  ownerRank: number | null;
  passCount: number;
  runCount: number;
  /** Measured cost per passing unit in the paid budget's currency; null until measured. */
  costPerUnitMinor: number | null;
}>;
export type RunOutcome = "ok" | "gate_failed" | "technical_failure" | "quota_exhausted";
export type GenerationRun = Readonly<{
  routeId: string;
  outcome: RunOutcome;
  at: Date;
  /** quota_exhausted: when the provider's quota renews. */
  retryAfter?: Date;
}>;
export type RouteHealth = Readonly<{
  usable: boolean;
  reason?: "cooling" | "quota_exhausted" | "offline";
}>;

export const ROUTE_COOLDOWN_MS = 30 * 60 * 1000;
const FAILURES_TO_COOL = 3;

export const routeId = (task: RouteTask, model: string, executor: string) =>
  `${task}|${model}|${executor}`;

/** Runs of one route, any order. Quota pauses never count as failures. */
export const routeHealth = (runs: readonly GenerationRun[], now: Date): RouteHealth => {
  const newest = [...runs].sort((a, b) => b.at.getTime() - a.at.getTime());
  const quota = newest.find((run) => run.outcome === "quota_exhausted");
  if (quota?.retryAfter && quota.retryAfter.getTime() > now.getTime() && newest[0] === quota)
    return { usable: false, reason: "quota_exhausted" };
  const technical = newest.filter((run) => run.outcome !== "quota_exhausted");
  const streak = technical.slice(0, FAILURES_TO_COOL);
  if (
    streak.length === FAILURES_TO_COOL &&
    streak.every((run) => run.outcome === "technical_failure") &&
    now.getTime() - (streak[0] as GenerationRun).at.getTime() < ROUTE_COOLDOWN_MS
  )
    return { usable: false, reason: "cooling" };
  return { usable: true };
};

const passRate = (route: GenerationRoute) =>
  route.runCount > 0 ? route.passCount / route.runCount : 0;

export const orderRoutes = (
  input: Readonly<{
    task: RouteTask;
    routes: readonly GenerationRoute[];
    health: (route: GenerationRoute) => RouteHealth;
    freeCreditLeft: (provider: string) => boolean;
    paidAllowed: (provider: string) => boolean;
    packageModel?: string;
  }>,
): readonly GenerationRoute[] => {
  const usable = input.routes.filter(
    (route) =>
      route.task === input.task && route.state === "qualified" && input.health(route).usable,
  );
  const isFree = (route: GenerationRoute) =>
    route.cost === "always_free" ||
    (route.cost === "credit" && route.provider !== null && input.freeCreditLeft(route.provider));
  const byQuality = (a: GenerationRoute, b: GenerationRoute) =>
    (a.ownerRank ?? Number.MAX_SAFE_INTEGER) - (b.ownerRank ?? Number.MAX_SAFE_INTEGER) ||
    Number(b.model === input.packageModel) - Number(a.model === input.packageModel) ||
    passRate(b) - passRate(a);
  const free = usable.filter(isFree).sort(byQuality);
  const paid = usable
    .filter(
      (route) => !isFree(route) && route.provider !== null && input.paidAllowed(route.provider),
    )
    .sort(
      (a, b) =>
        (a.costPerUnitMinor ?? Number.MAX_SAFE_INTEGER) -
          (b.costPerUnitMinor ?? Number.MAX_SAFE_INTEGER) || byQuality(a, b),
    );
  return [...free, ...paid];
};
