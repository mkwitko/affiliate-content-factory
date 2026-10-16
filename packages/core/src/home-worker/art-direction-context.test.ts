import { describe, expect, it } from "vitest";
import { defaultSceneLine, shotFor } from "../creatives/scene-direction.js";
import { MAX_SCENE_LINE_LENGTH, validateSlideSpec } from "../creatives/slide-spec.js";
import { artDirectionContextOf } from "./tasks.js";

const storyWorld =
  "Bia divide um apê pequeno em Belo Horizonte com a amiga Nanda. O banheiro é compartilhado e a bancada é mínima. Bia é analista de marketing, sai às 7h20 e se arruma em 15 minutos. O que dá errado: maquiagem perdida na bagunça, pincel sujo, produto da Bia usado pela Nanda, pressa antes do trabalho. Luz suave de manhã, paleta rosa-areia, off-white e dourado discreto.";

describe("artDirectionContextOf", () => {
  it("keeps the world to its first sentence so default scene lines fit the slide limit", () => {
    const context = artDirectionContextOf(
      { storyWorld, characters: [{ role: "main", name: "Bia", description: "28 anos" }] },
      "Kit Maleta Maquiagem Infantil Lavável Espelho Fácil Limpar Brinquedo De Beleza Menina",
    );
    expect(context?.world).toBe("Bia divide um apê pequeno em Belo Horizonte com a amiga Nanda");
    for (const template of ["hero", "benefit", "price", "cta"] as const) {
      const line = defaultSceneLine(shotFor({ index: 1, template }, false), context!);
      expect(line.length).toBeLessThanOrEqual(MAX_SCENE_LINE_LENGTH);
      expect(
        validateSlideSpec({
          index: 1,
          total: 1,
          template,
          headline: "x",
          claims: [],
          sceneLine: line,
        }),
      ).toEqual({ ok: true });
    }
  });
});
