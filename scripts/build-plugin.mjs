import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const outputPath = path.resolve("dist/server.mjs");
const result = await build({
  entryPoints: ["src/server.mjs"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minifyWhitespace: true,
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  write: false,
});
const bundled = result.outputFiles[0].text.replace(/[\t ]+$/gm, "");
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, bundled, { mode: 0o644 });
