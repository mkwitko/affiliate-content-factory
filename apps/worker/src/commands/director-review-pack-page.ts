/**
 * The static review page of a director review pack. It works from file:// with no server: the
 * manifest and the starting review sheet are embedded, images are relative links, a draft is kept
 * in localStorage when the browser allows it, and the filled sheet leaves as a JSON download.
 */
type Embeddable = Readonly<{ benchmark: string }>;

/** JSON safe inside a <script> element: no "<" can close it early. */
const embed = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

const STYLE = `
:root { color-scheme: light dark; --bg: #f7f7f5; --fg: #1b1b1b; --muted: #6b6b6b; --line: #d8d8d4;
  --card: #ffffff; --accent: #1f6feb; --ok: #1a7f37; --bad: #cf222e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #ececec; --muted: #9a9a9a;
  --line: #333; --card: #1f1f1f; --accent: #4c8dff; --ok: #3fb950; --bad: #f85149; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; }
header { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line);
  padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
header h1 { font-size: 16px; margin: 0; }
.nav button { min-width: 34px; }
.nav button.done { border-color: var(--ok); color: var(--ok); }
.nav button.here { outline: 2px solid var(--accent); }
main { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; padding: 16px; }
@media (max-width: 1000px) { main { grid-template-columns: 1fr; } }
.meta { color: var(--muted); font-size: 13px; margin: 4px 0 12px; }
pre.script { white-space: pre-wrap; background: var(--card); border: 1px solid var(--line);
  padding: 12px; border-radius: 6px; font: 15px/1.5 system-ui, sans-serif; margin: 0; }
.scenes { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; margin-top: 14px; }
.scene { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 10px; }
.scene img { width: 100%; aspect-ratio: 9 / 16; display: block; border-radius: 4px; background: var(--line); }
.scene h3 { font-size: 14px; margin: 8px 0 4px; }
.scene q { display: block; margin: 0 0 6px; font-style: italic; }
.scene dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin: 0; font-size: 12.5px; }
.scene dt { color: var(--muted); }
.scene dd { margin: 0; overflow-wrap: anywhere; }
.error { color: var(--bad); }
details { margin-top: 8px; font-size: 13px; }
details pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
aside { position: sticky; top: 64px; align-self: start; background: var(--card); border: 1px solid var(--line);
  border-radius: 6px; padding: 14px; }
.field { margin-bottom: 12px; }
.field label, .field .name { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
.choices { display: flex; flex-wrap: wrap; gap: 4px; }
button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 4px;
  background: var(--card); color: var(--fg); cursor: pointer; }
button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
input[type="number"], textarea { font: inherit; width: 100%; padding: 6px; border: 1px solid var(--line);
  border-radius: 4px; background: var(--bg); color: var(--fg); }
input.invalid { border-color: var(--bad); }
textarea { min-height: 90px; resize: vertical; }
.row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
#status { font-size: 13px; color: var(--muted); }
`;

