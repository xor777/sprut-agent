import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const pluginRoot = path.resolve("dist/plugin");
const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));
const deliveryVersion = packageMetadata.version;
if (typeof deliveryVersion !== "string" || deliveryVersion.length === 0) {
  throw new Error("package.json must define the plugin delivery version.");
}
const codexPluginPath = path.resolve(".codex-plugin", "plugin.json");
const claudeMarketplacePath = path.resolve(
  ".claude-plugin",
  "marketplace.json",
);
const codexPluginSource = withDeliveryVersion(
  await readFile(codexPluginPath, "utf8"),
  ({ version }) => version,
  deliveryVersion,
);
const claudeMarketplaceSource = withDeliveryVersion(
  await readFile(claudeMarketplacePath, "utf8"),
  ({ plugins }) => plugins.find(({ name }) => name === "sprut-agent")?.version,
  deliveryVersion,
);
const outputPath = path.join(pluginRoot, "dist", "server.mjs");
const pluginMcpConfig = {
  mcpServers: {
    "sprut-agent": {
      command: "node",
      args: ["./dist/server.mjs"],
      cwd: ".",
    },
  },
};
const claudePluginManifest = {
  name: "sprut-agent",
  version: deliveryVersion,
  description:
    "Connect an agent to a SprutHub home with agent-first tools and guidance.",
  author: {
    name: "sprut-agent contributors",
    url: "https://github.com/xor777/sprut-agent",
  },
  homepage: "https://github.com/xor777/sprut-agent#readme",
  repository: "https://github.com/xor777/sprut-agent",
  license: "MIT",
  keywords: ["spruthub", "smart-home", "mcp", "agent-skill"],
  mcpServers: {
    "sprut-agent": {
      command: "node",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands this plugin path.
      args: ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"],
    },
  },
};
await Promise.all([
  writeFile(codexPluginPath, codexPluginSource),
  writeFile(claudeMarketplacePath, claudeMarketplaceSource),
]);
await rm(pluginRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(path.dirname(outputPath), { recursive: true }),
  mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true }),
]);
await Promise.all([
  bundle("src/server.mjs", outputPath),
  bundle("src/read-api.mjs", path.join(pluginRoot, "dist", "read.mjs")),
]);
await Promise.all([
  cp(path.resolve(".codex-plugin"), path.join(pluginRoot, ".codex-plugin"), {
    recursive: true,
  }),
  writeFile(
    path.join(pluginRoot, ".mcp.json"),
    `${JSON.stringify(pluginMcpConfig, null, 2)}\n`,
  ),
  writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(claudePluginManifest, null, 2)}\n`,
  ),
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

async function bundle(entryPoint, destination) {
  const result = await build({
    entryPoints: [entryPoint],
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
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bundled, { mode: 0o644 });
}

function withDeliveryVersion(source, selectCurrentVersion, version) {
  const currentVersion = selectCurrentVersion(JSON.parse(source));
  if (typeof currentVersion !== "string") {
    throw new Error("Plugin manifest must define a version.");
  }
  const current = `"version": ${JSON.stringify(currentVersion)}`;
  const occurrences = source.split(current).length - 1;
  if (occurrences !== 1) {
    throw new Error("Plugin manifest version must occur exactly once.");
  }
  return source.replace(current, `"version": ${JSON.stringify(version)}`);
}
