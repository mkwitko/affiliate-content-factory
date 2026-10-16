import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const dist = join(root, "dist");
const workerDist = join(root, "dist-worker");

const assets = [
  ["/index.html", join(dist, "index.html"), "text/html; charset=utf-8"],
  ...(await readdir(join(dist, "assets"))).map((filename) => [
    `/assets/${filename}`,
    join(dist, "assets", filename),
    filename.endsWith(".js")
      ? "application/javascript; charset=utf-8"
      : filename.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "application/octet-stream",
  ]),
];

const entries = await Promise.all(
  assets.map(async ([pathname, file, contentType]) => [
    pathname,
    { body: await readFile(file, "utf8"), contentType },
  ]),
);
const source = [
  'import { handleRequest } from "./worker.js";',
  `const inlineAssets = ${JSON.stringify(Object.fromEntries(entries))};`,
  "export default {",
  "  fetch(request, environment) {",
  "    return handleRequest(request, { ...environment, ASSET_CONTENT: inlineAssets });",
  "  },",
  "};",
  "",
].join("\n");

await mkdir(workerDist, { recursive: true });
await writeFile(join(workerDist, "inline-worker.js"), source);
