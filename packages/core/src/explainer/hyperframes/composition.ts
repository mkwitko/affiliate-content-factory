import { actorScaleFor, propAnchor } from "../compose-scene.js";
import { escapeXml, geometryFor, n, positionX } from "../layout.js";
import type { MotionPlan, PlannedActor, PlannedScene } from "../motion/plan.js";

/**
 * Pure mapper from a MotionPlan to a HyperFrames project's index.html (experimental spike,
 * docs/experiments/hyperframes-frame-mapping.md). Every time-dependent decision was already made
 * by planMotion, so this only translates: each scene is a block whose visibility, camera move
 * and reveals are CSS keyframes with ABSOLUTE animation-delay (ms from composition start), which
 * HyperFrames seeks frame by frame. No scripts, no network references, no CDN.
 */
export type HyperFramesTokens = Readonly<Record<string, string>>;
export type CompositionAudio = Readonly<{
  src: string;
  startMs: number;
  durationMs: number;
  volume?: number;
}>;
export type CompositionFont = Readonly<{ weight: 400 | 700 | 800; src: string }>;
export type CompositionOptions = Readonly<{
  audio?: readonly CompositionAudio[];
  /** Project-relative font files; absent falls back to the system sans stack. */
  fonts?: readonly CompositionFont[];
}>;

/** Design tokens as CSS custom properties, derived from the plan's palette, language and light. */
export const visualTokensFor = (plan: MotionPlan): HyperFramesTokens => {
  const roles = plan.visualLanguage?.palette.roles;
  const light = plan.compositing ?? plan.visualLanguage?.compositing;
  const rad = ((light?.lighting.directionDeg ?? 0) * Math.PI) / 180;
  const [dx, dy] = light?.lighting.shadowOffset ?? [0, 0];
  const type = plan.visualLanguage?.type;
  return Object.freeze({
    "--hf-surface": roles?.bgFar ?? plan.palette.surface,
    "--hf-muted": roles?.bgMid ?? plan.palette.muted,
    "--hf-ink": roles?.ink ?? plan.palette.line,
    "--hf-text": plan.palette.text,
    "--hf-accent": roles?.accent ?? plan.palette.accent,
    "--hf-text-on": roles?.textOn ?? "#ffffff",
    "--hf-text-plate": roles?.textPlate ?? plan.palette.line,
    "--hf-caption-px": String(type?.captionPx[1] ?? 64),
    "--hf-number-px": String(type?.numberPx[1] ?? 140),
    "--hf-stroke-px": String(plan.visualLanguage?.line.strokePx ?? 8),
    "--hf-shadow-opacity": String(
      Math.round(0.28 * (light?.lighting.shadowStrength ?? 1) * 100) / 100,
    ),
    "--hf-shadow-x": `${Math.round(dx + Math.sin(rad) * 6)}px`,
    "--hf-shadow-y": `${Math.round(dy)}px`,
    "--hf-rim": light?.rim?.enabled ? (light.rim.colour ?? "#FFF6E0") : "transparent",
  });
};

const secs = (ms: number): string => `${(Math.round(ms) / 1000).toFixed(3)}`;
const ms = (value: number): string => `${Math.max(0, Math.round(value))}ms`;
/** Animation shorthand with absolute delay; fill both keeps the state before and after. */
const anim = (name: string, atMs: number, durMs: number, easing = "ease-out"): string =>
  `animation:${name} ${ms(durMs)} ${easing} ${ms(atMs)} both`;

const FIG_H = 330;
const CAM: Readonly<Record<string, readonly [string, string]>> = {
  slow_zoom_in: ["scale(1)", "scale(1.06)"],
  slow_zoom_out: ["scale(1.06)", "scale(1)"],
  push_in: ["scale(1)", "scale(1.12)"],
  pan_left: ["translateX(0)", "translateX(-48px)"],
  pan_right: ["translateX(0)", "translateX(48px)"],
};

