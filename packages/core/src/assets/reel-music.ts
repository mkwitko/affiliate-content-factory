import type { CreativeFeatures } from "../content/content.js";

/**
 * Picks a Reel's background track from the owner's licensed library by niche, the post's
 * creative choices, and recent use, so Reels do not repeat the same song. Pure: the library
 * listing lives in packages/providers.
 */
export const reelMoods = ["energetic", "upbeat", "calm", "elegant"] as const;
export type ReelMood = (typeof reelMoods)[number];
/** Tracks in this folder fit any niche. */
export const anyNicheFolder = "geral";

export type MusicTrack = Readonly<{
  /** Stable library-relative id, "<niche>/<mood>/<file>", stored on the render. */
  id: string;
  niche: string;
  mood: ReelMood;
  /** Opaque locator the renderer reads. */
  file: string;
  /** Licence recorded in the library manifest; absent when the library has no manifest. */
  license?: string;
  /** Tempo from the manifest; Reel cuts land on its beats. */
  bpm?: number;
  /**
   * Platforms the licence allows (manifest), e.g. Meta Sound Collection tracks only inside
   * Instagram and Facebook. Absent: no restriction on record.
   */
  platforms?: readonly MusicPlatform[];
}>;

export const musicPlatforms = ["instagram", "facebook", "tiktok", "youtube", "threads"] as const;
export type MusicPlatform = (typeof musicPlatforms)[number];
export const trackAllowedOn = (track: MusicTrack, platform: MusicPlatform): boolean =>
  !track.platforms || track.platforms.includes(platform);

export interface MusicLibrary {
  listTracks(): Promise<readonly MusicTrack[]>;
}

/** Mood order for the post: a fast hook or scarcity wants energy; a curiosity gap, calm. */
export const moodsForPost = (features: CreativeFeatures | undefined): readonly ReelMood[] => {
  if (!features) return [];
  if (features.urgency === "scarcity") return ["energetic", "upbeat"];
  switch (features.hookMove) {
    case "contrast":
    case "bold_claim":
      return ["energetic", "upbeat"];
    case "proof_first":
      return ["upbeat", "energetic"];
    case "curiosity_gap":
      return ["calm", "elegant"];
    default:
      return [];
  }
};

/** "exampleshop-casa" or "Example Shop Beleza" -> words a niche folder name can match. */
export const nicheWords = (niche: Readonly<{ slug?: string; name: string }>): readonly string[] =>
  (niche.slug ?? niche.name)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

export const musicVolumes = ["low", "medium", "high"] as const;
export type MusicVolume = (typeof musicVolumes)[number];
/** Multiplier on the renderer's music level (under a voice: 0.5, alone: 0.35); medium is today's. */
export const musicGain: Readonly<Record<MusicVolume, number>> = { low: 0.6, medium: 1, high: 1.5 };

export type NicheMusicPrefs = Readonly<{ moods: readonly ReelMood[]; volume?: MusicVolume }>;

/** Niche context `music {moods, volume}`; invalid entries are dropped (the MCP boundary validates). */
export const readNicheMusicPrefs = (
  niche: Readonly<{ context?: Readonly<Record<string, unknown>> | null }> | null | undefined,
): NicheMusicPrefs => {
  const raw = niche?.context?.["music"];
  const music = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const moods = Array.isArray(music["moods"])
    ? reelMoods.filter((mood) => (music["moods"] as unknown[]).includes(mood))
    : [];
  const volume = musicVolumes.find((entry) => entry === music["volume"]);
  return { moods, ...(volume ? { volume } : {}) };
};

export const recentTrackLimit = 10;

export const selectReelTrack = (
  input: Readonly<{
    tracks: readonly MusicTrack[];
    nicheWords: readonly string[];
    features?: CreativeFeatures;
    /** The niche's preferred moods; they rank ahead of the post's own mood order. */
    nicheMoods?: readonly ReelMood[];
    /** Track ids of this workspace's latest Reels, most recent first, at most recentTrackLimit. */
    recentTrackIds: readonly string[];
    /** Only tracks whose licence covers this platform. */
    platform?: MusicPlatform;
  }>,
): MusicTrack | undefined => {
  const licensed = input.platform
    ? input.tracks.filter((track) => trackAllowedOn(track, input.platform as MusicPlatform))
    : input.tracks;
  if (licensed.length === 0) return undefined;
  const forNiche = licensed.filter(
    (track) => track.niche === anyNicheFolder || input.nicheWords.includes(track.niche),
  );
  // A library with no folder for this niche and no geral folder still beats a silent Reel.
  const candidates = forNiche.length > 0 ? forNiche : licensed;
  const nicheMoods = input.nicheMoods ?? [];
  const moods = [
    ...nicheMoods,
    ...moodsForPost(input.features).filter((mood) => !nicheMoods.includes(mood)),
  ];
  const recent = input.recentTrackIds.slice(0, recentTrackLimit);
  const score = (track: MusicTrack) => {
    const moodIndex = moods.indexOf(track.mood);
    const recentIndex = recent.indexOf(track.id);
    return (
      (input.nicheWords.includes(track.niche) ? 4 : 0) +
      (moodIndex >= 0 ? Math.max(1, 3 - moodIndex) : 0) -
      // Any recent use outweighs fit (at most 7); each step back in time outweighs it too, so
      // among used tracks the one used longest ago wins.
      (recentIndex >= 0 ? 10 * (recentTrackLimit - recentIndex) : 0)
    );
  };
  return [...candidates]
    .sort((left, right) => score(right) - score(left) || left.id.localeCompare(right.id))
    .at(0);
};
