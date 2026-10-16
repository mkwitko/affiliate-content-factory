import { describe, expect, it } from "vitest";
import { e2ePipelines } from "./arena-e2e.js";

describe("e2e pipelines", () => {
  it("compares production with a challenger in neutral folders", () => {
    const [a, b] = e2ePipelines([]);
    expect(a).toMatchObject({
      dir: "p1",
      copyModel: "local:qwen3.5-9b",
      imageModel: "local:flux-2-klein-4b",
      reel: "v1",
    });
    expect(b).toMatchObject({ dir: "p2", copyModel: "local:qwen3.5-9b", reel: "parallax" });
    expect(a).toMatchObject({ scenes: "plain" });
    expect(b).toMatchObject({ scenes: "plain" });
    expect(e2ePipelines(["--scenes-a=directed"])[0]).toMatchObject({ scenes: "directed" });
    expect(e2ePipelines(["--scenes-b=directed", "--reel-b=v1"])[1]).toMatchObject({
      scenes: "directed",
      reel: "v1",
    });
    expect(
      e2ePipelines(["--image-b=local:mage-flow-edit-4b-turbo", "--reel-b=v1"])[1],
    ).toMatchObject({ imageModel: "local:mage-flow-edit-4b-turbo", reel: "v1" });
  });
});
