import { describe, expect, it } from "vitest";
import type { ExplainerCharacter } from "../explainer/explainer-context.js";
import { STICK_V1_CATALOG } from "../explainer/scene-director.js";
import type { SceneSpec } from "../explainer/scene-spec.js";
import { applyDirectorIntents, type DirectorIntentContext } from "./director-intents.js";
import { claimDiagram } from "./director-plan.js";

const carla: ExplainerCharacter = {
  key: "carla",
  name: "Carla",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
};

/** Three scenes, one per sentence, Carla centered and still, distinct cameras. */
const storyboard = (sentences: readonly string[]) => {
  const body = sentences.join(" ");
  const cameras = ["none", "slow_zoom_in", "slow_zoom_out"] as const;
  let from = 0;
  const scenes = sentences.map((sentence, i): SceneSpec => {
    const to = i === sentences.length - 1 ? body.length : from + sentence.length + 1;
    const scene: SceneSpec = {
      index: i + 1,
      fromChar: from,
      toChar: to,
      purpose: i === 0 ? "hook" : i === sentences.length - 1 ? "payoff" : "explanation",
      background: "kitchen",
      actors: [
        { characterKey: "carla", pose: "neutral", expression: "neutral", position: "center" },
      ],
      props: [],
      overlays: [],
      camera: { shot: "medium", movement: cameras[i % 3] ?? "none" },
      transition: "hard_cut",
      captionMode: "word",
    };
    from = to;
    return scene;
  });
  return { body, scenes };
};

const context = (
  body: string,
  over: Partial<DirectorIntentContext> = {},
): DirectorIntentContext => ({
  body,
  language: "pt-BR",
  claims: [],
  beats: [],
  characters: [carla],
  catalog: STICK_V1_CATALOG,
  ...over,
});

describe("NARRATED_MOVEMENT", () => {
  it("turns a named character walking to a place into walk_to at the motion word", () => {
    const { body, scenes } = storyboard([
      "A Carla abre a porta de casa.",
      "Depois a Carla caminha até a janela da sala.",
      "No fim ela sorri para a rua.",
    ]);
    const out = applyDirectorIntents(scenes, context(body));
    expect(out[1]?.actors[0]?.actions).toEqual([{ type: "walk_to", atWord: 3, to: "right" }]);
    expect(out[0]?.actors[0]?.actions).toBeUndefined();
  });

  it("leaves second-person or unnamed motion alone", () => {
    const { body, scenes } = storyboard([
      "Você vai até o mercado toda semana.",
      "Tudo vai para o carrinho sem pensar.",
      "No fim a conta assusta.",
    ]);
    const out = applyDirectorIntents(scenes, context(body));
    expect(out.flatMap((scene) => scene.actors.flatMap((actor) => actor.actions ?? []))).toEqual(
      [],
    );
  });
});

describe("NUMBER_EMPHASIS", () => {
  const sentences = [
    "Repare neste dado: 42 horas de uso.",
    "É o que a ficha técnica informa.",
    "Dá para a semana inteira.",
  ];
  const claims = [
    {
      text: "A ficha informa 42 horas de uso.",
      kind: "verified_fact" as const,
    },
  ];

  it("shows an attention-called verified number as a literal overlay the actor points at", () => {
    const { body, scenes } = storyboard(sentences);
    const out = applyDirectorIntents(scenes, context(body, { claims }));
    expect(out[0]?.overlays).toEqual([
      { text: "42 horas de uso", position: "top", emphasis: true },
    ]);
    expect(out[0]?.actors[0]?.actions).toEqual([
      { type: "point_at", atWord: 3, target: { kind: "overlay", index: 0 } },
    ]);
  });

  it("follows a number_proof beat without any attention phrase", () => {
    const { body, scenes } = storyboard([
      "São 42 horas de uso por carga.",
      "É o que a ficha técnica informa.",
      "Dá para a semana inteira.",
    ]);
    const out = applyDirectorIntents(
      scenes,
      context(body, { claims, beats: [{ kind: "hook", atChar: 0, label: "number_proof" }] }),
    );
    expect(out[0]?.overlays[0]?.text).toBe("42 horas de uso por");
  });

  it("never emphasizes a number no verified claim states", () => {
    const { body, scenes } = storyboard(sentences);
    const out = applyDirectorIntents(
      scenes,
      context(body, { claims: [{ text: claims[0]?.text ?? "", kind: "fictional_example" }] }),
    );
    expect(out[0]?.overlays).toEqual([]);
  });
});

describe("SALIENT_PROP", () => {
  it("keeps the first named objects up to the prop limit", () => {
    const { body, scenes } = storyboard([
      "Na gaveta ficam quatro coisas: relógio, cartão, celular e notebook.",
      "Ela vivia perdendo alguma.",
      "Agora cada uma tem seu lugar.",
    ]);
    const out = applyDirectorIntents(scenes, context(body));
    expect(out[0]?.props.map((prop) => prop.type)).toEqual(["clock", "card", "phone"]);
  });

  it("ranks the object a character acts on first", () => {
    const { body, scenes } = storyboard([
      "Entre o relógio, o cartão e o celular, a Carla pega o notebook.",
      "Ela vivia perdendo alguma.",
      "Agora cada uma tem seu lugar.",
    ]);
    const out = applyDirectorIntents(scenes, context(body));
    expect(out[0]?.props.map((prop) => prop.type)).toEqual(["laptop", "clock", "card"]);
  });
});

describe("claimDiagram", () => {
  it("copies the figure and a unit word from a verified claim", () => {
    const body = "A bateria dura 57 horas. Isso é muito.";
    expect(
      claimDiagram(
        "counter",
        0,
        [{ text: "O fabricante informa 57 horas de bateria.", kind: "verified_fact" }],
        body,
        "pt-BR",
      ),
    ).toEqual({ kind: "counter", from: 0, to: 57, unit: "horas", claimRef: 0 });
  });

  it("builds a percent with a literal script label and refuses figures the script lacks", () => {
    const body = "Mais de 87% das avaliações dão cinco estrelas.";
    const claims = [
      { text: "87% das avaliações dão cinco estrelas.", kind: "verified_fact" as const },
    ];
    expect(claimDiagram("percent", 0, claims, body, "pt-BR")).toEqual({
      kind: "percent",
      value: 87,
      label: "87% das avaliações dão",
      claimRef: 0,
    });
    expect(
      claimDiagram("counter", 0, [{ text: "São 90 dias.", kind: "verified_fact" }], body, "pt-BR"),
    ).toBeUndefined();
  });
});
