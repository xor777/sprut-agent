import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// A test that forgets the hub connection must not pick up the owner's
// login from ~/.config/sprut-agent and act on the real home.
async function startServer(t, env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "server.mjs")],
    cwd: projectRoot,
    env: { PATH: process.env.PATH, ...env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: "owner-home-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

test("a server launched without a hub connection asks for a login instead of using the owner's", async (t) => {
  // Checked before any server starts: with the owner's HOME it would read
  // the owner's credentials.
  const ownerHome = path.resolve(userInfo().homedir);
  assert.notEqual(
    path.resolve(homedir()),
    ownerHome,
    "tests run with the owner's HOME",
  );

  const { client } = await startServer(t, {});
  const homes = await client.callTool({
    name: "home_overview",
    arguments: {},
  });

  assert.equal(homes.isError, true);
  assert.equal(homes.structuredContent.missing_field, "SPRUTHUB_LOGIN");
  assert.equal(
    homes.structuredContent.credential_setup.file,
    path.join(homedir(), ".config", "sprut-agent", "connection.env"),
  );
});

test("a server under test cannot reach a hub off this machine", async (t) => {
  const { client, stderr } = await startServer(t, {
    SPRUTHUB_LOGIN: "isolation@example.invalid",
    SPRUTHUB_PASSWORD: "not-a-real-password",
    SPRUTHUB_URL: "wss://hub.sprut-agent-test.invalid/spruthub",
  });
  const homes = await client.callTool({
    name: "home_overview",
    arguments: {},
  });

  assert.equal(homes.isError, true);
  // stderr and the reply travel on different pipes.
  const refused = /test isolation: refused/;
  for (let wait = 0; wait < 100 && !refused.test(stderr()); wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(
    stderr(),
    /test isolation: refused a connection to hub\.sprut-agent-test\.invalid/,
  );
});

// A child started with its own env and no HOME would otherwise take the
// owner's home directory from the system user database.
const childProbe = `
const net = require("node:net");
let connection = "attempted";
try {
  net.connect(443, "hub.sprut-agent-test.invalid").on("error", () => {});
} catch (error) {
  connection = error.message;
}
console.log(JSON.stringify({ home: require("node:os").homedir(), connection }));
process.exit(0);
`;

function assertIsolatedChild(stdout) {
  const { home, connection } = JSON.parse(stdout);
  assert.notEqual(path.resolve(home), path.resolve(userInfo().homedir));
  assert.equal(home, homedir());
  assert.match(connection, /test isolation: refused/);
}

test("a child started with its own env through execFile sees neither the owner's home nor the network", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["-e", childProbe],
    { env: { PATH: process.env.PATH } },
  );
  assertIsolatedChild(stdout);
});

test("a child started with its own env through spawnSync sees neither the owner's home nor the network", () => {
  const result = spawnSync(process.execPath, ["-e", childProbe], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assertIsolatedChild(result.stdout);
});
