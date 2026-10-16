import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BRAND_KIT, mergeBrandKit } from "@money-maker/core/brand/brand-kit";
import { parseSubjectBoxes } from "@money-maker/core/creatives/in-scene-fidelity";
import { subjectsOnCanvas } from "@money-maker/core/creatives/subject-layout";
import {
  type CanvasKind,
  type SlideSpec,
  templateFor,
  validateSlideSpec,
} from "@money-maker/core/creatives/templates";
import { createSharpCreativeRenderer } from "@money-maker/providers/media/sharp-creative-renderer";
import sharp from "sharp";
import { bubbleSvg, layoutBubble, obstaclesFrom } from "./speech-bubble.js";

/**
 * Previews finished posts: text rendered by our renderer over the approved edit-bench scenes.
 * The copy below is PREVIEW copy built from facts verified on live offers. It is not a fixture
 * of record and must not be published without the normal approval flow.
 */
type PreviewCase = Readonly<{
  niche: "Casa" | "Beleza" | "Tech";
  logoId: string;
  canvas: CanvasKind;
  headline: string;
  body: string;
  badge: string;
  cta?: string;
  /** Reel story beats: the character's line, drawn in a speech bubble on the `.reel.jpg` frame. */
  bubble?: string;
}>;

export const LOGO = {
  Casa: "80a79afc-bd6a-44ae-8f97-25727cad3741",
  Beleza: "536bcb9c-95ae-4c20-88b7-ac29e9a7607b",
  Tech: "984b4112-2dab-4809-8dd9-31d0b03b740d",
} as const;
// Preview-only palettes. Production palettes come from the niche brandKit context (same
// palette.dark / palette.light / palette.accent fields).
export const PALETTE = {
  Beleza: { dark: "#7A1F45", accent: "#E8478B", light: "#FCE4EE" },
  Casa: { dark: "#2F4A3A", accent: "#5E9474", light: "#E6F0E9" },
  Tech: { dark: "#1E2A38", accent: "#17A9CC", light: "#E1F3F8" },
} as const;
const c = (
  niche: PreviewCase["niche"],
  canvas: CanvasKind,
  headline: string,
  body: string,
  badge: string,
  cta?: string,
  bubble?: string,
): PreviewCase => ({
  niche,
  logoId: LOGO[niche],
  canvas,
  headline,
  body,
  badge,
  ...(cta ? { cta } : {}),
  ...(bubble ? { bubble } : {}),
});

