import { createHash, randomUUID } from "node:crypto";
import type { UserId } from "@money-maker/contracts";
import { spendSummary } from "@money-maker/core/costs/generation-budget";
import {
  budgetPoliciesFor,
  CLOUD_PROVIDERS,
  DEFAULT_GENERATION_SETTINGS,
  freeCreditPolicy,
  MAX_MONTHLY_CAP_MINOR,
  paidBudgetPolicy,
} from "@money-maker/core/costs/generation-settings";
import { createProviderConnection } from "@money-maker/core/providers/provider-connection";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { providerDependencies } from "./create-provider-connection.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const connectCloudProviderInputSchema = z
  .object({
    workspaceId: z.uuid(),
    provider: z.enum(["modal", "vercel_ai_gateway"]),
    /** modal */
    tokenId: z.string().trim().min(1).max(200).optional(),
    tokenSecret: z.string().trim().min(1).max(500).optional(),
    /** vercel_ai_gateway */
    apiKey: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
/** Typo guard near the providers' real monthly credits (Modal Starter: US$30). */
const usd = z.number().min(0).max(100);
export const setGenerationBudgetInputSchema = z
  .object({
    workspaceId: z.uuid(),
    monthlyCapBrl: z
      .number()
      .min(0)
      .max(MAX_MONTHLY_CAP_MINOR / 100),
    freeCredits: z
      .object({ modal: z.object({ usd }).strict().optional() })
      .strict()
      .optional(),
  })
  .strict();
export const getGenerationBudgetInputSchema = z.object({ workspaceId: z.uuid() }).strict();

const toMinor = (major: number) => Math.round(major * 100);
const toMajor = (minor: number) => minor / 100;

export const connectCloudProviderTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = connectCloudProviderInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner"]);
  if (denied) return denied;
  const verified = await verifyCloudProvider(parsed.data, deps);
  if (verified === "invalid_arguments") return { ok: false, error: "INVALID_ARGUMENTS" };
  if (verified === "invalid") return { ok: false, error: "INVALID_CREDENTIALS" };
  const { connections, secrets } = providerDependencies(deps, workspaceId);
  const connection = createProviderConnection({
    id: randomUUID(),
    workspaceId,
    provider: parsed.data.provider,
    mode: "api_key",
    accountId: verified.accountId,
    displayName: verified.displayName,
    secretReference: `secret://workspace/${workspaceId}/provider-connection/${randomUUID()}`,
  });
  await secrets.put({ reference: connection.secretReference, secret: verified.secret });
  const created = await connections.create(connection);
  if (!created.ok) {
    await secrets.delete(connection.secretReference);
    return { ok: false, error: "CONNECTION_ALREADY_EXISTS" };
  }
  await deps.audit?.record({
    action: "cloud_provider.connected",
    workspaceId,
    actorUserId: actorId,
    targetType: "ProviderConnection",
    targetId: connection.id,
    metadata: { provider: parsed.data.provider },
  });
  return {
    ok: true,
    value: { id: connection.id, provider: parsed.data.provider, ...verified.report },
  };
};

type Verified =
  | "invalid_arguments"
  | "invalid"
  | Readonly<{
      accountId: string;
      displayName: string;
      secret: string;
      report: Record<string, unknown>;
    }>;

/** Checks the credential with the provider before anything is stored; never returns the secret. */
const verifyCloudProvider = async (
  input: z.infer<typeof connectCloudProviderInputSchema>,
  deps: McpDependencies,
): Promise<Verified> => {
  if (input.provider === "modal") {
    if (!input.tokenId || !input.tokenSecret || input.apiKey) return "invalid_arguments";
    if (!deps.verifyModalCredentials) throw new Error("Cloud connections are not configured.");
    const credentials = { tokenId: input.tokenId, tokenSecret: input.tokenSecret };
    const verdict = await deps.verifyModalCredentials(credentials);
    if (verdict === "invalid") return "invalid";
    return {
      accountId: credentials.tokenId,
      displayName: "Modal",
      secret: JSON.stringify(credentials),
      report: { appDeployed: verdict === "deployed" },
    };
  }
  if (!input.apiKey || input.tokenId || input.tokenSecret) return "invalid_arguments";
  if (!deps.aiGatewayCredits) throw new Error("Cloud connections are not configured.");
  const credits = await deps.aiGatewayCredits(input.apiKey);
  if (credits === "invalid") return "invalid";
  return {
    // A digest, never the key: unique per key without storing it outside the secret store.
    accountId: `key-sha256:${createHash("sha256").update(input.apiKey).digest("hex").slice(0, 16)}`,
    displayName: "Vercel AI Gateway",
    secret: JSON.stringify({ apiKey: input.apiKey }),
    report: { balanceUsd: credits.balanceUsd },
  };
};

export const setGenerationBudgetTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = setGenerationBudgetInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner"]);
  if (denied) return denied;
  if (!deps.generationSettings) throw new Error("Generation settings are not configured.");
  const modal = parsed.data.freeCredits?.modal;
  await deps.generationSettings.put(workspaceId, {
    monthlyCapMinor: toMinor(parsed.data.monthlyCapBrl),
    freeCredits: modal ? { modal: { amountMinor: toMinor(modal.usd), currency: "USD" } } : {},
  });
  await deps.audit?.record({
    action: "generation_budget.updated",
    workspaceId,
    actorUserId: actorId,
    targetType: "GenerationSettings",
    targetId: workspaceId,
    metadata: {
      monthlyCapBrl: String(parsed.data.monthlyCapBrl),
      freeModalUsd: String(modal?.usd ?? 0),
    },
  });
  return { ok: true, value: { saved: true } };
};

