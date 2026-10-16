import type { HomeCapability } from "./tokens.js";

/** Tasks a machine runs on its loaded model before the oldest job, of any model, goes first. */
export const MAX_MODEL_STREAK = 8;

/**
 * Keeps a loaded model busy without starving the other one: preferring the loaded model's jobs
 * forever let offer scenes (image model) hold the desktop for hours while 84 photo checks
 * (vision model) waited (2026-10-15). After MAX_MODEL_STREAK claims on the same model, one claim
 * goes without a preference, so the queue's oldest job decides, then the count starts again.
 * In memory per token: a restart only resets the count.
 */
export const createModelStreak = (max = MAX_MODEL_STREAK) => {
  const streaks = new Map<string, { capability: HomeCapability; count: number }>();
  return (tokenId: string, loaded: HomeCapability | undefined): HomeCapability | undefined => {
    if (!loaded) {
      streaks.delete(tokenId);
      return undefined;
    }
    const current = streaks.get(tokenId);
    const count = current?.capability === loaded ? current.count + 1 : 1;
    if (count > max) {
      streaks.delete(tokenId);
      return undefined;
    }
    streaks.set(tokenId, { capability: loaded, count });
    return loaded;
  };
};
