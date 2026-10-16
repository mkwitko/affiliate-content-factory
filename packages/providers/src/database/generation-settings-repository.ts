import type { WorkspaceId } from "@money-maker/contracts";
import {
  CLOUD_PROVIDERS,
  type CloudProvider,
  type FreeCredit,
  type GenerationSettings,
  type GenerationSettingsRepository,
} from "@money-maker/core/costs/generation-settings";
import type { DatabaseClient } from "./client.js";

const readCredits = (raw: unknown): GenerationSettings["freeCredits"] => {
  const credits: Partial<Record<CloudProvider, FreeCredit>> = {};
  if (typeof raw !== "object" || raw === null) return credits;
  for (const provider of CLOUD_PROVIDERS) {
    const entry = (raw as Record<string, unknown>)[provider] as
      | { amountMinor?: unknown; currency?: unknown }
      | undefined;
    if (
      entry &&
      Number.isSafeInteger(entry.amountMinor) &&
      (entry.amountMinor as number) >= 0 &&
      entry.currency === "USD"
    )
      credits[provider] = { amountMinor: entry.amountMinor as number, currency: "USD" };
  }
  return credits;
};

export class PrismaGenerationSettingsRepository implements GenerationSettingsRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async get(workspaceId: WorkspaceId): Promise<GenerationSettings | null> {
    const row = await this.client.generationSettings.findUnique({ where: { workspaceId } });
    return row
      ? { monthlyCapMinor: row.monthlyCapMinor, freeCredits: readCredits(row.freeCredits) }
      : null;
  }

  public async put(workspaceId: WorkspaceId, settings: GenerationSettings): Promise<void> {
    const data = {
      monthlyCapMinor: settings.monthlyCapMinor,
      freeCredits: settings.freeCredits as Record<string, FreeCredit>,
    };
    await this.client.generationSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
  }
}
