import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { sceneDirectorJsonSchema } from "@money-maker/contracts/scene-spec-schema";
import { directorPlanCatalog, scriptSegments } from "@money-maker/core/content/director-plan";
import { createContentScript } from "@money-maker/core/content/editorial";
import {
  type SceneDirectorInput,
  STICK_V1_CATALOG,
} from "@money-maker/core/explainer/scene-director";
import { SCENE_PURPOSES } from "@money-maker/core/explainer/scene-spec";
import {
  buildSceneDirectorMessages,
  createLlamaServerSceneDirector,
  identifyLlamaServerModel,
  readSceneDirectorConfig,
} from "./llama-server-scene-director.js";

const body =
  "A chaleira puxa 1.500 watts. Custa R$ 329,90!\r\nEla ferve rápido.  E desliga sozinha";
const input: SceneDirectorInput = {
  script: {
    ...createContentScript({
      workspaceId: parseWorkspaceId("11111111-1111-4111-8111-111111111111"),
      contentItemId: "item-1",
      version: 1,
      body,
      language: "pt-BR",
      claims: [],
      beats: [],
      actorId: parseUserId("22222222-2222-4222-8222-222222222222"),
    }),
    status: "approved",
  },
  persona: [
    {
      key: "alex",
      name: "Alex",
      role: "main",
      rigId: "stick-v1",
      rigVersion: 1,
      palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
    },
  ],
  catalog: STICK_V1_CATALOG,
  timing: [],
};

const reply = (content: string, finishReason = "stop", status = 200) => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
      { status, headers: { "content-type": "application/json" } },
    );
  };
  return { fetchImpl, calls };
};
const director = (fetchImpl: typeof fetch) =>
  createLlamaServerSceneDirector({
    baseUrl: "http://127.0.0.1:18080/",
    model: "qwen",
    fetch: fetchImpl,
  });

describe("scriptSegments", () => {
  it("covers the body exactly and never splits inside a number", () => {
    const segments = scriptSegments(body);
    expect(segments.map((segment) => segment.text).join("")).toBe(body);
    expect(segments.map((segment) => [segment.fromChar, segment.toChar])).toEqual([
      [0, 29],
      [29, 47],
      [47, 66],
      [66, body.length],
    ]);
    expect(segments[0]?.words).toEqual(["A", "chaleira", "puxa", "1", "500", "watts"]);
  });
});

describe("readSceneDirectorConfig", () => {
  it("is disabled unless SCENE_DIRECTOR_URL is set", () => {
    expect(readSceneDirectorConfig({})).toBeNull();
    expect(readSceneDirectorConfig({ SCENE_DIRECTOR_URL: "  " })).toBeNull();
    expect(readSceneDirectorConfig({ SCENE_DIRECTOR_URL: "http://127.0.0.1:18080" })).toEqual({
      baseUrl: "http://127.0.0.1:18080",
      model: "local",
      temperature: 0,
    });
  });

  it("reads SCENE_DIRECTOR_TEMPERATURE from 0 to 1, deterministic 0 by default", () => {
    const url = "http://127.0.0.1:18080";
    expect(
      readSceneDirectorConfig({ SCENE_DIRECTOR_URL: url, SCENE_DIRECTOR_TEMPERATURE: " " }),
    ).toMatchObject({ temperature: 0 });
    for (const [value, temperature] of [
      ["0", 0],
      ["0.35", 0.35],
      ["1", 1],
    ] as const)
      expect(
        readSceneDirectorConfig({ SCENE_DIRECTOR_URL: url, SCENE_DIRECTOR_TEMPERATURE: value }),
      ).toMatchObject({ temperature });
    for (const bad of ["-0.1", "1.5", "abc", "0.2x"])
      expect(() =>
        readSceneDirectorConfig({ SCENE_DIRECTOR_URL: url, SCENE_DIRECTOR_TEMPERATURE: bad }),
      ).toThrow("scene_director_temperature_invalid");
  });

  it("takes a bounded SCENE_DIRECTOR_TIMEOUT_MS for slow (CPU) benchmarks", () => {
    const url = "http://127.0.0.1:18080";
    expect(
      readSceneDirectorConfig({ SCENE_DIRECTOR_URL: url, SCENE_DIRECTOR_TIMEOUT_MS: "1800000" }),
    ).toMatchObject({ timeoutMs: 1_800_000 });
    for (const bad of ["5", "abc", "99999999"])
      expect(
        readSceneDirectorConfig({ SCENE_DIRECTOR_URL: url, SCENE_DIRECTOR_TIMEOUT_MS: bad }),
      ).not.toHaveProperty("timeoutMs");
  });
});

