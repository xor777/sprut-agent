import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("the dashboard rejects a non-characteristic selection before spawning", async (t) => {
  const scratch = await mkdtemp(
    path.join(tmpdir(), "sprut-dashboard-invalid-"),
  );
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
          label: "Не характеристика",
          ref: "spruthub://hub/home-1/accessory/11",
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
  t.after(async () => {
    await rm(scratch, { recursive: true });
  });

  await assert.rejects(
    run(process.execPath, [dashboardScript, "start", configFile], {
      cwd: projectRoot,
      env: environment,
    }),
    (error) =>
      error.stderr.includes(
        "Every reading must be a characteristic reference in the selected home.",
      ),
  );
  assert.equal(hub.accessoryReads, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
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
