/**
 * A replaceable compositing port: turns one carousel slide image (typically 4:5, 1080x1350)
 * into a 1080x1920 Stories image, the same full-bleed technique render_reel uses per frame
 * (the slide centered over a blurred, darkened copy of itself). Core defines only the shape;
 * packages/providers holds the sharp implementation so core stays free of image libraries.
 */
export type StoryImageComposerInput = Readonly<{
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}>;

export type StoryImageComposerOutput = Readonly<{
  bytes: Uint8Array;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}>;

export interface StoryImageComposer {
  compose(input: StoryImageComposerInput): Promise<StoryImageComposerOutput>;
}