describe("createLlamaServerSceneDirector", () => {
  it.each(["http://10.0.0.5:8080", "https://api.example.com", "not a url", "file:///tmp/x"])(
    "refuses the non-loopback URL %s",
    (baseUrl) => {
      expect(() => createLlamaServerSceneDirector({ baseUrl, model: "m" })).toThrow(
        "scene_director_url_not_local",
      );
    },
  );

  it("posts a JSON-schema request with thinking off and keeps semantic segment choices", async () => {
    const output = { segments: [{ newScene: true, visual: { purpose: "hook" } }] };
    const { fetchImpl, calls } = reply(JSON.stringify(output));
    expect(await director(fetchImpl).direct(input)).toEqual(output);
    expect(calls[0]?.url).toBe("http://127.0.0.1:18080/v1/chat/completions");
    expect(calls[0]?.body).toMatchObject({
      model: "qwen",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "scene_specs",
          schema: sceneDirectorJsonSchema(directorPlanCatalog(input), scriptSegments(body).length),
        },
      },
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0,
    });
  });

  it("sends the configured temperature", async () => {
    const { fetchImpl, calls } = reply("{}");
    await createLlamaServerSceneDirector({
      baseUrl: "http://127.0.0.1:18080",
      model: "qwen",
      temperature: 0.4,
      fetch: fetchImpl,
    }).direct(input);
    expect(calls[0]?.body).toMatchObject({ temperature: 0.4 });
  });

  it("passes a bare array through", async () => {
    const { fetchImpl } = reply(JSON.stringify([{ index: 1 }]));
    expect(await director(fetchImpl).direct(input)).toEqual([{ index: 1 }]);
  });

  it("returns the raw text when the reply is truncated or not JSON", async () => {
    expect(await director(reply('{"segments": [', "length").fetchImpl).direct(input)).toBe(
      '{"segments": [',
    );
    expect(await director(reply("Sure! Here", "stop").fetchImpl).direct(input)).toBe("Sure! Here");
  });

  it("throws on an HTTP error so the use case reports director_unavailable", async () => {
    await expect(director(reply("", "stop", 503).fetchImpl).direct(input)).rejects.toThrow(
      "scene_director_http_503",
    );
  });
});

describe("buildSceneDirectorMessages", () => {
  it("lists numbered segments and per-scene word indices, never character offsets", () => {
    const [, user] = buildSceneDirectorMessages(input);
    expect(user?.content).toContain("S1 words=6");
    expect(user?.content).not.toContain("fromChar");
    expect(user?.content).toContain("words: 0:A 1:chaleira 2:puxa 3:1 4:500 5:watts");
    expect(user?.content).toContain("Characters: alex (Alex, main)");
  });

  it("asks the model for semantic cuts without allowing absolute segment indices", () => {
    const [system, user] = buildSceneDirectorMessages(input);
    expect(user?.content).toContain("Available script segments: 4");
    expect(system?.content).toContain("newScene=true");
    expect(system?.content).toContain("newScene=false");
    expect(system?.content).not.toContain("lastSegment");
    expect(system?.content).not.toContain("fromChar");
  });

  it("offers the actions, camera moves and direction rules the validator enforces", () => {
    const [system, user] = buildSceneDirectorMessages(input);
    expect(user?.content).toContain(
      "actions: enter, exit, walk_to, pose, expression, jump, react, point_at, look_at, emote",
    );
    expect(user?.content).toContain(
      "camera movements: none, slow_zoom_in, slow_zoom_out, pan_left, pan_right, push_in, low_angle, handheld",
    );
    for (const word of ["point_at", "look_at", "emote", "push_in", "same shot and movement"])
      expect(system?.content).toContain(word);
  });

  it("lists the script's story beats by segment", () => {
    const beats = [
      { kind: "hook", atChar: 0, label: "number_proof" },
      { kind: "payoff", atChar: body.indexOf("Ela") },
    ] as const;
    const [, user] = buildSceneDirectorMessages({
      ...input,
      script: { ...input.script, beats },
    });
    expect(user?.content).toContain("Story beats:\n- hook @ S1: number_proof\n- payoff @ S3\n");
    expect(buildSceneDirectorMessages(input)[1]?.content).toContain("Story beats: none\n");
  });

  it("states the semantic rules for narrated motion, number emphasis and prop salience", () => {
    const [system] = buildSceneDirectorMessages(input);
    for (const phrase of [
      "represent that beat with walk_to",
      "use point_at",
      "rank them by narrative importance",
    ])
      expect(system?.content).toContain(phrase);
  });

  it("tells the model to prefer motion tokens and offers only shots that fit any cast", () => {
    const [system, user] = buildSceneDirectorMessages({
      ...input,
      locations: [
        {
          id: "office_a",
          version: 1,
          name: "Office",
          plate: { overscan: 2.2 },
          proceduralFallback: "office",
          zones: [
            {
              id: "desk_medium",
              crop: { cx: 0.5, cy: 0.5, zoom: 1 },
              allowedShots: ["medium"],
              maxActors: 2,
              layouts: [],
            },
          ],
          anchors: [{ id: "desk_left", x: 0.3, y: 0.7, scale: 1, facing: "right", pose: "sit" }],
        },
      ],
    });
    expect(system?.content).toContain("PREFER");
    expect(user?.content).toContain("motion tokens (prefer): POINT_BEAT");
    expect(user?.content).not.toContain("layouts: ");
    expect(user?.content).toContain("shots: wide, medium, close, establishing\n");
    expect(user?.content).toContain(
      "office_a [zones: desk_medium (shots medium, max 2 actors); anchors: desk_left]",
    );
  });

  it("appends the rejected answer and the errors on the correction attempt", () => {
    const messages = buildSceneDirectorMessages({
      ...input,
      correction: {
        previous: [{ index: 1 }],
        errors: [
          "0.background: Invalid option",
          "scene 2 camera [camera_repeated]: Change the camera",
        ],
      },
    });
    expect(messages.slice(-2)).toEqual([
      { role: "assistant", content: '[{"index":1}]' },
      {
        role: "user",
        content:
          "That answer was rejected. These are all the problems found; fix every one in this single answer:\n- 0.background: Invalid option\n- scene 2 camera [camera_repeated]: Change the camera\nReturn the whole corrected answer. Change only what the errors name.",
      },
    ]);
  });
});

