import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

const run = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const dashboardScript = path.join(
  projectRoot,
  "dist",
  "plugin",
  "dashboard.mjs",
);

test("the dashboard command leaves one independent poller and stops only that screen", {
  timeout: 20_000,
}, async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "sprut-dashboard-"));
  const stateDirectory = path.join(scratch, "state");
  const configFile = path.join(scratch, "home.json");
  const port = await reservePort();
  const hub = await startHub(t);
  await mkdir(stateDirectory);
  await writeFile(
    configFile,
    JSON.stringify({
      title: "Мой дом",
      home_ref: "spruthub://hub/home-1",
      port,
      readings: [
        {
          label: "Лампа",
          ref: "spruthub://hub/home-1/accessory/11/service/21/characteristic/31",
        },
      ],
    }),
  );
  const environment = {
    ...process.env,
    SPRUT_AGENT_DASHBOARD_STATE_DIR: stateDirectory,
    SPRUTHUB_URL: hub.url,
    SPRUTHUB_TOKEN: "local-token",
    SPRUTHUB_SERIAL: "home-1",
    SPRUTHUB_CID: "dashboard-test",
    SPRUTHUB_TIMEOUT_MS: "1000",
  };
  const command = (action) =>
    run(process.execPath, [dashboardScript, action, configFile], {
      cwd: projectRoot,
      env: environment,
    });
  t.after(async () => {
    await command("stop").catch(() => {});
    await rm(scratch, { recursive: true });
  });

  const started = JSON.parse((await command("start")).stdout);
  assert.equal(started.running, true);
  assert.equal(started.already_running, false);
  assert.equal(started.url, `http://127.0.0.1:${port}`);
  const firstState = await fetch(`${started.url}/api/readings`).then(
    (response) => response.json(),
  );
  assert.equal(firstState.readings[0].value, false);
  assert.equal(firstState.readings[0].stale, false);

  const readsBeforeRepeat = hub.accessoryReads;
  const repeated = JSON.parse((await command("start")).stdout);
  assert.equal(repeated.already_running, true);
  assert.equal(repeated.pid, started.pid);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(hub.accessoryReads, readsBeforeRepeat);

  await writeFile(
    configFile,
    JSON.stringify({
      title: "Мой обновлённый дом",
      home_ref: "spruthub://hub/home-1",
      port,
      readings: [
        {
          label: "Свет в офисе",
          ref: "spruthub://hub/home-1/accessory/11/service/21/characteristic/31",
        },
      ],
    }),
  );
  const replaced = JSON.parse((await command("start")).stdout);
  assert.equal(replaced.already_running, false);
  assert.notEqual(replaced.pid, started.pid);
  const replacedState = await fetch(`${replaced.url}/api/readings`).then(
    (response) => response.json(),
  );
  assert.equal(replacedState.title, "Мой обновлённый дом");
  assert.equal(replacedState.readings[0].label, "Свет в офисе");

  const stopped = JSON.parse((await command("stop")).stdout);
  assert.equal(stopped.running, false);
  await assert.rejects(fetch(started.url));
  assert.equal(hub.connections.size, 0);
});