const actorHtml = (
  scene: PlannedScene,
  planned: PlannedActor,
  geo: ReturnType<typeof geometryFor>,
): string => {
  const { actor, character, idle } = planned;
  const scale =
    actorScaleFor(scene.spec, actor) *
    (character.bible?.body.scale ?? 1) *
    (geo.canvas === "landscape" ? 1.15 : 1);
  const h = FIG_H * scale;
  const w = h * 0.62;
  const x = positionX(actor.position, geo);
  const pal = character.palette;
  const top = character.wardrobe?.top?.colour ?? pal.accent;
  const legs = character.wardrobe?.bottoms?.colour ?? pal.line;
  const hair = character.wardrobe?.hair?.colour;
  const pointing = actor.pose === "pointing";
  const flip = (actor.facing ?? (actor.position === "right" ? "left" : "right")) === "left";
  // viewBox 0..100 x 0..160, feet at y=160.
  const svg = `<svg viewBox="0 0 100 160" width="${n(w)}" height="${n(h)}" aria-hidden="true">
<ellipse cx="50" cy="159" rx="30" ry="4" fill="#000" opacity="var(--hf-shadow-opacity)"/>
<g stroke="var(--hf-ink)" stroke-width="5" stroke-linecap="round" fill="none">
<path d="M50 90 L34 156" stroke="${legs}"/><path d="M50 90 L66 156" stroke="${legs}"/>
<path d="M50 56 L22 ${pointing ? 34 : 88}"/><path d="M50 56 L78 ${pointing ? 40 : 88}"/>
</g>
<rect x="32" y="48" width="36" height="50" rx="12" fill="${top}" stroke="var(--hf-ink)" stroke-width="4"/>
<circle cx="50" cy="26" r="21" fill="${pal.fill}" stroke="var(--hf-ink)" stroke-width="5"/>
${hair ? `<path d="M29 24 Q50 -2 71 24 Q50 12 29 24Z" fill="${hair}"/>` : ""}
<circle cx="43" cy="26" r="2.4" fill="var(--hf-ink)"/><circle cx="57" cy="26" r="2.4" fill="var(--hf-ink)"/>
</svg>`;
  const breath = `animation:breath ${ms(idle.breathPeriodMs)} ease-in-out ${-Math.round(idle.breathPhase * idle.breathPeriodMs)}ms infinite alternate`;
  return `<div class="actor" data-character="${escapeXml(character.key)}" style="left:${n(x - w / 2)}px;top:${n(geo.baselineY - h)}px;${anim("rise", scene.startMs, 350)}"><div style="transform:${flip ? "scaleX(-1)" : "none"}"><div style="transform-origin:50% 100%;${breath}">${svg}</div></div></div>`;
};

const diagramHtml = (scene: PlannedScene, geo: ReturnType<typeof geometryFor>): string => {
  const d = scene.spec.diagram;
  if (!d || !scene.diagram) return "";
  const at = scene.diagram.startMs;
  const r = geo.diagramRect;
  const box = `left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px`;
  const step = 260;
  switch (d.kind) {
    case "counter": {
      const whole = Number.isInteger(d.from) && Number.isInteger(d.to);
      const unit = escapeXml(d.unit ?? "");
      const id = `c${scene.spec.index}`;
      return whole
        ? `<style>@keyframes ${id}{from{--n:${d.from}}to{--n:${d.to}}}</style><div class="diagram big counter ${id}" style="${box};${anim("fadein", at, 300)},${`${id} 1400ms ease-out ${ms(at)} both`}" data-unit="${unit}"></div><style>.${id}::after{content:counter(n) "${unit}"}</style>`
        : `<div class="diagram big" style="${box};${anim("pop", at, 500)}">${escapeXml(String(d.to))}${unit}</div>`;
    }
    case "percent":
      return `<div class="diagram" style="${box};${anim("fadein", at, 300)}"><div class="big">${escapeXml(String(d.value))}%</div><div class="label">${escapeXml(d.label)}</div><div class="track"><i style="width:${Math.max(0, Math.min(100, d.value))}%;${anim("grow-x", at + 200, 1000)}"></i></div></div>`;
    case "bar_compare": {
      const max = Math.max(1, ...d.items.map((i) => i.value));
      const bars = d.items
        .map(
          (item, i) =>
            `<div class="bar"><span class="v">${escapeXml(String(item.value))}${escapeXml(item.unit ?? "")}</span><i style="height:${n((item.value / max) * 380)}px;${anim("grow-y", at + i * step, 700)}"></i><span class="label">${escapeXml(item.label)}</span></div>`,
        )
        .join("");
      return `<div class="diagram bars" style="${box};${anim("fadein", at, 250)}">${bars}</div>`;
    }
    case "before_after":
      return `<div class="diagram row" style="${box}"><div class="card" style="${anim("pop", at, 450)}">${escapeXml(d.before)}</div><b class="arrow" style="${anim("fadein", at + step, 250)}">&rarr;</b><div class="card hot" style="${anim("pop", at + 2 * step, 450)}">${escapeXml(d.after)}</div></div>`;
    case "flow": {
      const parts = d.nodes
        .map(
          (node, i) =>
            `${i ? `<b class="arrow" style="${anim("fadein", at + i * step - 100, 200)}">&rarr;</b>` : ""}<div class="card" style="${anim("pop", at + i * step, 400)}">${escapeXml(node.label)}</div>`,
        )
        .join("");
      return `<div class="diagram row" style="${box}">${parts}</div>`;
    }
    case "timeline": {
      const points = d.points
        .map(
          (p, i) =>
            `<div class="pt" style="${anim("pop", at + i * step, 400)}"><i></i><span class="at">${escapeXml(p.at)}</span><span class="label">${escapeXml(p.label)}</span></div>`,
        )
        .join("");
      return `<div class="diagram timeline" style="${box}">${points}</div>`;
    }
  }
};