/**
 * llama.cpp converts JSON Schema to a grammar in common/json-schema.cpp. It reads type,
 * properties, required, additionalProperties, items, prefixItems, minItems, maxItems, enum,
 * const, oneOf, anyOf, allOf, $ref, pattern, minLength, maxLength, format, and minimum /
 * maximum / exclusive bounds for integers only. Numbers take no bounds, so the three bounded
 * number fields below are enforced by Zod alone.
 */
describe("SceneSpec JSON Schema projection", () => {
  const SUPPORTED = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "enum",
    "const",
    "oneOf",
    "anyOf",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
  ]);
  const schema = sceneDirectorJsonSchema(
    { purposes: SCENE_PURPOSES, ...STICK_V1_CATALOG },
    scriptSegments(body).length,
  );
  const found = {
    keywords: new Set<string>(),
    numberBounds: [] as string[],
    patterns: [] as string[],
  };
  const walk = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const entry = node as Record<string, unknown>;
    for (const key of Object.keys(entry)) found.keywords.add(key);
    if (entry.type === "number" && ("minimum" in entry || "maximum" in entry))
      found.numberBounds.push(path);
    if (typeof entry.pattern === "string") found.patterns.push(entry.pattern);
    for (const [name, child] of Object.entries((entry.properties ?? {}) as Record<string, unknown>))
      walk(child, `${path}.${name}`);
    if (entry.items) walk(entry.items, `${path}[]`);
    for (const key of ["oneOf", "anyOf"])
      if (Array.isArray(entry[key]))
        for (const [i, child] of (entry[key] as unknown[]).entries()) walk(child, `${path}|${i}`);
  };
  walk(schema, "$");

  it("uses only keywords llama.cpp's grammar builder reads", () => {
    expect([...found.keywords].filter((key) => !SUPPORTED.has(key))).toEqual([]);
    expect(found.keywords.has("$schema")).toBe(false);
  });

  it("constrains one decision per available script segment without absolute indices", () => {
    const segments = (schema.properties as Record<string, Record<string, unknown>>).segments;
    expect(segments).toMatchObject({ minItems: 4, maxItems: 4 });
    if (!segments) throw new Error("segments_schema_missing");
    const variants = segments.items as Record<string, unknown>;
    const choices = variants.anyOf ?? variants.oneOf;
    if (!Array.isArray(choices) || typeof choices[0] !== "object" || choices[0] === null)
      throw new Error("segment_union_schema_missing");
    const firstEntry = choices[0] as Record<string, unknown>;
    const entryProperties = firstEntry.properties as Record<string, Record<string, unknown>>;
    const visual = entryProperties.visual?.properties as Record<string, unknown> | undefined;
    expect(visual).toBeDefined();
    expect(visual).not.toHaveProperty("lastSegment");
    expect(visual).not.toHaveProperty("index");
  });

  it("lists the number bounds the grammar cannot enforce (Zod still does), with no diagram figures", () => {
    expect(found.numberBounds).toEqual(["$.segments[]|0.visual.actors[].scale"]);
  });

  it("anchors every pattern, as llama.cpp requires", () => {
    // characterKey appears on actors and on look_at actor targets; location, zone and anchor
    // ids (v2 slice 23) share one pattern.
    expect(new Set(found.patterns)).toEqual(
      new Set(["^[a-z][a-z0-9_]{0,31}$", "^[a-z][a-z0-9_]{0,39}$"]),
    );
    expect(
      found.patterns.every((pattern) => pattern.startsWith("^") && pattern.endsWith("$")),
    ).toBe(true);
  });
});

