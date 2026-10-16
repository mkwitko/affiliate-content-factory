import { describe, expect, it } from "vitest";
import { computeSetupStages } from "./setup-status.js";

describe("computeSetupStages", () => {
  it("marks the plugins stage unavailable and the first incomplete stage as next", () => {
    const stages = computeSetupStages([
      { id: "niche_research", complete: true },
      { id: "structure", complete: false },
      { id: "integrations", complete: false },
      { id: "first_post", complete: false },
      { id: "automations", complete: false },
    ]);
    expect(stages[0]).toMatchObject({ id: "plugins", status: "unavailable" });
    expect(stages.find((s) => s.id === "niche_research")).toMatchObject({ status: "done" });
    expect(stages.find((s) => s.id === "structure")).toMatchObject({ status: "next" });
    expect(stages.find((s) => s.id === "integrations")).toMatchObject({ status: "pending" });
    expect(stages.find((s) => s.id === "first_post")).toMatchObject({ status: "pending" });
    expect(stages.find((s) => s.id === "automations")).toMatchObject({ status: "pending" });
  });

  it("lets an unavailable stage pass the next slot to the following stage", () => {
    const stages = computeSetupStages([
      { id: "niche_research", complete: "unavailable" },
      { id: "structure", complete: false },
      { id: "integrations", complete: false },
      { id: "first_post", complete: false },
      { id: "automations", complete: false },
    ]);
    expect(stages.find((s) => s.id === "niche_research")).toMatchObject({ status: "unavailable" });
    expect(stages.find((s) => s.id === "structure")).toMatchObject({ status: "next" });
  });

  it("marks every stage done when all inputs are complete", () => {
    const ids = [
      "niche_research",
      "structure",
      "integrations",
      "first_post",
      "automations",
    ] as const;
    const stages = computeSetupStages(ids.map((id) => ({ id, complete: true })));
    expect(stages.every((stage) => stage.id === "plugins" || stage.status === "done")).toBe(true);
  });

  it("has no next stage once everything is done, and forces trailing unavailable stages to pending only when something before them is still incomplete", () => {
    const stages = computeSetupStages([
      { id: "niche_research", complete: true },
      { id: "structure", complete: true },
      { id: "integrations", complete: "unavailable" },
      { id: "first_post", complete: true },
      { id: "automations", complete: true },
    ]);
    expect(stages.some((stage) => stage.status === "next")).toBe(false);
    expect(stages.find((s) => s.id === "integrations")).toMatchObject({ status: "unavailable" });
  });

  it("never gives an optional stage the next slot", () => {
    const stages = computeSetupStages([
      { id: "niche_research", complete: true },
      { id: "structure", complete: true },
      { id: "integrations", complete: true },
      { id: "first_post", complete: true },
      { id: "automations", complete: false, optional: true },
    ]);
    expect(stages.find((s) => s.id === "automations")).toMatchObject({
      status: "pending",
      optional: true,
    });
    expect(stages.some((s) => s.status === "next")).toBe(false);
  });

  it("reports a complete optional stage as done even while a required stage is next", () => {
    const stages = computeSetupStages([
      { id: "niche_research", complete: true },
      { id: "structure", complete: true },
      { id: "integrations", complete: true },
      { id: "first_post", complete: false },
      { id: "automations", complete: true, optional: true },
    ]);
    expect(stages.find((s) => s.id === "first_post")).toMatchObject({ status: "next" });
    expect(stages.find((s) => s.id === "automations")).toMatchObject({ status: "done" });
  });

  it("passes a stage's connections through unchanged", () => {
    const connections = [
      { provider: "post_for_me" as const, required: true, connected: true },
      { provider: "canva" as const, required: false, connected: false },
    ];
    const stages = computeSetupStages([
      { id: "niche_research", complete: true },
      { id: "structure", complete: true },
      { id: "integrations", complete: true, connections },
      { id: "first_post", complete: false },
      { id: "automations", complete: false, optional: true },
    ]);
    expect(stages.find((s) => s.id === "integrations")?.connections).toEqual(connections);
  });

  it("every stage has a non-empty action string", () => {
    const stages = computeSetupStages([
      { id: "niche_research", complete: false },
      { id: "structure", complete: false },
      { id: "integrations", complete: false },
      { id: "first_post", complete: false },
      { id: "automations", complete: false },
    ]);
    for (const stage of stages) expect(stage.action.length).toBeGreaterThan(0);
  });
});
