// Compile an App.svelte and bundle to a self-contained IIFE app.js next to it.
// Usage: node fixtures/apps/svelte/build.mjs [appDir]   (default: this directory)
import { compile } from "svelte/compiler";
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(process.argv[2] ?? here);
const source = readFileSync(join(appDir, "App.svelte"), "utf8");
const { js } = compile(source, { generate: "client", dev: false, css: "injected" });

// keep build files inside the app dir so node_modules resolution works
const dir = join(appDir, ".build");
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
  outfile: join(appDir, "app.js"),
  logLevel: "warning",
});
console.log(`built ${join(appDir, "app.js")}`);
