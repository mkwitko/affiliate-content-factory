import { describe, expect, it } from "vitest";
import type { ScriptBeat } from "../content/editorial.js";
import type { HookContract, PackagingVariant } from "./episode-idea.js";
import { reviewHook } from "./hook-review.js";

// 165 wpm in English: 11 words per 4 seconds, so 30 s is about 82 words.
const filler = (n: number, tag = "w") =>
  Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
const contract: HookContract = {
  packagingPromise: "p",
  firstVisual: "v",
  proofOrTensionBySecond: 8,
  firstOpenLoop: "l",
  firstOpenLoopBySecond: 10,
  firstPartialPayoffBySecond: 25,
  prohibitedIntroElements: ["channel intro"],
};
const variant = { title: "Why Supermarkets Put Milk in the Back" } as PackagingVariant;
const good = {
  body: `Supermarkets put milk in the back for a reason. ${filler(120)}`,
  language: "en",
  beats: [
    { kind: "hook", atChar: 0 },
    { kind: "open_loop", atChar: 20 },
    { kind: "number_reveal", atChar: 40 },
  ] as readonly ScriptBeat[],
};
const run = (script: Partial<typeof good> = {}, forbiddenPhrases: string[] = ["game changer"]) =>
  reviewHook({ script: { ...good, ...script }, contract, variant, forbiddenPhrases });
const result = (review: ReturnType<typeof run>, name: string) =>
  review.checks.find((c) => c.name === name)?.result;

describe("reviewHook", () => {
  it("passes every check for a script that delivers its packaging promise", () => {
    const review = run();
    expect(review.checks.map((c) => c.name)).toEqual([
      "generic_intro",
      "title_confirmation",
      "open_loop",
      "first_payoff",
      "proof_or_tension",
      "forbidden_phrases",
    ]);
    expect(review.checks.every((c) => c.result === "PASS")).toBe(true);
    expect(review.mainIssue).toBeUndefined();
  });
  it("warns on a template opener and on a prohibited intro element in the first 30 s", () => {
    expect(
      result(run({ body: `Welcome back to the channel. ${filler(100)}` }), "generic_intro"),
    ).toBe("WARN");
    expect(
      result(run({ body: `Quick channel intro first. ${filler(100)}` }), "generic_intro"),
    ).toBe("WARN");
    const late = `${filler(100)} channel intro`;
    expect(result(run({ body: late }), "generic_intro")).toBe("PASS");
  });
  it("warns when the title's words never appear in the first 30 s", () => {
    expect(result(run({ body: filler(150) }), "title_confirmation")).toBe("WARN");
    const late = `${filler(100)} supermarkets milk back`;
    expect(result(run({ body: late }), "title_confirmation")).toBe("WARN");
  });
  it("holds the open loop to the contract's second, not the 30 s window", () => {
    // Word 45 is about 16 s in, inside 30 s but after the contract's second 10.
    const at = good.body.indexOf(" w37 ") + 1;
    const beats = [
      { kind: "hook", atChar: 0 },
      { kind: "open_loop", atChar: at },
    ] as ScriptBeat[];
    expect(result(run({ beats }), "open_loop")).toBe("WARN");
  });

  it("warns when no open_loop beat starts within 30 s", () => {
    expect(result(run({ beats: [{ kind: "hook", atChar: 0 }] }), "open_loop")).toBe("WARN");
    const late = [{ kind: "open_loop", atChar: good.body.length - 5 }] as ScriptBeat[];
    expect(result(run({ beats: late }), "open_loop")).toBe("WARN");
  });
  it("warns when no payoff, promise or number_reveal lands by the contract second", () => {
    const none = [{ kind: "hook", atChar: 0 }] as ScriptBeat[];
    expect(result(run({ beats: none }), "first_payoff")).toBe("WARN");
    const late = [{ kind: "payoff", atChar: good.body.length - 5 }] as ScriptBeat[];
    expect(result(run({ beats: late }), "first_payoff")).toBe("WARN");
    const promise = [{ kind: "promise", atChar: 10 }] as ScriptBeat[];
    expect(result(run({ beats: promise }), "first_payoff")).toBe("PASS");
  });
  it("warns when only the hook lands before the proof-or-tension second", () => {
    const hookOnly = [{ kind: "hook", atChar: 0 }] as ScriptBeat[];
    expect(result(run({ beats: hookOnly }), "proof_or_tension")).toBe("WARN");
  });
  it("warns on a forbidden phrase anywhere in the body, ignoring case", () => {
    const review = run({ body: `${good.body} This is a Game Changer.` });
    expect(result(review, "forbidden_phrases")).toBe("WARN");
    expect(review.mainIssue).toContain("game changer");
  });
  it("names the first warning as the main issue", () => {
    const review = run({ beats: [{ kind: "hook", atChar: 0 }] });
    expect(review.mainIssue).toBe(review.checks.find((c) => c.result === "WARN")?.note);
  });
});