// Plain browser script; it must not use template literals, since it lives in one.
const SCRIPT = `
"use strict";
var pack = JSON.parse(document.getElementById("pack").textContent);
var embedded = JSON.parse(document.getElementById("review").textContent);
var SCORES = [
  ["story_coherence", "Story coherence"],
  ["scene_continuity", "Scene continuity"],
  ["visual_specificity", "Visual specificity"],
  ["product_visibility", "Product visibility"],
  ["character_consistency", "Character consistency"],
  ["commercial_intent", "Commercial intent"]
];
var DECISIONS = ["pass", "needs_fix", "fail"];
var FIELDS = SCORES.map(function (s) { return s[0]; }).concat(["editorial_decision", "manual_fix_minutes", "notes"]);
var DRAFT_KEY = "director-review-pack:" + pack.benchmark;
var review = JSON.parse(JSON.stringify(embedded));
var current = 0;

function h(tag, props, children) {
  var node = document.createElement(tag);
  Object.keys(props || {}).forEach(function (key) {
    if (key === "text") node.textContent = props[key];
    else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), props[key]);
    else node.setAttribute(key, props[key]);
  });
  (children || []).forEach(function (child) { if (child) node.appendChild(child); });
  return node;
}
function status(text) { document.getElementById("status").textContent = text; }
function entry(caseId) {
  return review.cases.find(function (c) { return c.case_id === caseId; });
}
function complete(item) {
  return FIELDS.every(function (f) { return f === "notes" || item[f] !== null; });
}
function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(review)); } catch (e) {}
}
function sheetError(sheet) {
  if (!sheet || !Array.isArray(sheet.cases)) return "not a review sheet";
  var ids = pack.cases.map(function (c) { return c.case_id; });
  for (var i = 0; i < sheet.cases.length; i++) {
    var item = sheet.cases[i];
    if (!item || ids.indexOf(item.case_id) < 0) return "case not in this benchmark";
    for (var j = 0; j < FIELDS.length; j++) {
      var error = reviewValueError(FIELDS[j], item[FIELDS[j]]);
      if (error) return item.case_id + ": " + error;
    }
  }
  return null;
}
function adopt(sheet) {
  review.cases = review.cases.map(function (item) {
    var other = sheet.cases.find(function (c) { return c.case_id === item.case_id; });
    if (!other) return item;
    var next = Object.assign({}, item);
    FIELDS.forEach(function (f) { next[f] = other[f]; });
    return next;
  });
}
function set(caseId, field, value) {
  if (reviewValueError(field, value)) return false;
  entry(caseId)[field] = value;
  saveDraft();
  renderNav();
  return true;
}

function choiceRow(caseId, field, options) {
  var item = entry(caseId);
  var row = h("div", { class: "choices", role: "group" });
  options.forEach(function (value) {
    var button = h("button", {
      type: "button",
      "aria-pressed": String(item[field] === value),
      text: value === "n/a" ? "N/A" : String(value),
      onclick: function () {
        // Pressing the chosen value again clears it.
        set(caseId, field, item[field] === value ? null : value);
        render();
      }
    });
    row.appendChild(button);
  });
  return row;
}
function line(term, value) {
  return value ? [h("dt", { text: term }), h("dd", { text: value })] : [];
}
function describeAction(action) {
  var rest = Object.keys(action).filter(function (k) { return k !== "type" && k !== "atWord"; })
    .map(function (k) { return k + "=" + JSON.stringify(action[k]); });
  return action.type + (action.atWord === undefined ? "" : " @word " + action.atWord) + (rest.length ? " " + rest.join(" ") : "");
}
function describeActor(actor) {
  var parts = [actor.characterKey + ": " + actor.pose + ", " + actor.expression + ", " + actor.position];
  if (actor.facing) parts.push("facing " + actor.facing);
  if (actor.anchorId) parts.push("anchor " + actor.anchorId);
  if (actor.motionTokens && actor.motionTokens.length) parts.push("tokens " + JSON.stringify(actor.motionTokens));
  return parts.join(", ");
}
function sceneCard(scene) {
  var spec = scene.spec;
  var actions = [];
  spec.actors.forEach(function (actor) {
    (actor.actions || []).forEach(function (a) { actions.push(actor.characterKey + " " + describeAction(a)); });
  });
  var details = []
    .concat(line("background", spec.background + (spec.locationId ? " / " + spec.locationId + (spec.zoneId ? ":" + spec.zoneId : "") : "")))
    .concat(line("camera", spec.camera.shot + ", " + spec.camera.movement))
    .concat(line("actors", spec.actors.map(describeActor).join("; ")))
    .concat(line("actions", actions.join("; ")))
    .concat(line("props", spec.props.map(function (p) { return p.type + "@" + p.position + (p.label ? " \\u201c" + p.label + "\\u201d" : ""); }).join("; ")))
    .concat(line("diagram", spec.diagram ? JSON.stringify(spec.diagram) : ""))
    .concat(line("overlays", spec.overlays.map(function (o) { return o.text + " (" + o.position + (o.emphasis ? ", emphasis" : "") + ")"; }).join("; ")))
    .concat(line("layout", spec.layoutId || ""))
    .concat(line("transition", spec.transition + ", captions " + spec.captionMode));
  var picture = scene.image
    ? h("a", { href: scene.image, target: "_blank", rel: "noopener" }, [
        h("img", { src: scene.image, alt: "Scene " + (scene.position + 1), loading: "lazy", width: "1080", height: "1920" })
      ])
    : h("p", { class: "error", text: "Not rendered: " + scene.error });
  return h("section", { class: "scene" }, [
    picture,
    h("h3", { text: "Scene " + (scene.position + 1) + " \\u00b7 " + spec.purpose }),
    h("q", { text: scene.script }),
    h("dl", {}, details),
    h("details", {}, [h("summary", { text: "SceneSpec JSON" }), h("pre", { text: JSON.stringify(spec, null, 2) })])
  ]);
}
function candidateView(c) {
  var p = c.provenance;
  var meta = [
    "candidate " + c.id,
    c.accepted ? "accepted" : "rejected" + (c.failure_reason ? " (" + c.failure_reason + ")" : ""),
    "retry_count " + c.retry_count,
    "latency " + (c.latency_ms / 1000).toFixed(1) + " s",
    "model " + p.model + (p.quantization && p.model.indexOf(p.quantization) < 0 ? " " + p.quantization : ""),
    "modelVerified " + p.modelVerified
  ].join(" \\u00b7 ");
  var children = [h("p", { class: "meta", text: meta })];
  if (c.validation_failures.length)
    children.push(h("p", { class: "error", text: "validation_failures: " + c.validation_failures.join(", ") }));
  if (c.attempts.length)
    children.push(h("details", {}, [
      h("summary", { text: "Rejected attempts (" + c.attempts.length + ")" }),
      h("pre", { text: JSON.stringify(c.attempts, null, 2) })
    ]));
  children.push(h("div", { class: "scenes" }, c.scenes.map(sceneCard)));
  return h("div", {}, children);
}
function form(caseId) {
  var item = entry(caseId);
  var fields = SCORES.map(function (s) {
    var options = s[0] === "product_visibility" ? ["n/a", 1, 2, 3, 4, 5] : [1, 2, 3, 4, 5];
    return h("div", { class: "field" }, [h("span", { class: "name", text: s[1] }), choiceRow(caseId, s[0], options)]);
  });
  fields.push(h("div", { class: "field" }, [h("span", { class: "name", text: "Editorial decision" }), choiceRow(caseId, "editorial_decision", DECISIONS)]));
  var minutes = h("input", { id: "minutes", type: "number", min: "0", step: "1", inputmode: "numeric" });
  minutes.value = item.manual_fix_minutes === null ? "" : String(item.manual_fix_minutes);
  minutes.addEventListener("input", function () {
    var raw = minutes.value.trim();
    var ok = set(caseId, "manual_fix_minutes", raw === "" ? null : Number(raw));
    minutes.className = ok ? "" : "invalid";
  });
  fields.push(h("div", { class: "field" }, [h("label", { for: "minutes", text: "Manual fix minutes" }), minutes]));
  var notes = h("textarea", { id: "notes" });
  notes.value = item.notes;
  notes.addEventListener("input", function () { set(caseId, "notes", notes.value); });
  fields.push(h("div", { class: "field" }, [h("label", { for: "notes", text: "Notes" }), notes]));
  fields.push(h("div", { class: "row" }, [
    h("button", { type: "button", text: "\\u2190 Previous", onclick: function () { go(current - 1); } }),
    h("button", { type: "button", text: "Next \\u2192", onclick: function () { go(current + 1); } })
  ]));
  return h("aside", {}, fields);
}
function renderNav() {
  var nav = document.getElementById("nav");
  nav.replaceChildren.apply(nav, pack.cases.map(function (c, i) {
    var done = complete(entry(c.case_id));
    return h("button", {
      type: "button",
      class: (done ? "done" : "") + (i === current ? " here" : ""),
      title: c.case_id + (done ? " (complete)" : ""),
      text: String(i + 1) + (done ? " \\u2713" : ""),
      onclick: function () { go(i); }
    });
  }));
}
function render() {
  var c = pack.cases[current];
  document.getElementById("position").textContent = "CASE " + (current + 1) + " / " + pack.cases.length;
  var body = h("div", {}, [
    h("h2", { text: c.case_id }),
    h("p", { class: "meta", text: [c.source, c.language, "cast " + c.cast.join(", ")].filter(Boolean).join(" \\u00b7 ") }),
    h("pre", { class: "script", text: c.body })
  ].concat(c.candidates.map(candidateView)));
  var main = document.getElementById("main");
  main.replaceChildren(body, form(c.case_id));
  renderNav();
}
function go(index) {
  if (index < 0 || index >= pack.cases.length) return;
  current = index;
  render();
  window.scrollTo(0, 0);
}
function exportSheet() {
  var name = pack.benchmark.split("/").pop().replace(/\\.json$/, "") + ".review.json";
  var blob = new Blob([JSON.stringify(review, null, 2) + "\\n"], { type: "application/json" });
  var link = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(link);
  link.click();
  link.remove();
  var done = review.cases.filter(complete).length;
  status("Exported " + name + " (" + done + "/" + review.cases.length + " complete)");
}
function loadSheet(file) {
  var reader = new FileReader();
  reader.onload = function () {
    var sheet;
    try { sheet = JSON.parse(reader.result); } catch (e) { status("Not JSON: " + file.name); return; }
    var error = sheetError(sheet);
    if (error) { status("Rejected " + file.name + ": " + error); return; }
    adopt(sheet);
    saveDraft();
    render();
    status("Loaded " + file.name);
  };
  reader.readAsText(file);
}

document.getElementById("export").addEventListener("click", exportSheet);
document.getElementById("load-button").addEventListener("click", function () {
  document.getElementById("load").click();
});
document.getElementById("load").addEventListener("change", function (event) {
  if (event.target.files[0]) loadSheet(event.target.files[0]);
  event.target.value = "";
});
document.getElementById("discard").addEventListener("click", function () {
  if (!confirm("Discard the browser draft and go back to review.json from the pack?")) return;
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  review = JSON.parse(JSON.stringify(embedded));
  render();
  status("Draft discarded");
});
document.addEventListener("keydown", function (event) {
  var tag = event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "ArrowLeft") go(current - 1);
  if (event.key === "ArrowRight") go(current + 1);
});
try {
  var draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
  if (draft && !sheetError(draft)) { adopt(draft); status("Restored the draft saved in this browser"); }
} catch (e) {}
render();
`;

export const reviewPackHtml = (
  manifest: Embeddable,
  review: unknown,
  validatorSource: string,
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Director Review Pack</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1 id="position"></h1>
<div class="nav" id="nav"></div>
<button type="button" id="export">Export review.json</button>
<button type="button" id="load-button">Load review.json</button>
<input type="file" id="load" accept=".json,application/json" hidden>
<button type="button" id="discard">Discard draft</button>
<span id="status"></span>
</header>
<main id="main"></main>
<script id="pack" type="application/json">${embed(manifest)}</script>
<script id="review" type="application/json">${embed(review)}</script>
<script>
var reviewValueError = ${validatorSource};
${SCRIPT}
</script>
</body>
</html>
`;