const sceneHtml = (scene: PlannedScene, plan: MotionPlan): string => {
  const geo = geometryFor(plan.canvas);
  const dur = scene.endMs - scene.startMs;
  const move = CAM[scene.spec.camera.movement];
  const cam = move
    ? `transform-origin:${geo.cameraFocus.x}px ${geo.cameraFocus.y}px;animation:cam${scene.spec.index} ${ms(dur)} ease-in-out ${ms(scene.startMs)} both`
    : "";
  const camCss = move
    ? `@keyframes cam${scene.spec.index}{from{transform:${move[0]}}to{transform:${move[1]}}}`
    : "";
  const props = scene.spec.props
    .map((prop, i) => {
      const a = propAnchor(prop, geo);
      const label = escapeXml(prop.label ?? prop.type.replace(/_/g, " "));
      return `<div class="prop" style="left:${n(a.x - 110)}px;top:${n(a.y - 90)}px;${anim("pop", scene.propsAtMs[i] ?? scene.startMs + 200, 400)}">${label}</div>`;
    })
    .join("");
  const overlays = scene.overlays
    .map(
      ({ overlay, atMs }) =>
        `<div class="overlay${overlay.emphasis ? " hot" : ""}" style="top:${geo.overlayY[overlay.position] - 50}px;${anim("pop", atMs, 400)}">${escapeXml(overlay.text)}</div>`,
    )
    .join("");
  const captions = scene.captions
    .map((group) => {
      const text = group.words.map((w) => w.text).join(" ");
      const size = Math.min(
        Number(visualTokensFor(plan)["--hf-caption-px"]),
        Math.floor(geo.captionFitWidth / (Math.max(1, text.length) * 0.62)),
      );
      const words = group.words
        .map(
          (w) =>
            `<span style="${anim("hilite", w.startMs, 120, "linear")}">${escapeXml(w.text)}</span>`,
        )
        .join(" ");
      return `<div class="caption" style="top:${geo.captionBand.top}px;height:${geo.captionBand.bottom - geo.captionBand.top}px;font-size:${size}px;animation:show ${ms(group.endMs - group.startMs)} linear ${ms(group.startMs)} none">${words}</div>`;
    })
    .join("");
  const actors = scene.actors.map((a) => actorHtml(scene, a, geo)).join("");
  const grid = scene.spec.background === "grid" ? " grid" : "";
  return `<style>${camCss}</style>
<section class="scene" data-scene="${scene.spec.index}" data-purpose="${scene.spec.purpose}" style="animation:show ${ms(dur)} linear ${ms(scene.startMs)} none">
<div class="cam" style="${cam}"><div class="bg${grid}"></div><div class="floor" style="top:${geo.baselineY}px"></div>${diagramHtml(scene, geo)}${props}${actors}</div>${overlays}${captions}
</section>`;
};

