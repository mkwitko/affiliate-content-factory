import { AI_GATEWAY_BASE_URL } from "../cloud-gpu/ai-gateway.js";

/**
 * Where an OpenAI-compatible chat call goes: the local llama-server (loopback only, no auth), or
 * the Vercel AI Gateway with its key (spec 2026-10-14, cloud route when the desktop is off).
 * Policy model ids are `vercel:<provider>/<model>`; the gateway receives the part after `vercel:`.
 */
export type ChatTargetOptions = Readonly<{
  baseUrl?: string;
  model: string;
  gateway?: Readonly<{ apiKey: string }>;
}>;

export type ChatTarget = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
  /** The id sent on the wire. */
  model: string;
  /** llama.cpp-only request fields (chat_template_kwargs) go only to the local server. */
  extra: Readonly<Record<string, unknown>>;
}>;

export const chatTarget = (
  options: ChatTargetOptions,
  localOrigin: (baseUrl: string) => string,
): ChatTarget => {
  if (options.gateway)
    return {
      url: `${AI_GATEWAY_BASE_URL}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.gateway.apiKey}`,
      },
      model: options.model.replace(/^vercel:/, ""),
      extra: {},
    };
  return {
    url: `${localOrigin(options.baseUrl ?? "")}/v1/chat/completions`,
    headers: { "content-type": "application/json" },
    model: options.model,
    extra: { chat_template_kwargs: { enable_thinking: false } },
  };
};
