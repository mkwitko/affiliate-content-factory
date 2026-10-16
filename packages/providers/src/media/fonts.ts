import { existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fontPaths = {
  400: fileURLToPath(new URL("../../assets/fonts/Inter-Regular.ttf", import.meta.url)),
  700: fileURLToPath(new URL("../../assets/fonts/Inter-Bold.ttf", import.meta.url)),
  800: fileURLToPath(new URL("../../assets/fonts/Inter-ExtraBold.ttf", import.meta.url)),
} as const;

export const fontFile = (weight: 400 | 700 | 800): string => fontPaths[weight];

export const assertFontsPresent = (): void => {
  for (const path of Object.values(fontPaths)) {
    if (!existsSync(path)) throw new Error(`font_missing:${path}`);
  }
};

/** Registers bundled Inter with fontconfig for librsvg; the config and cache live in the OS temp directory. */
export const configureBundledFonts = (): void => {
  assertFontsPresent();
  if (process.env.FONTCONFIG_FILE) return;
  const directory = mkdtempSync(join(tmpdir(), "money-maker-fonts-"));
  const fontDirectory = dirname(fontPaths[400]);
  const cacheDirectory = join(directory, "cache");
  mkdirSync(cacheDirectory);
  writeFileSync(
    join(directory, "fonts.conf"),
    `<fontconfig><include>/etc/fonts/fonts.conf</include><dir>${fontDirectory}</dir><cachedir>${cacheDirectory}</cachedir></fontconfig>`,
  );
  process.env.FONTCONFIG_FILE = join(directory, "fonts.conf");
};