const CSS = `
:root{font-family:Inter,"Helvetica Neue",Arial,sans-serif}
html,body{margin:0;background:var(--hf-surface)}
#root{position:relative;overflow:hidden;background:var(--hf-surface);color:var(--hf-text)}
.clip,.scene,.cam,.bg{position:absolute;inset:0}
.scene{opacity:0}
.bg.grid{background-image:linear-gradient(var(--hf-muted) 2px,transparent 2px),linear-gradient(90deg,var(--hf-muted) 2px,transparent 2px);background-size:96px 96px;opacity:.55}
.floor{position:absolute;left:0;right:0;bottom:0;background:var(--hf-muted)}
.actor{position:absolute;filter:drop-shadow(var(--hf-shadow-x) 0 0 var(--hf-rim))}
.prop{position:absolute;width:220px;height:150px;display:flex;align-items:center;justify-content:center;border:5px solid var(--hf-ink);border-radius:18px;background:#fff;font-weight:700;font-size:30px;text-transform:capitalize}
.overlay{position:absolute;left:0;right:0;text-align:center;font-weight:800;font-size:76px;line-height:100px;color:var(--hf-text)}
.overlay.hot{color:var(--hf-text-on);background:var(--hf-accent);margin:0 auto;width:max-content;padding:0 40px;left:50%;right:auto;transform:translateX(-50%);border-radius:20px}
.diagram{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:800;color:var(--hf-text)}
.big{font-size:calc(var(--hf-number-px)*1px);font-weight:800;color:var(--hf-accent);line-height:1.1}
.counter{counter-reset:n var(--n);--n:0}
.label{font-size:36px;font-weight:700}
.track{width:78%;height:26px;border-radius:13px;background:var(--hf-muted);margin-top:26px;overflow:hidden}
.track i{display:block;height:100%;background:var(--hf-accent);transform-origin:left}
.bars{flex-direction:row;align-items:flex-end;gap:70px;padding-bottom:40px}
.bar{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:12px}
.bar i{display:block;width:150px;background:var(--hf-accent);border-radius:14px 14px 0 0;transform-origin:bottom}
.bar .v{font-size:48px}
.row{flex-direction:row;gap:26px}
.card{padding:26px 34px;border:5px solid var(--hf-ink);border-radius:20px;background:#fff;font-size:40px}
.card.hot{background:var(--hf-accent);color:var(--hf-text-on)}
.arrow{font-size:56px}
.timeline{flex-direction:row;justify-content:space-around;align-items:center}
.pt::before{content:"";position:absolute;top:21px;left:-50%;right:-50%;height:8px;background:var(--hf-ink);z-index:-1}
.pt{position:relative;isolation:isolate;display:flex;flex-direction:column;align-items:center;gap:8px;z-index:1}
.pt i{width:34px;height:34px;border-radius:50%;background:var(--hf-accent);border:5px solid var(--hf-ink)}
.pt .at{font-size:44px;color:var(--hf-accent)}
.caption{position:absolute;left:0;right:0;display:flex;align-items:center;justify-content:center;gap:.3em;font-weight:800;opacity:0;color:var(--hf-text-on);background:var(--hf-text-plate);width:max-content;max-width:90%;margin:0 auto;padding:0 36px;border-radius:24px;left:50%;right:auto;transform:translateX(-50%);height:auto!important;line-height:1.25}
.caption span{opacity:.62}
@property --n{syntax:"<integer>";inherits:true;initial-value:0}
@keyframes show{from{opacity:1}to{opacity:1}}
@keyframes fadein{from{opacity:0}to{opacity:1}}
@keyframes pop{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:scale(1)}}
@keyframes rise{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
@keyframes grow-x{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes grow-y{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes hilite{from{opacity:.62}to{opacity:1;color:var(--hf-accent)}}
@keyframes breath{from{transform:scaleY(1)}to{transform:scaleY(1.018)}}
`;

export const compositionFromPlan = (
  plan: MotionPlan,
  tokens: HyperFramesTokens = visualTokensFor(plan),
  options: CompositionOptions = {},
): string => {
  const geo = geometryFor(plan.canvas);
  const vars = Object.entries(tokens)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  const fonts = (options.fonts ?? [])
    .map(
      (f) =>
        `@font-face{font-family:Inter;font-weight:${f.weight};src:url("${escapeXml(f.src)}") format("truetype")}`,
    )
    .join("");
  const audio = (options.audio ?? [])
    .map(
      (a, i) =>
        `<audio id="voice-${i}" data-start="${secs(a.startMs)}" data-duration="${secs(a.durationMs)}" data-track-index="${i + 1}" data-volume="${a.volume ?? 1}" src="${escapeXml(a.src)}"></audio>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>HyperFrames composition</title>
<style>:root{${vars}}${fonts}${CSS}</style></head><body>
<div id="root" data-composition-id="root" data-start="0" data-width="${geo.frame.width}" data-height="${geo.frame.height}" data-duration="${secs(plan.durationMs)}" style="width:${geo.frame.width}px;height:${geo.frame.height}px">
<div class="clip" data-start="0" data-duration="${secs(plan.durationMs)}" data-track-index="0">
${plan.scenes.map((s) => sceneHtml(s, plan)).join("\n")}
</div>
${audio}
</div></body></html>
`;
};
