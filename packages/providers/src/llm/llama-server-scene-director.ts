import { sceneDirectorJsonSchema } from "@money-maker/contracts/scene-spec-schema";
import type {
  SceneDirector,
  SceneDirectorCorrection,
  SceneDirectorInput,
} from "@money-maker/core/explainer/scene-director";
import { directorPlanCatalog, scriptSegments } from "@money-maker/core/content/director-plan";
import { SCENE_PURPOSES } from "@money-maker/core/explainer/scene-spec";

/**
 * Local scene director on llama.cpp's llama-server (OpenAI-compatible /v1/chat/completions).
 * response_format carries the JSON Schema projected from the Zod director plan schema, which
 * llama-server turns into a grammar; the reply is still validated and compiled by directScenes. Only a
 * loopback URL is accepted: llama-server has no authentication (spec 10.1).
 */
export type LlamaServerSceneDirectorOptions = Readonly<{
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** Sampling temperature, 0..1; absent means 0 (greedy, reproducible). */
  temperature?: number;
  fetch?: typeof fetch;
}>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Generous on purpose: latency is what director-bench measures, not a limit to enforce here. */
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TOKENS = 6_000;

const localBaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("scene_director_url_not_local");
  }
  if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK.has(url.hostname))
    throw new Error("scene_director_url_not_local");
  return url.origin;
};

/**
 * SCENE_DIRECTOR_TEMPERATURE: blank means 0, so benchmarks are deterministic by default; a value
 * outside 0..1 throws instead of silently falling back.
 */
export const readSceneDirectorTemperature = (
  env: Readonly<Record<string, string | undefined>>,
): number => {
  const raw = env.SCENE_DIRECTOR_TEMPERATURE?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("scene_director_temperature_invalid");
  return value;
};

