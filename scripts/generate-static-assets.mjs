import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const outputFile = path.join(rootDir, "server", "static-assets.generated.js");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
      continue;
    }
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

const files = await collectFiles(distDir);
const embedded = {};

for (const file of files) {
  const rel = `/${path.relative(distDir, file).replace(/\\/g, "/")}`;
  const data = await readFile(file);
  embedded[rel] = {
    type: mimeTypes[path.extname(file).toLowerCase()] || "application/octet-stream",
    size: (await stat(file)).size,
    data: data.toString("base64")
  };
}

await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(
  outputFile,
  `export const EMBEDDED_STATIC_ASSETS = ${JSON.stringify({ files: embedded }, null, 2)};\n`,
  "utf8"
);

console.log(`Embedded ${files.length} frontend files into ${path.relative(rootDir, outputFile)}`);