export const PREVIEW_CASES: Readonly<Record<string, PreviewCase>> = {
  casa_feed: c(
    "Casa",
    "feed",
    "Toalha e shampoo\nem cima da pia?",
    "Estante plástica de 3 prateleiras para banheiro, lavanderia ou cozinha.",
    "De R$ 52,90 por R$ 36,85",
    "Link na bio",
  ),
  casa_story: c(
    "Casa",
    "story",
    "Banheiro pequeno,\ntudo no lugar.",
    "Confira medidas e limite de peso no anúncio.",
    "R$ 36,85 (30% off)",
    "Link na bio",
  ),
  beleza_feed: c(
    "Beleza",
    "feed",
    "Seu batom sumiu\nna bagunça?",
    "Organizador de acrílico transparente com gavetas: tudo à vista.",
    "De R$ 78,99 por R$ 48,99",
    "Link na bio",
  ),
  beleza_story: c(
    "Beleza",
    "story",
    "Achou o batom\nde primeira.",
    "Acrílico transparente e portátil. Confira as medidas no anúncio.",
    "R$ 48,99 (37% off)",
    "Link na bio",
  ),
  tech_feed: c(
    "Tech",
    "feed",
    "Fio puxando o celular\nno meio da reunião?",
    "Fone TWS Bluetooth 5.3 com estojo de carga. Confira a compatibilidade.",
    "R$ 29,99",
    "Link na bio",
  ),
  tech_story: c(
    "Tech",
    "story",
    "O celular fica na mesa,\nvocê anda pela sala.",
    "Estojo de carga incluso.",
    "R$ 29,99",
    "Link na bio",
  ),
  casa_problem: c(
    "Casa",
    "feed",
    "Banheiro pequeno,\ntoalha por todo lado?",
    "Sem lugar para guardar, tudo acaba na pia.",
    "Organização que falta",
    undefined,
    "Cadê lugar pra toalha?",
  ),
  casa_problem2: c(
    "Casa",
    "feed",
    "E quando tudo\ncai da pia?",
    "Sem prateleira, o banheiro vira bagunça.",
    "",
    undefined,
    "De novo no chão?!",
  ),
  casa_discovery: c(
    "Casa",
    "feed",
    "Até que a Carla\nachou a estante.",
    "Estante preta de 3 prateleiras.",
    "",
    undefined,
    "Uma estante de três prateleiras?",
  ),
  casa_result: c(
    "Casa",
    "feed",
    "Tudo no lugar,\nbanheiro em ordem.",
    "Estante preta de 3 prateleiras.",
    "",
    undefined,
    "Agora sim, tudo no lugar!",
  ),
  beleza_problem: c(
    "Beleza",
    "feed",
    "Maquiagem espalhada\nna bancada?",
    "Procurar o batom no meio da bagunça toda manhã.",
    "Organização que falta",
    undefined,
    "Cadê meu batom?",
  ),
  beleza_problem2: c(
    "Beleza",
    "feed",
    "Atrasada de novo\npor causa do batom?",
    "A bancada lotada não deixa achar nada.",
    "",
    undefined,
    "Vou me atrasar de novo!",
  ),
  beleza_discovery: c(
    "Beleza",
    "feed",
    "Até que a Bia achou\no organizador.",
    "Acrílico transparente, com gavetas.",
    "",
    undefined,
    "Gavetas e tudo à vista?",
  ),
  beleza_result: c(
    "Beleza",
    "feed",
    "Tudo à vista,\ntudo no lugar.",
    "Organizador de acrílico transparente com gavetas.",
    "",
    undefined,
    "Achei de primeira!",
  ),
  tech_problem: c(
    "Tech",
    "feed",
    "Fio enroscado\nna videochamada?",
    "O celular sai da mesa junto com o fone.",
    "Sem fio, sem enrosco",
    undefined,
    "De novo esse fio?",
  ),
  tech_problem2: c(
    "Tech",
    "feed",
    "E o celular\nvai junto pro chão?",
    "O fio enrosca e puxa tudo da mesa.",
    "",
    undefined,
    "Lá se foi o celular...",
  ),
  tech_discovery: c(
    "Tech",
    "feed",
    "Até que o Rafa\nachou o fone sem fio.",
    "Fone TWS Bluetooth 5.3 com estojo de carga.",
    "",
    undefined,
    "Sem fio e com estojo?",
  ),
  tech_result: c(
    "Tech",
    "feed",
    "Livre para andar\ne conversar.",
    "Fone TWS Bluetooth 5.3 com estojo de carga.",
    "",
    undefined,
    "Agora eu ando pela sala!",
  ),
};

export const specFor = (item: PreviewCase): SlideSpec => ({
  index: 1,
  total: 1,
  template: item.canvas === "feed" ? "hero" : "cta",
  headline: item.headline,
  body: item.body,
  ...(item.badge ? { badge: item.badge } : {}),
  disclosure: "#publi",
  claims: [],
});

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const ASSET_BASE =
  "https://mcp.example.com/v1/public/workspaces/WORKSPACE_ID/assets/";

export type PostPreviewOptions = Readonly<{
  inDir: string;
  /** Scene folder under `inDir` (default `images`); `images-2x/<caseId>.png` wins when present. */
  imagesDir?: string;
  outDir: string;
  doFetch?: Fetch;
  log?: (line: string) => void;
}>;