test("start returns ready owner actions that restart the screen without the agent", {
  timeout: 20_000,
}, async (t) => {
  const scratch = await mkdtemp(
    path.join(tmpdir(), "sprut dashboard $' actions; "),
  );
  const userHome = path.join(scratch, "owner home");
  const configDirectory = path.join(scratch, "screen configs");
  const configFile = path.join(configDirectory, "owner's $screen;.json");
  const runtimeDirectory = path.join(scratch, "installed $bundle's; path");
  const runtime = path.join(runtimeDirectory, "dashboard runtime.mjs");
  const operatorDirectory = path.join(scratch, "operator elsewhere");
  const testSupportDirectory = path.join(scratch, "minimal path");
  const openerPreload = path.join(testSupportDirectory, "intercept opener.mjs");
  const openerLog = path.join(scratch, "opened $urls'.jsonl");
  const unrelatedAction = path.join(configDirectory, "open.command");
  const port = await reservePort();
  const hub = await startHub(t);
  await Promise.all([
    mkdir(path.join(userHome, ".config", "sprut-agent"), {
      recursive: true,
    }),
    mkdir(configDirectory, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(operatorDirectory, { recursive: true }),
    mkdir(testSupportDirectory, { recursive: true }),
  ]);
  await cp(dashboardScript, runtime);
  await writeFile(
    openerPreload,
    `import { appendFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (command === "/usr/bin/open" || command === "xdg-open") {
    appendFileSync(
      process.env.SPRUT_AGENT_TEST_OPEN_LOG,
      JSON.stringify({ opener: command, args }) + "\\n",
    );
    return spawn(process.execPath, ["-e", ""], options);
  }
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();

if (process.env.SPRUT_AGENT_TEST_PLATFORM) {
  Object.defineProperty(process, "platform", {
    value: process.env.SPRUT_AGENT_TEST_PLATFORM,
  });
}
`,
  );
  await writeFile(
    path.join(userHome, ".config", "sprut-agent", "connection.env"),
    [
      "SPRUTHUB_TOKEN=local-action-secret",
      `SPRUTHUB_URL=${hub.url}`,
      "SPRUTHUB_SERIAL=home-1",
      "SPRUTHUB_CID=dashboard-action-test",
      "SPRUTHUB_TIMEOUT_MS=1000",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(
    configFile,
    JSON.stringify({
      title: "Мой дом",
      home_ref: "spruthub://hub/home-1",
      port,
      readings: [
        {
          label: "Лампа",
          ref: "spruthub://hub/home-1/accessory/11/service/21/characteristic/31",
        },
      ],
    }),
  );
  await writeFile(unrelatedAction, "owner file\n");
  const environment = {
    HOME: userHome,
    NODE_OPTIONS: `--import=${pathToFileURL(openerPreload).href}`,
    PATH: testSupportDirectory,
    SPRUT_AGENT_TEST_OPEN_LOG: openerLog,
  };
  const platformEnvironment = (platform) => ({
    ...environment,
    SPRUT_AGENT_TEST_PLATFORM: platform,
  });
  const command = (action) =>
    run(process.execPath, [runtime, action, configFile], {
      cwd: operatorDirectory,
      env: environment,
    });
  t.after(async () => {
    await command("stop").catch(() => {});
    await rm(scratch, { recursive: true });
  });

  const started = JSON.parse((await command("start")).stdout);
  assert.equal(path.isAbsolute(started.actions.open_or_restart), true);
  assert.equal(path.isAbsolute(started.actions.stop), true);
  assert.equal(path.dirname(started.actions.open_or_restart), configDirectory);
  assert.equal(path.dirname(started.actions.stop), configDirectory);
  for (const action of Object.values(started.actions)) {
    assert.notEqual((await stat(action)).mode & 0o111, 0);
    const contents = await readFile(action, "utf8");
    assert.equal(contents.includes("local-action-secret"), false);
    assert.equal(contents.includes(hub.url), false);
    assert.equal(contents.includes("SPRUTHUB_"), false);
  }
  assert.equal(await readFile(unrelatedAction, "utf8"), "owner file\n");
  const actionFiles = (await readdir(configDirectory))
    .filter((name) => name.endsWith(".command"))
    .sort();
  assert.equal(actionFiles.length, 3);

  const stopped = JSON.parse(
    (
      await run(started.actions.stop, [], {
        cwd: operatorDirectory,
        env: environment,
      })
    ).stdout,
  );
  assert.equal(stopped.running, false);
  await assert.rejects(fetch(started.url));
  assert.equal(hub.connections.size, 0);

  const restartOutput = (
    await run(started.actions.open_or_restart, [], {
      cwd: operatorDirectory,
      env: platformEnvironment("darwin"),
    })
  ).stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(restartOutput[0].running, true);
  assert.equal(restartOutput[0].already_running, false);
  assert.deepEqual(restartOutput[0].actions, started.actions);
  assert.equal(restartOutput[1].status, "opened");
  assert.deepEqual(await readJsonLines(openerLog), [
    { opener: "/usr/bin/open", args: [started.url] },
  ]);
  assert.equal(
    (
      await fetch(`${started.url}/api/readings`).then((response) =>
        response.json(),
      )
    ).readings[0].value,
    false,
  );

  const repeatedOutput = (
    await run(started.actions.open_or_restart, [], {
      cwd: operatorDirectory,
      env: platformEnvironment("linux"),
    })
  ).stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(repeatedOutput[0].already_running, true);
  assert.equal(repeatedOutput[0].pid, restartOutput[0].pid);
  assert.deepEqual(repeatedOutput[0].actions, started.actions);
  assert.deepEqual(await readJsonLines(openerLog), [
    { opener: "/usr/bin/open", args: [started.url] },
    { opener: "xdg-open", args: [started.url] },
  ]);
  assert.deepEqual(
    (await readdir(configDirectory))
      .filter((name) => name.endsWith(".command"))
      .sort(),
    actionFiles,
  );

  await run(started.actions.stop, [], {
    cwd: operatorDirectory,
    env: environment,
  });
  await writeFile(started.actions.open_or_restart, "unrelated owner file\n");
  await assert.rejects(command("start"), (error) =>
    error.stderr.includes("is occupied by another file"),
  );
  assert.equal(
    await readFile(started.actions.open_or_restart, "utf8"),
    "unrelated owner file\n",
  );
  assert.equal(hub.connections.size, 0);
});

test("the dashboard rejects a non-characteristic selection before spawning", async (t) => {
  const scratch = await mkdtemp(
    path.join(tmpdir(), "sprut-dashboard-invalid-"),
  );
  const stateDirectory = path.join(scratch, "state");
  const configFile = path.join(scratch, "home.json");
  const port = await reservePort();
  const hub = await startHub(t);
  const validConfig = {
    title: "Мой дом",
    home_ref: "spruthub://hub/home-1",
    port,
    readings: [
      {
        label: "Лампа",
        ref: "spruthub://hub/home-1/accessory/11/service/21/characteristic/31",
      },
    ],
  };
  await mkdir(stateDirectory);
  await writeFile(configFile, JSON.stringify(validConfig));
  const environment = {
    ...process.env,
    SPRUT_AGENT_DASHBOARD_STATE_DIR: stateDirectory,
    SPRUTHUB_URL: hub.url,
    SPRUTHUB_TOKEN: "local-token",
    SPRUTHUB_SERIAL: "home-1",
    SPRUTHUB_CID: "dashboard-test",
    SPRUTHUB_TIMEOUT_MS: "1000",
  };
  const command = (action) =>
    run(process.execPath, [dashboardScript, action, configFile], {
      cwd: projectRoot,
      env: environment,
    });
  t.after(async () => {
    await writeFile(configFile, JSON.stringify(validConfig));
    await command("stop").catch(() => {});
    await rm(scratch, { recursive: true });
  });

  const started = JSON.parse((await command("start")).stdout);
  await writeFile(
    configFile,
    JSON.stringify({
      title: "Мой дом",
      home_ref: "spruthub://hub/home-1",
      port,
      readings: [
        {
          label: "Не характеристика",
          ref: "spruthub://hub/home-1/accessory/11",
        },
      ],
    }),
  );

  await assert.rejects(command("start"), (error) =>
    error.stderr.includes(
      "Every reading must be a characteristic reference in the selected home.",
    ),
  );
  const status = JSON.parse((await command("status")).stdout);
  assert.equal(status.running, true);
  assert.equal(status.pid, started.pid);
  assert.equal((await fetch(`${started.url}/health`)).status, 200);
  const stopped = JSON.parse((await command("stop")).stdout);
  assert.equal(stopped.running, false);
});

test("the installed dashboard exposes a compact operating contract", async () => {
  const help = await run(process.execPath, [dashboardScript, "--help"], {
    cwd: projectRoot,
  });

  assert.equal(help.stderr, "");
  assert(help.stdout.length < 2_000);
  assert.match(help.stdout, /home_ref/);
  assert.match(help.stdout, /characteristic/);
  for (const command of ["start", "open", "status", "stop"]) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test("the dashboard serves immediately while SprutHub is not answering", async (t) => {
  const scratch = await mkdtemp(
    path.join(tmpdir(), "sprut-dashboard-pending-"),
  );
  const stateDirectory = path.join(scratch, "state");
  const configFile = path.join(scratch, "home.json");
  const port = await reservePort();
  const hub = await startSilentHub(t);
  await mkdir(stateDirectory);
  await writeFile(
    configFile,
    JSON.stringify({
      title: "Мой дом",
      home_ref: "spruthub://hub/home-1",
      port,
      readings: [
        {
          label: "Лампа",
          ref: "spruthub://hub/home-1/accessory/11/service/21/characteristic/31",
        },
      ],
    }),
  );
  const environment = {
    ...process.env,
    SPRUT_AGENT_DASHBOARD_STATE_DIR: stateDirectory,
    SPRUTHUB_URL: hub.url,
    SPRUTHUB_TOKEN: "local-token",
    SPRUTHUB_SERIAL: "home-1",
    SPRUTHUB_CID: "dashboard-test",
    SPRUTHUB_TIMEOUT_MS: "10000",
  };
  const command = (action) =>
    run(process.execPath, [dashboardScript, action, configFile], {
      cwd: projectRoot,
      env: environment,
      timeout: 2_000,
    });
  t.after(async () => {
    await command("stop").catch(() => {});
    await rm(scratch, { recursive: true });
  });

  const startedAt = Date.now();
  const started = JSON.parse((await command("start")).stdout);
  assert.equal(started.running, true);
  assert(Date.now() - startedAt < 1_000);
  const state = await fetch(`${started.url}/api/readings`).then((response) =>
    response.json(),
  );
  assert.equal(state.status, "pending");
});

async function readJsonLines(file) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function startHub(t) {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const connections = new Set();
  const state = { accessoryReads: 0 };
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      let result;
      if (request.params?.hub?.list) {
        result = {
          hub: {
            list: {
              hubs: [
                {
                  serial: "home-1",
                  name: "Дом",
                  online: true,
                  owner: true,
                  support: false,
                },
              ],
            },
          },
        };
      } else if (request.params?.accessory?.get) {
        state.accessoryReads += 1;
        result = {
          accessory: {
            get: {
              id: 11,
              roomId: 1,
              name: "Лампа",
              online: true,
              services: [
                {
                  sId: 21,
                  name: "Лампа",
                  type: "Lightbulb",
                  characteristics: [
                    {
                      cId: 31,
                      control: {
                        name: "Включена",
                        type: "On",
                        read: true,
                        write: true,
                        events: true,
                        value: { boolValue: false },
                      },
                    },
                  ],
                },
              ],
            },
          },
        };
      } else {
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32601, message: "unsupported" },
          }),
        );
        return;
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of connections) socket.terminate();
        server.close(resolve);
      }),
  );
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    connections,
    get accessoryReads() {
      return state.accessoryReads;
    },
  };
}

async function startSilentHub(t) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  );
  return { url: `ws://127.0.0.1:${server.address().port}` };
}

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
