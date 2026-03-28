import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

await build();
await mkdir(distDir, { recursive: true });
await cp(path.join(rootDir, "background.js"), path.join(distDir, "background.js"));
await cp(path.join(rootDir, "icons"), path.join(distDir, "icons"), { recursive: true });

const manifestPath = path.join(rootDir, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const distManifest = {
  ...manifest,
  action: {
    ...manifest.action,
    default_popup: "popup.html",
  },
  background: {
    ...manifest.background,
    service_worker: "background.js",
  },
};

await writeFile(
  path.join(distDir, "manifest.json"),
  `${JSON.stringify(distManifest, null, 2)}\n`,
);