describe("identifyLlamaServerModel", () => {
  const models = (data: unknown, status = 200) => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      urls.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response(JSON.stringify({ object: "list", data }), { status });
    };
    return { fetchImpl, urls };
  };
  const single = (id: string, n_params?: number) => ({
    id,
    object: "model",
    owned_by: "llamacpp",
    ...(n_params === undefined ? {} : { meta: { n_params, size: 5_600_000_000 } }),
  });
  const identify = (model: string, fetchImpl: typeof fetch) =>
    identifyLlamaServerModel({ baseUrl: "http://127.0.0.1:18080/", model, fetch: fetchImpl });

  it("verifies a single loaded model by alias and records the GGUF parameter count", async () => {
    const { fetchImpl, urls } = models([single("qwen3.8-9b-q4_k_m", 9_000_000_000)]);
    expect(await identify("qwen3.8-9b-q4_k_m", fetchImpl)).toEqual({
      requestedModel: "qwen3.8-9b-q4_k_m",
      servedModel: "qwen3.8-9b-q4_k_m",
      servedParams: 9_000_000_000,
      servedSizeBytes: 5_600_000_000,
      modelVerified: true,
      reason: null,
    });
    expect(urls).toEqual(["GET http://127.0.0.1:18080/v1/models"]);
  });

  it("matches a path id without --alias by file name, with or without .gguf", async () => {
    const { fetchImpl } = models([single("/models/Qwen3.8-9B-Q4_K_M.gguf", 9e9)]);
    expect((await identify("Qwen3.8-9B-Q4_K_M", fetchImpl)).modelVerified).toBe(true);
    expect((await identify("Qwen3.8-9B-Q4_K_M.gguf", fetchImpl)).modelVerified).toBe(true);
  });

  it("does not verify a requested name the server does not serve, even one that says 9b", async () => {
    const { fetchImpl } = models([single("qwen3.8-4b-q4_k_m", 4e9)]);
    expect(await identify("qwen3.8-9b-q4_k_m", fetchImpl)).toMatchObject({
      servedModel: "qwen3.8-4b-q4_k_m",
      servedParams: 4e9,
      modelVerified: false,
      reason: "requested_model_not_served",
    });
  });

  it("does not verify a name match without a parameter count", async () => {
    const { fetchImpl } = models([single("qwen", undefined)]);
    expect(await identify("qwen", fetchImpl)).toMatchObject({
      modelVerified: false,
      reason: "served_params_unknown",
    });
  });

  it("ignores unloaded router models and refuses an ambiguous answer", async () => {
    const router = models([
      { id: "a", aliases: ["qwen"], status: { value: "unloaded" } },
      { id: "b", aliases: ["qwen"], status: { value: "loaded" } },
    ]);
    expect((await identify("qwen", router.fetchImpl)).reason).toBe("served_params_unknown");
    const twice = models([single("qwen", 9e9), single("qwen", 9e9)]);
    expect((await identify("qwen", twice.fetchImpl)).reason).toBe("requested_model_ambiguous");
  });

  it("marks the model unverified when the server errors or is unreachable", async () => {
    expect((await identify("qwen", models([], 500).fetchImpl)).reason).toBe("models_http_500");
    const down: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect((await identify("qwen", down)).reason).toBe("models_unreachable");
  });

  it("stays loopback-only", async () => {
    await expect(
      identifyLlamaServerModel({ baseUrl: "http://192.168.0.10:8080", model: "qwen" }),
    ).rejects.toThrow("scene_director_url_not_local");
  });
});