/** SCENE_DIRECTOR_URL unset or blank means the local director is disabled. */
export const readSceneDirectorConfig = (
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{ baseUrl: string; model: string; timeoutMs?: number; temperature: number }> | null => {
  const baseUrl = env.SCENE_DIRECTOR_URL?.trim();
  if (!baseUrl) return null;
  // CPU benchmarks need longer than the 300 s default; bounded to 10 s..1 h.
  const timeout = Number(env.SCENE_DIRECTOR_TIMEOUT_MS);
  return {
    baseUrl,
    model: env.SCENE_DIRECTOR_MODEL?.trim() || "local",
    temperature: readSceneDirectorTemperature(env),
    ...(Number.isInteger(timeout) && timeout >= 10_000 && timeout <= 3_600_000
      ? { timeoutMs: timeout }
      : {}),
  };
};

const RULES = `You are the storyboard director of a vertical 1080x1920 stick-figure explainer video.
Reply with JSON {"segments": [...]} and nothing else. Return exactly one entry per listed script segment.
- Set newScene=true when that segment starts a visual scene, or false when it continues the previous scene. Segment 1 must start a scene. Aim for 3 to 12 scenes; the compiler normalizes the final count.
- When newScene=true, include visual with that scene's direction. When newScene=false, include only newScene. The compiler derives all character offsets from this ordered decision list.
- purpose: why the scene exists. Choose useful purposes for intermediate scenes; the compiler sets the first scene to "hook" and ensures a "payoff" exists. Never more than 3 "explanation" scenes in a row.
- background: the setting. Two consecutive scenes must not show the same background, cast in the same pose and position, props and diagram.
- actors: at most 3, only the listed character keys, pose and expression from the lists, position left|center|right; facing and scale are optional.
- actions (optional, per actor): only the listed action types. atWord is the 0-based index of the word inside this scene; indices restart at 0 in every scene and continue across joined segments. At most 6 per actor and 10 per scene. One locomotion (enter, exit, walk_to, jump) at a time; "enter" only as the first move; nothing after "exit". Anchor every action to the word it illustrates and keep it inside the scene's spoken time.
  - point_at {target}: the arm points at a prop {"kind":"prop","index":0}, an overlay {"kind":"overlay","index":0} or the diagram {"kind":"diagram"}; indices are 0-based into this scene's props or overlays and the target must exist. It cannot overlap a pose or a locomotion of the same actor.
  - look_at {target}: the gaze goes to the same targets or to another actor of the scene {"kind":"actor","characterKey":"..."}, never to itself. Two look_at of one actor must not overlap.
  - emote {emotion}: a whole-body moment, one of the listed emotions, at least 900 ms; nothing else of that actor may overlap it.
- props: at most 3 objects from the list.
- diagram (optional): to visualize a verified claim's number give only {"kind":"counter"|"percent","claimRef":<claim index>}; the compiler copies the figure from that claim and drops the diagram when the claim is not a verified fact. flow, timeline and before_after labels use script words and never numbers.
- overlays: request on-screen text by giving an anchorWord copied from this scene's script words, plus position and optional emphasis. The compiler selects a literal excerpt of at most 24 characters and keeps overlays on at most 30% of scenes, prioritizing hook, payoff, then cta.
- motionTokens (optional, per actor, PREFER these over raw actions): {token, atWord, target?} with a listed token id; a token expands into timed actions by itself and counts as one action, so use a token whenever one fits and raw actions only for what no token covers. Give a target when the token is pointing or looking.
- locationId, zoneId, actor anchorId (optional): reference only the listed ids; the zone must belong to the location and allow the scene's shot and actor count. Never give coordinates.
- camera: shot from the listed shots; movement from the listed camera movements. push_in, low_angle and handheld are motivated moves: use them for an escalation, a reveal or tension, not as decoration. Two consecutive scenes must not have the same shot and movement: every scene is a new picture.
- Pacing: do not leave more than about 6 seconds of narration with no action starting; choose a new-scene cut or add a motivated action when needed.
- Narrated motion: when the script says a character walks, goes or moves toward a visible place or object and walk_to is listed, represent that beat with walk_to (or a motion token that walks) anchored to the motion word, in the scene that speaks it.
- Number emphasis: when the script calls attention to a number written in it (for example "look at this number", or a number_proof story beat), show that number in that scene as an overlay anchored on the number word, or as a diagram when a verified claim backs it; when a character is in the scene, use point_at on that overlay or diagram at the number word.
- Prop salience: when a scene mentions more concrete objects than the prop limit, rank them by narrative importance: first the object a character acts on, then the object central to the sentence or the payoff, then the first object named, then supporting objects. Keep the top ones up to the limit, each as the closest listed prop.
- transition: hard_cut|fade|wipe. captionMode: word|line|none.
Never change the script. Never show a number that is not written in the script. When the script describes something the lists cannot show, use the closest listed pose, expression or prop; never invent an action, prop, background or character.`;

type ChatMessage = Readonly<{ role: "system" | "user" | "assistant"; content: string }>;

export const buildSceneDirectorMessages = (
  input: SceneDirectorInput & Readonly<{ correction?: SceneDirectorCorrection | undefined }>,
): readonly ChatMessage[] => {
  const segments = scriptSegments(input.script.body);
  const total = segments.reduce((sum, segment) => sum + segment.words.length, 0);
  let cursor = 0;
  const lines = segments.map((segment, i) => {
    const words =
      input.timing.length === total
        ? input.timing.slice(cursor, cursor + segment.words.length)
        : [];
    cursor += segment.words.length;
    const spoken =
      words.length > 0 ? ` spoken_ms=${(words.at(-1)?.endMs ?? 0) - (words[0]?.startMs ?? 0)}` : "";
    return [
      `S${i + 1} words=${segment.words.length}${spoken}`,
      `  text: ${JSON.stringify(segment.text)}`,
      `  words: ${segment.words.map((word, j) => `${j}:${word}`).join(" ")}`,
    ].join("\n");
  });
  const catalog = directorPlanCatalog(input);
  const segmentAt = (atChar: number) =>
    Math.max(
      segments.findLastIndex((segment) => segment.fromChar <= atChar),
      0,
    ) + 1;
  const beats = input.script.beats.map(
    (beat) => `- ${beat.kind} @ S${segmentAt(beat.atChar)}${beat.label ? `: ${beat.label}` : ""}`,
  );
  const user = [
    `Language: ${input.script.language}. Script length: ${input.script.body.length} characters.`,
    `Characters: ${input.persona.map((c) => `${c.key} (${c.name}, ${c.role})`).join(", ") || "none"}`,
    `purposes: ${SCENE_PURPOSES.join(", ")}`,
    `backgrounds: ${catalog.backgrounds.join(", ")}`,
    `poses: ${catalog.poses.join(", ")}`,
    `expressions: ${catalog.expressions.join(", ")}`,
    `props: ${catalog.props.join(", ")}`,
    `actions: ${catalog.actions.join(", ")}`,
    `emotions: ${catalog.emotions.join(", ")}`,
    `camera movements: ${catalog.cameraMovements.join(", ")}`,
    ...(catalog.motionTokens ? [`motion tokens (prefer): ${catalog.motionTokens.join(", ")}`] : []),
    ...(catalog.shots ? [`shots: ${catalog.shots.join(", ")}`] : []),
    ...(input.locations?.length
      ? [
          `locations: ${input.locations
            .map(
              (location) =>
                `${location.id} [zones: ${location.zones
                  .map(
                    (zone) =>
                      `${zone.id} (shots ${zone.allowedShots.join("/")}, max ${zone.maxActors} actors)`,
                  )
                  .join(
                    ", ",
                  )}; anchors: ${location.anchors.map((anchor) => anchor.id).join(", ")}]`,
            )
            .join("; ")}`,
        ]
      : []),
    beats.length > 0 ? ["Story beats:", ...beats].join("\n") : "Story beats: none",
    `Claims: ${input.script.claims.map((claim, i) => `${i} ${claim.kind} ${JSON.stringify(claim.text)}`).join("; ") || "none"}`,
    `Return segments with newScene/visual entries; visual word indices count across all joined segments in that scene. Available script segments: ${segments.length}.`,
    "Script segments:",
    ...lines,
  ].join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: RULES },
    { role: "user", content: user },
  ];
  if (input.correction) {
    const previous = input.correction.previous;
    messages.push(
      {
        role: "assistant",
        content: typeof previous === "string" ? previous : (JSON.stringify(previous) ?? "null"),
      },
      {
        role: "user",
        content: `That answer was rejected. These are all the problems found; fix every one in this single answer:\n- ${input.correction.errors.join("\n- ")}\nReturn the whole corrected answer. Change only what the errors name.`,
      },
    );
  }
  return messages;
};

