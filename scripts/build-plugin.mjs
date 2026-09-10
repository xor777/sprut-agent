import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const pluginRoot = path.resolve("dist/plugin");
const outputPath = path.join(pluginRoot, "dist", "server.mjs");
await rm(pluginRoot, { recursive: true, force: true });
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
await Promise.all([
  cp(path.resolve(".codex-plugin"), path.join(pluginRoot, ".codex-plugin"), {
    recursive: true,
  }),
  cp(path.resolve(".mcp.json"), path.join(pluginRoot, ".mcp.json")),
  cp(
    path.resolve("skills", "spruthub-master"),
    path.join(pluginRoot, "skills", "spruthub-master"),
    { recursive: true },
  ),
  cp(
    path.resolve("scripts", "check-install.mjs"),
    path.join(pluginRoot, "check-install.mjs"),
  ),
]);
