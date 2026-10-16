/**
 * Vercel AI Gateway (spec 2026-10-14, generation orchestrator): an OpenAI-compatible endpoint over
 * many hosted models, paid from a prepaid credit balance that the API reports itself, so the
 * router reads the real balance instead of counting usage. The key goes only into the
 * Authorization header; errors carry codes, never the key or request data.
 */
export const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export type AiGatewayCredits = Readonly<{ balanceUsd: number; usedUsd: number }>;

/** The balance, or "invalid" when the key is refused; throws on any other failure. */
export const aiGatewayCredits = async (
  apiKey: string,
  doFetch: typeof fetch = fetch,
): Promise<AiGatewayCredits | "invalid"> => {
  const response = await doFetch(`${AI_GATEWAY_BASE_URL}/credits`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (response.status === 401 || response.status === 403) return "invalid";
  if (!response.ok) throw new Error(`ai_gateway_credits_${response.status}`);
  const body = (await response.json()) as { balance?: unknown; total_used?: unknown };
  const balanceUsd = Number(body.balance);
  const usedUsd = Number(body.total_used);
  if (!Number.isFinite(balanceUsd) || !Number.isFinite(usedUsd))
    throw new Error("ai_gateway_credits_invalid");
  return { balanceUsd, usedUsd };
};
