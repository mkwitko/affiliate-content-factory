import { describe, expect, it } from "vitest";
import {
  DIAGRAM_AREA,
  type Diagram,
  diagramNumericRefs,
  diagramSteps,
  renderDiagram,
} from "./diagrams.js";

const palette = { line: "#111111", accent: "#ff5a36", muted: "#d9d9d9", text: "#111111" };

// Icon props draw in their own translated space; only diagram-level coordinates count here.
const coordinates = (svg: string, attribute: "x" | "y"): number[] =>
  [
    ...svg
      .replace(/<g data-prop[^>]*>.*?<\/g>/g, "")
      .matchAll(new RegExp(` ${attribute}[12]?="(-?\\d+(?:\\.\\d+)?)"`, "g")),
  ].map((m) => Number(m[1]));

const samples: readonly Diagram[] = [
  {
    kind: "flow",
    nodes: [
      { id: "c", label: "Customer", icon: "card" },
      { id: "b", label: "Bank" },
      { id: "n", label: "Network" },
      { id: "m", label: "Merchant" },
    ],
    edges: [
      { from: "c", to: "b" },
      { from: "b", to: "n", label: "fee" },
      { from: "n", to: "m" },
    ],
  },
  {
    kind: "bar_compare",
    items: [
      { label: "A", value: 50 },
      { label: "B", value: 100, unit: "%" },
    ],
    claimRef: 0,
  },
  { kind: "counter", from: 0, to: 35000, unit: "ft", claimRef: 1 },
  {
    kind: "timeline",
    points: [
      { label: "Gold", at: "1900" },
      { label: "Paper", at: "1971" },
      { label: "Apps", at: "2020" },
    ],
  },
  { kind: "before_after", before: "Milk at the front", after: "Milk at the back" },
  { kind: "percent", value: 70, label: "of trips", claimRef: 2 },
];

describe("diagrams", () => {
  it("renders a flow with arrows and edge labels", () => {
    const svg = renderDiagram(samples[0] as Diagram, palette);
    expect(svg).toContain("Customer");
    expect(svg).toContain("marker-end");
    expect(svg).toContain("fee");
  });

  it("scales bars to the largest value", () => {
    const svg = renderDiagram(samples[1] as Diagram, palette);
    const heights = [...svg.matchAll(/data-bar="\d+"[^>]* height="(\d+(?:\.\d+)?)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(heights).toHaveLength(2);
    expect((heights[1] ?? 0) / (heights[0] ?? 1)).toBeCloseTo(2, 1);
  });

  it("formats large counter values with separators", () => {
    expect(renderDiagram(samples[2] as Diagram, palette)).toContain("35,000");
  });

  it("keeps every diagram inside the diagram area", () => {
    for (const diagram of samples) {
      const svg = renderDiagram(diagram, palette);
      const ys = coordinates(svg, "y");
      const xs = coordinates(svg, "x");
      expect(Math.max(...ys)).toBeLessThanOrEqual(DIAGRAM_AREA.y + DIAGRAM_AREA.height);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(DIAGRAM_AREA.y);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(DIAGRAM_AREA.x);
      expect(Math.max(...xs)).toBeLessThanOrEqual(DIAGRAM_AREA.x + DIAGRAM_AREA.width);
    }
  });

  it("sizes flow and bar labels to fit their box", () => {
    const sizes = (svg: string, label: string) =>
      [...svg.matchAll(new RegExp(`font-size="([\\d.]+)"[^>]*>${label}<`, "g"))].map((m) =>
        Number(m[1]),
      );
    const long = "Merchant acquiring bank";
    const flowSvg = renderDiagram(
      {
        kind: "flow",
        nodes: [
          { id: "a", label: long },
          { id: "b", label: "Bank" },
        ],
        edges: [{ from: "a", to: "b" }],
      },
      palette,
    );
    for (const size of sizes(flowSvg, long))
      expect(size * long.length * 0.66).toBeLessThanOrEqual(380 - 40);
    const barLabel = "Supermarket back";
    const barSvg = renderDiagram(
      {
        kind: "bar_compare",
        items: [1, 2, 3, 4].map((value) => ({ label: barLabel, value })),
        claimRef: 0,
      },
      palette,
    );
    const barSizes = sizes(barSvg, barLabel);
    expect(barSizes).toHaveLength(4);
    for (const size of barSizes) expect(size * barLabel.length * 0.66).toBeLessThanOrEqual(750 / 4);
  });

  it("escapes labels", () => {
    expect(renderDiagram({ kind: "before_after", before: "<a>", after: "&" }, palette)).toContain(
      "&lt;a&gt;",
    );
  });

  it("lists the claim refs every numeric diagram needs", () => {
    expect(diagramNumericRefs({ kind: "percent", value: 70, label: "x" })).toEqual([undefined]);
    expect(diagramNumericRefs({ kind: "counter", from: 0, to: 9, claimRef: 2 })).toEqual([2]);
    expect(diagramNumericRefs({ kind: "bar_compare", items: [], claimRef: 0 })).toEqual([0]);
    expect(diagramNumericRefs({ kind: "before_after", before: "a", after: "b" })).toEqual([]);
    expect(diagramNumericRefs(samples[0] as Diagram)).toEqual([]);
  });
});

describe("diagram build-up (motion)", () => {
  it("draws exactly the still at full progress", () => {
    for (const diagram of samples)
      expect(renderDiagram(diagram, palette, 1)).toBe(renderDiagram(diagram, palette));
  });

  it("reveals flow nodes in order", () => {
    const flow = samples[0] as Diagram;
    expect(renderDiagram(flow, palette, 0)).not.toContain("Customer");
    const half = renderDiagram(flow, palette, 0.5);
    expect(half).toContain("Customer");
    expect(half).toContain("Bank");
    expect(half).not.toContain("Merchant");
  });

  it("counts a counter and grows bars and percentages towards their values", () => {
    const counter: Diagram = { kind: "counter", from: 0, to: 1000, claimRef: 0 };
    expect(renderDiagram(counter, palette, 0.5)).toContain(">500<");
    const pct: Diagram = { kind: "percent", value: 80, label: "of trips", claimRef: 0 };
    expect(renderDiagram(pct, palette, 0.5)).toContain(">40%<");
    const bar = samples.find((d) => d.kind === "bar_compare") as Diagram;
    expect(renderDiagram(bar, palette, 0.3)).not.toBe(renderDiagram(bar, palette));
  });

  it("names how many build steps each diagram has", () => {
    expect(samples.map((d) => [d.kind, diagramSteps(d)])).toEqual(
      samples.map((d) => [
        d.kind,
        d.kind === "flow"
          ? d.nodes.length
          : d.kind === "bar_compare"
            ? d.items.length
            : d.kind === "timeline"
              ? d.points.length
              : d.kind === "before_after"
                ? 2
                : 1,
      ]),
    );
  });
});
