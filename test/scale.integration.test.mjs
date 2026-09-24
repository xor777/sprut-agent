import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scaledHome } from "./fixtures/homes/scaled.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// The owner's home will at least double. A household question must cost
// the agent the same at every size: the MCP answer and the number of native
// requests may not grow with the devices that the question is not about.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SIZES = [80, 160, 320];
const home = "spruthub://hub/sim-scaled-01";
const livingRoom = `${home}/room/3`;

function listed(body) {
  return body.rooms.flatMap((room) =>
    room.devices.flatMap((device) =>
      device.services.map((service) => ({ room, device, service })),
    ),
  );
}

async function measure(t, accessoryCount) {
  const fixture = scaledHome(
    await loadHomeFixture("apartment"),
    accessoryCount,
  );
  const hub = await startSimulatedHub(fixture);
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "sprut-scale-"));
  const client = new Client({ name: "scale-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/server.mjs"],
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        ...hub.connectionEnv(),
        SPRUTHUB_TIMEOUT_MS: "5000",
        SPRUT_AGENT_STATE_DIR: stateDirectory,
      },
      stderr: "pipe",
    }),
  );
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const questions = {};
  const ask = async (question, name, args) => {
    const before = hub.requests.length;
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    questions[question] = {
      bytes: Buffer.byteLength(result.content[0].text),
      requests: hub.requests.length - before,
    };
    return result.structuredContent;
  };

  const overview = await ask("overview", "home_overview", {});
  const on = await ask("whats_on", "find_devices", { state: "on" });
  const temperature = await ask("bedroom_temperature", "find_devices", {
    query: "температура в спальне",
  });
  const lights = await ask("living_room_lights", "find_devices", {
    room_ref: livingRoom,
    kind: "light",
  });
  return {
    accessories: hub.state.accessories.length,
    services: hub.state.accessories.flatMap(({ services }) => services).length,
    questions,
    answers: { overview, on, temperature, lights },
  };
}

test("household reads cost the same at 1x, 2x and 4x the owner's home", async (t) => {
  const runs = [];
  for (const size of SIZES) runs.push(await measure(t, size));

  assert.deepEqual(
    runs.map(({ accessories }) => accessories),
    SIZES,
  );
  for (const run of runs) {
    assert(
      run.services >= run.accessories * 2.8 &&
        run.services <= run.accessories * 3.6,
      `${run.services} services for ${run.accessories} accessories`,
    );
    const { overview, on, temperature, lights } = run.answers;
    assert.equal(overview.rooms.length, 13);
    assert.equal(overview.problems_total, 2);
    assert.deepEqual(
      listed(on).map(({ device, service }) => `${device.name}/${service.name}`),
      listed(runs[0].answers.on).map(
        ({ device, service }) => `${device.name}/${service.name}`,
      ),
    );
    assert.deepEqual(
      listed(temperature).map(({ room, service }) => [
        room.name,
        service.values.find(({ type }) => type === "CurrentTemperature").value,
      ]),
      [
        ["Спальня", 21.4],
        ["Детская спальня", 23.8],
      ],
    );
    assert.deepEqual(
      listed(lights).map(({ device }) => device.name),
      ["Люстра", "Торшер", "Светодиодная лента"],
    );
  }
  assert.equal(listed(runs[0].answers.on).length, 7);

  for (const question of Object.keys(runs[0].questions)) {
    const values = runs.map(({ questions }) => questions[question]);
    t.diagnostic(
      `${question}: ${values.map(({ bytes, requests }) => `${bytes}B/${requests}req`).join(" -> ")}`,
    );
    for (const measure of ["bytes", "requests"]) {
      const series = values.map((value) => value[measure]);
      assert(
        Math.max(...series) <= Math.min(...series) * 1.1,
        `${question} ${measure} grow with the home: ${series.join(", ")}`,
      );
    }
  }
});