export const getGenerationBudgetTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getGenerationBudgetInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  if (!deps.generationSettings || !deps.generationBudgetLedger)
    throw new Error("Generation settings are not configured.");
  const now = new Date();
  const settings = (await deps.generationSettings.get(workspaceId)) ?? DEFAULT_GENERATION_SETTINGS;
  const paid = paidBudgetPolicy(settings, [...CLOUD_PROVIDERS], now);
  const paidUse = spendSummary(
    await deps.generationBudgetLedger.list({ workspaceId, budgetKey: paid.key }),
    paid,
    now,
  );
  const free = [];
  for (const provider of CLOUD_PROVIDERS) {
    const credit = settings.freeCredits[provider];
    if (!credit) continue;
    const policy = freeCreditPolicy(provider, credit, now);
    const use = spendSummary(
      await deps.generationBudgetLedger.list({ workspaceId, budgetKey: policy.key }),
      policy,
      now,
    );
    free.push({
      provider,
      creditUsd: toMajor(credit.amountMinor),
      // Modal does not report the balance to this app; the owner types it in set_generation_budget.
      creditSource: "declared_by_owner" as const,
      usedUsd: toMajor(use.settledMinor + use.reservedMinor + use.unknownMinor),
      remainingUsd: toMajor(Math.max(0, use.remainingMinor)),
    });
  }
  const cloud = deps.providerConnections
    ? (await deps.providerConnections.findAllForWorkspace({ workspaceId })).filter(
        (connection) =>
          connection.provider === "modal" || connection.provider === "vercel_ai_gateway",
      )
    : [];
  const connections = cloud.map((connection) => ({
    provider: connection.provider,
    status: connection.status,
  }));
  // Prepaid providers report their own balance; read it live (never the key itself).
  const prepaid = [];
  const secrets = deps.secretStoreForWorkspace?.(workspaceId) ?? deps.secretStore;
  for (const connection of cloud) {
    if (connection.provider !== "vercel_ai_gateway" || connection.status !== "active") continue;
    const raw = secrets ? await secrets.get(connection.secretReference) : null;
    const apiKey = raw ? (JSON.parse(raw) as { apiKey?: string }).apiKey : undefined;
    const credits = apiKey && deps.aiGatewayCredits ? await deps.aiGatewayCredits(apiKey) : null;
    prepaid.push({
      provider: connection.provider,
      balanceUsd: credits && credits !== "invalid" ? credits.balanceUsd : null,
      ...(credits === "invalid" ? { problem: "key_refused" } : {}),
    });
  }
  return {
    ok: true,
    value: {
      month: paid.key.slice("paid-".length),
      order: budgetPoliciesFor(settings, "modal", now).map((policy) => policy.key),
      paid: {
        capBrl: toMajor(settings.monthlyCapMinor),
        spentBrl: toMajor(paidUse.settledMinor + paidUse.reservedMinor + paidUse.unknownMinor),
        remainingBrl: toMajor(Math.max(0, paidUse.remainingMinor)),
      },
      free,
      prepaid,
      connections,
    },
  };
};
