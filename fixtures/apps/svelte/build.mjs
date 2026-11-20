// Compile App.svelte and bundle to a self-contained IIFE for fixtures/apps/svelte/app.js
import { compile } from "svelte/compiler";
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "App.svelte"), "utf8");
const { js } = compile(source, { generate: "client", dev: false, css: "injected" });

// keep build files inside the project so node_modules resolution works
const dir = join(here, ".build");
mkdirSync(dir, { recursive: true });
const compPath = join(dir, "App.mjs");
writeFileSync(compPath, js.code);

const entry = join(dir, "entry.mjs");
writeFileSync(
  entry,
  `import App from ${JSON.stringify(compPath)};
const app = new App({ target: document.getElementById("app") });
window.__svelte_app = app;
`,
);

await build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  outfile: join(here, "app.js"),
  logLevel: "warning",
});
console.log("built fixtures/apps/svelte/app.js");