export const createLlamaServerSceneDirector = (
  options: LlamaServerSceneDirectorOptions,
): SceneDirector => {
  const origin = localBaseUrl(options.baseUrl);
  const doFetch = options.fetch ?? fetch;
  return {
    async direct(input) {
      const response = await doFetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          messages: buildSceneDirectorMessages(input),
          temperature: options.temperature ?? 0,
          max_tokens: MAX_TOKENS,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "scene_specs",
              schema: sceneDirectorJsonSchema(
                directorPlanCatalog(input),
                scriptSegments(input.script.body).length,
              ),
            },
          },
          // Qwen3.5 thinks by default; templates without the flag ignore it.
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`scene_director_http_${response.status}`);
      const body = (await response.json()) as {
        choices?: readonly { message?: { content?: unknown }; finish_reason?: unknown }[];
      };
      const choice = body.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string") throw new Error("scene_director_response_invalid");
      // A reply cut by max_tokens is not the requested JSON even if a prefix parses.
      if (choice?.finish_reason === "length") return content;
      try {
        const value: unknown = JSON.parse(content);
        return value;
      } catch {
        return content;
      }
    },
  };
};

export type ServedModelProvenance = Readonly<{
  requestedModel: string;
  /** The id llama-server reports: its --alias, else the GGUF name or file name. */
  servedModel: string | null;
  /** Parameter count read from the GGUF by llama-server (single-model mode), not from a name. */
  servedParams: number | null;
  servedSizeBytes: number | null;
  modelVerified: boolean;
  reason: string | null;
}>;

type ServedModel = Readonly<{
  id?: unknown;
  aliases?: unknown;
  status?: { value?: unknown };
  meta?: { n_params?: unknown; size?: unknown };
}>;

const servedNames = (model: ServedModel): readonly string[] => {
  const id = typeof model.id === "string" ? model.id : "";
  const aliases = Array.isArray(model.aliases)
    ? model.aliases.filter((alias): alias is string => typeof alias === "string")
    : [];
  // A path-like id (no --alias) also answers to its file name with or without ".gguf".
  const file = id.split(/[\\/]/).at(-1) ?? "";
  return [...new Set([id, ...aliases, file, file.replace(/\.gguf$/i, "")])].filter(Boolean);
};

/**
 * Read-only provenance: GET /v1/models on the same loopback origin. Verified only when exactly
 * one loaded model answers to the requested name, and llama-server reports its parameter count
 * from the GGUF. A name match alone proves only the alias; servedParams is the evidence for size.
 */
export const identifyLlamaServerModel = async (
  options: Readonly<{ baseUrl: string; model: string; fetch?: typeof fetch; timeoutMs?: number }>,
): Promise<ServedModelProvenance> => {
  const unverified = (reason: string, model?: ServedModel): ServedModelProvenance => ({
    requestedModel: options.model,
    servedModel: typeof model?.id === "string" ? model.id : null,
    servedParams: typeof model?.meta?.n_params === "number" ? model.meta.n_params : null,
    servedSizeBytes: typeof model?.meta?.size === "number" ? model.meta.size : null,
    modelVerified: false,
    reason,
  });
  const origin = localBaseUrl(options.baseUrl);
  let body: { data?: unknown };
  try {
    const response = await (options.fetch ?? fetch)(`${origin}/v1/models`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) return unverified(`models_http_${response.status}`);
    body = (await response.json()) as { data?: unknown };
  } catch {
    return unverified("models_unreachable");
  }
  const served = (Array.isArray(body.data) ? body.data : []) as readonly ServedModel[];
  // Router mode lists unloaded models too; single-model mode has no status.
  const loaded = served.filter(
    (model) => model.status?.value === undefined || model.status.value === "loaded",
  );
  const matches = loaded.filter((model) => servedNames(model).includes(options.model));
  if (matches.length !== 1)
    return unverified(
      matches.length === 0 ? "requested_model_not_served" : "requested_model_ambiguous",
      loaded.length === 1 ? loaded[0] : undefined,
    );
  const match = matches[0] as ServedModel;
  const result = unverified("served_params_unknown", match);
  return result.servedParams === null ? result : { ...result, modelVerified: true, reason: null };
};
