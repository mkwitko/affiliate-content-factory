import { describe, expect, it } from "vitest";
import type { CreativeFeatures } from "../content/content.js";
import {
  type MusicTrack,
  moodsForPost,
  nicheWords,
  readNicheMusicPrefs,
  selectReelTrack,
  trackAllowedOn,
} from "./reel-music.js";

const track = (id: string): MusicTrack => {
  const [niche = "", mood = ""] = id.split("/");
  return { id, niche, mood: mood as MusicTrack["mood"], file: `/music/${id}` };
};
const features = (overrides: Partial<CreativeFeatures> = {}): CreativeFeatures => ({
  hookMove: "contrast",
  angle: "altura da tela",
  proofType: "rating",
  urgency: "none",
  priceShown: true,
  discountShown: false,
  ratingShown: true,
  ...overrides,
});
const library = [
  track("casa/calm/a.mp3"),
  track("casa/energetic/b.mp3"),
  track("tech/energetic/c.mp3"),
  track("geral/upbeat/d.mp3"),
];

describe("reel music selection", () => {
  it("reads niche words from the slug or the name, without accents", () => {
    expect(nicheWords({ slug: "exampleshop-casa", name: "x" })).toEqual(["exampleshop", "casa"]);
    expect(nicheWords({ name: "Example Shop Eletrônicos" })).toContain("eletronicos");
  });

  it("maps the hook move and urgency to moods", () => {
    expect(moodsForPost(undefined)).toEqual([]);
    expect(moodsForPost(features({ hookMove: "curiosity_gap" }))).toEqual(["calm", "elegant"]);
    expect(moodsForPost(features({ hookMove: "curiosity_gap", urgency: "scarcity" }))[0]).toBe(
      "energetic",
    );
  });

  it("prefers the niche folder and the post's mood", () => {
    const pick = (hookMove: CreativeFeatures["hookMove"]) =>
      selectReelTrack({
        tracks: library,
        nicheWords: ["exampleshop", "casa"],
        features: features({ hookMove }),
        recentTrackIds: [],
      })?.id;
    expect(pick("contrast")).toBe("casa/energetic/b.mp3");
    expect(pick("curiosity_gap")).toBe("casa/calm/a.mp3");
  });

  it("never picks another niche's folder while its own or geral has tracks", () => {
    const picked = selectReelTrack({
      tracks: library,
      nicheWords: ["beleza"],
      features: features({ hookMove: "contrast" }),
      recentTrackIds: [],
    });
    expect(picked?.id).toBe("geral/upbeat/d.mp3");
  });

  it("rotates away from recent tracks, reusing the one used longest ago", () => {
    const pick = (recentTrackIds: string[]) =>
      selectReelTrack({
        tracks: library,
        nicheWords: ["casa"],
        features: features({ hookMove: "contrast" }),
        recentTrackIds,
      })?.id;
    expect(pick(["casa/energetic/b.mp3"])).toBe("casa/calm/a.mp3");
    expect(pick(["casa/energetic/b.mp3", "casa/calm/a.mp3", "geral/upbeat/d.mp3"])).toBe(
      "geral/upbeat/d.mp3",
    );
  });

  it("falls back to any track when no folder fits, and to none for an empty library", () => {
    expect(
      selectReelTrack({
        tracks: [track("tech/energetic/c.mp3")],
        nicheWords: ["casa"],
        recentTrackIds: [],
      })?.id,
    ).toBe("tech/energetic/c.mp3");
    expect(
      selectReelTrack({ tracks: [], nicheWords: ["casa"], recentTrackIds: [] }),
    ).toBeUndefined();
  });
});

describe("niche music preferences", () => {
  it("niche moods take precedence over the post's mood", () => {
    const pick = (nicheMoods: MusicTrack["mood"][]) =>
      selectReelTrack({
        tracks: library,
        nicheWords: ["casa"],
        features: features({ hookMove: "contrast" }),
        nicheMoods,
        recentTrackIds: [],
      })?.id;
    expect(pick([])).toBe("casa/energetic/b.mp3");
    expect(pick(["calm"])).toBe("casa/calm/a.mp3");
  });

  it("reads moods and volume, dropping invalid entries", () => {
    expect(
      readNicheMusicPrefs({ context: { music: { moods: ["calm", "loud"], volume: "low" } } }),
    ).toEqual({
      moods: ["calm"],
      volume: "low",
    });
    expect(readNicheMusicPrefs(null)).toEqual({ moods: [] });
    expect(readNicheMusicPrefs({ context: { music: { volume: "max" } } })).toEqual({ moods: [] });
  });
});

describe("music licensed per platform", () => {
  const meta = {
    id: "casa/calm/meta.m4a",
    niche: "casa",
    mood: "calm" as const,
    file: "/m/meta.m4a",
    platforms: ["instagram", "facebook"] as const,
  };
  const open = {
    id: "casa/calm/cc0.m4a",
    niche: "casa",
    mood: "calm" as const,
    file: "/m/cc0.m4a",
  };
  it("never picks a track whose licence does not cover the platform", () => {
    expect(trackAllowedOn(meta, "instagram")).toBe(true);
    expect(trackAllowedOn(meta, "tiktok")).toBe(false);
    expect(trackAllowedOn(open, "tiktok")).toBe(true);
    const pick = (platform: "instagram" | "tiktok", tracks: readonly MusicTrack[] = [meta]) =>
      selectReelTrack({ tracks, nicheWords: ["casa"], recentTrackIds: [], platform })?.id;
    expect(pick("instagram")).toBe(meta.id);
    expect(pick("tiktok")).toBeUndefined();
    expect(pick("tiktok", [meta, open])).toBe(open.id);
  });
});