export const runPostPreview = async (
  options: PostPreviewOptions,
): Promise<{ written: string[]; missing: string[] }> => {
  const log = options.log ?? console.log;
  const doFetch = options.doFetch ?? fetch;
  const renderer = createSharpCreativeRenderer();
  const logos = new Map<string, Uint8Array | null>();
  const logoFor = async (id: string): Promise<Uint8Array | null> => {
    if (!logos.has(id)) {
      const bytes = await doFetch(`${ASSET_BASE}${id}`, { redirect: "follow" })
        .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null))
        .catch(() => null);
      if (!bytes) log(`logo ${id} unavailable: rendering without logo`);
      logos.set(id, bytes);
    }
    return logos.get(id) ?? null;
  };
  await mkdir(options.outDir, { recursive: true });
  const written: string[] = [];
  const missing: string[] = [];
  for (const [caseId, item] of Object.entries(PREVIEW_CASES)) {
    // Real-ESRGAN x2 output (`desktop.sh ampliar`) is sharper than lanczos from 512 px.
    const imagesDir = options.imagesDir ?? "images";
    const upscaled = await readFile(join(options.inDir, "images-2x", `${caseId}.png`)).catch(
      () => null,
    );
    const scene =
      upscaled ??
      (await readFile(join(options.inDir, imagesDir, `${caseId}.png`)).catch(() => null));
    if (!scene) {
      missing.push(caseId);
      log(`skipped ${caseId}: no scene in ${join(options.inDir, imagesDir)}`);
      continue;
    }
    if (upscaled) log(`${caseId}: using images-2x`);
    const spec = specFor(item);
    const verdict = validateSlideSpec(spec);
    if (!verdict.ok) throw new Error(`post_preview_copy_invalid:${caseId}:${verdict.reason}`);
    const logo = await logoFor(item.logoId);
    // Sidecar from `fidelity-bench`: where the faces and the product are, so text avoids them.
    const sidecar = await readFile(
      join(options.inDir, "images", `${caseId}.subjects.json`),
      "utf8",
    ).catch(() => null);
    let subjects: ReturnType<typeof parseSubjectBoxes> = null;
    if (sidecar !== null) {
      try {
        subjects = parseSubjectBoxes(JSON.parse(sidecar));
      } catch {
        subjects = null;
      }
      log(
        subjects
          ? `${caseId}: keeping text off ${subjects.length} subject box(es)`
          : `${caseId}: subjects.json invalid, default layout`,
      );
    }
    const render = (slide: SlideSpec, captionBand?: { top: number; bottom: number }) =>
      renderer.render({
        ...(captionBand ? { captionBand } : {}),
        canvas: item.canvas,
        template: templateFor(slide.template, item.canvas),
        spec: slide,
        brand: mergeBrandKit(DEFAULT_BRAND_KIT, {
          brandName: "Example Shop",
          nicheLabel: item.niche,
          palette: PALETTE[item.niche],
        }),
        product: { inScene: true },
        ...(item.cta ? { cta: item.cta } : {}),
        background: { png: new Uint8Array(scene) },
        ...(logo ? { logo: { png: logo } } : {}),
        ...(subjects ? { subjects } : {}),
      });
    const file = join(options.outDir, `${caseId}.jpg`);
    await writeFile(file, (await render(spec)).bytes);
    // Reel frames drop the body card: the narration says it and the captions take its place.
    const { body: _body, ...reelSpec } = spec;
    // The reel centres the 4:5 slide on 9:16 and burns captions about 576 px above the bottom
    // (boxed theme), i.e. 70-82% down the slide: keep that band empty.
    const band = { top: 0.7, bottom: 0.82 };
    const reel = await render(reelSpec, band);
    let frame: Uint8Array = reel.bytes;
    if (item.bubble) {
      const canvas = { w: reel.width, h: reel.height };
      const meta = subjects ? await sharp(scene).metadata() : null;
      const onCanvas =
        subjects && meta?.width && meta.height
          ? subjectsOnCanvas(subjects, { w: meta.width, h: meta.height }, canvas)
          : [];
      const drawn = Object.values(reel.layout.boxes ?? {}).filter((box) => box !== undefined);
      const { avoid, speaker } = obstaclesFrom(onCanvas, drawn);
      const bubble = layoutBubble({
        canvas,
        text: item.bubble,
        avoid,
        band: { top: band.top * canvas.h, bottom: band.bottom * canvas.h },
        ...(speaker ? { speaker } : {}),
      });
      if (bubble)
        frame = await sharp(reel.bytes)
          .composite([{ input: Buffer.from(bubbleSvg(canvas, bubble)) }])
          .jpeg({ quality: 92 })
          .toBuffer();
      else log(`${caseId}: no clear spot for the speech bubble, frame without it`);
    }
    await writeFile(join(options.outDir, `${caseId}.reel.jpg`), frame);
    written.push(file);
    log(`wrote ${file}`);
  }
  log(
    `done: ${written.length} written, ${missing.length} skipped (${missing.join(", ") || "none"})`,
  );
  return { written, missing };
};

const flag = (args: readonly string[], name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

if (process.argv[1]?.endsWith("post-preview.js")) {
  const args = process.argv.slice(2);
  const inDir = flag(args, "in") ?? "edit-bench-out";
  const imagesDir = flag(args, "images-dir");
  void runPostPreview({
    inDir,
    outDir: flag(args, "out") ?? join(inDir, "posts"),
    ...(imagesDir ? { imagesDir } : {}),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "post preview failed");
    process.exitCode = 1;
  });
}
