import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { litHome, scaledHome } from "./fixtures/homes/scaled.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// The owner's home will at least double. A household question must cost
// the agent the same at every size: the MCP answer and the number of native
// requests may not grow with the devices that the question is not about.
// Reads of named devices, scenarios and their relations must not pull the
// whole home from the hub either: their native reply bytes stay flat too.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SIZES = [80, 160, 320];
const home = "spruthub://hub/sim-scaled-01";
const livingRoom = `${home}/room/3`;
// "Вечерний свет в гостиной" and the floor lamp's On, which two BLOCKs use.
const eveningScenario = `${home}/scenario/14`;
const floorLampOn = `${home}/accessory/16/service/13/characteristic/14`;
const FLAT_TRAFFIC = new Set([
  "scenario_summary_cold",
  "relations_cold",
  "bedroom_temperature",
  "living_room_lights",
  "scenario_summary_warm",
]);

function listed(body) {
  return body.rooms.flatMap((room) =>
    room.devices.flatMap((device) =>
      device.services.map((service) => ({ room, device, service })),
    ),
  );
}

async function connect(t, fixture) {
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
  return { hub, client };
}

async function measure(t, accessoryCount) {
  const { hub, client } = await connect(
    t,
    scaledHome(await loadHomeFixture("apartment"), accessoryCount),
  );
  const questions = {};
  const ask = async (question, name, args) => {
    const before = hub.requests.length;
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    const native = hub.requests.slice(before);
    questions[question] = {
      bytes: Buffer.byteLength(result.content[0].text),
      requests: native.length,
      replyBytes: native.reduce(
        (sum, { responseBytes }) => sum + responseBytes,
        0,
      ),
    };
    return result.structuredContent;
  };

  // A fresh MCP process has no catalog yet.
  const scenario = await ask("scenario_summary_cold", "get_entity", {
    entity_ref: eveningScenario,
  });
  const relations = await ask("relations_cold", "get_entity", {
    entity_ref: floorLampOn,
    include: ["relations"],
  });
  const overview = await ask("overview", "home_overview", {});
  const on = await ask("whats_on", "find_devices", { state: "on" });
  const temperature = await ask("bedroom_temperature", "find_devices", {
    query: "температура в спальне",
  });
  const lights = await ask("living_room_lights", "find_devices", {
    room_ref: livingRoom,
    kind: "light",
  });
  await ask("scenario_summary_warm", "get_entity", {
    entity_ref: eveningScenario,
  });
  return {
    accessories: hub.state.accessories.length,
    services: hub.state.accessories.flatMap(({ services }) => services).length,
    questions,
    answers: { overview, on, temperature, lights, scenario, relations },
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
    const { overview, on, temperature, lights, scenario, relations } =
      run.answers;
    assert.equal(scenario.entity.name, "Вечерний свет в гостиной");
    assert.equal(
      JSON.stringify(scenario.entity.summary),
      JSON.stringify(runs[0].answers.scenario.entity.summary),
    );
    assert.match(JSON.stringify(scenario.entity.summary), /Торшер/);
    assert.deepEqual(
      relations.entity.relations.scenario_roles.map(
        ({ scenario_ref: ref }) => ref,
      ),
      runs[0].answers.relations.entity.relations.scenario_roles.map(
        ({ scenario_ref: ref }) => ref,
      ),
    );
    assert(relations.entity.relations.scenario_roles.length >= 2);
    assert.equal(
      relations.entity.relations.unchecked.some(({ area }) => area === "names"),
      false,
    );
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
      `${question}: ${values.map(({ bytes, requests, replyBytes }) => `${bytes}B/${requests}req/${replyBytes}B native`).join(" -> ")}`,
    );
    const measures = FLAT_TRAFFIC.has(question)
      ? ["bytes", "requests", "replyBytes"]
      : ["bytes", "requests"];
    for (const measure of measures) {
      const series = values.map((value) => value[measure]);
      assert(
        Math.max(...series) <= Math.min(...series) * 1.1,
        `${question} ${measure} grow with the home: ${series.join(", ")}`,
      );
    }
  }
});

// «Какой свет горит?» at the owner's lights: 11 lamps on, most with color,
// 7 unavailable and 3 relays on at 80 accessories, twice that at 160. The
// answer is one page with what the agent acts on: each lamp's On ref and
// brightness, and why a state is unknown. Every value is one parameter away.
test("what lights are on fits one page at the owner's lamp count and at twice it", async (t) => {
  const apartment = await loadHomeFixture("apartment");
  const sizes = [];
  for (const [accessories, share] of [
    [80, 1],
    [160, 2],
  ]) {
    const { hub, client } = await connect(t, litHome(apartment, accessories));
    const result = await client.callTool({
      name: "find_devices",
      arguments: { kind: "light", state: "on" },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    const body = result.structuredContent;
    sizes.push(`${accessories}: ${Buffer.byteLength(result.content[0].text)}B`);

    // Independent of the product: the lamps the simulator holds as on, with
    // their On ref and brightness.
    const lampsOn = hub.state.accessories.flatMap((accessory) =>
      accessory.online === false
        ? []
        : accessory.services.flatMap(({ sId, type, characteristics }) => {
            const control = (name) =>
              characteristics.find((item) => item.control.type === name);
            const on = control("On");
            if (type !== "Lightbulb" || on.control.value.boolValue !== true) {
              return [];
            }
            const ref = `${home}/accessory/${accessory.id}/service/${sId}`;
            return [
              {
                ref,
                on_ref: `${ref}/characteristic/${on.cId}`,
                brightness: control("Brightness")?.control.value.intValue,
              },
            ];
          }),
    );
    assert.equal(lampsOn.length, 11 * share);
    assert.equal(body.next, null);
    const byRef = (left, right) => left.ref.localeCompare(right.ref);
    assert.deepEqual(
      listed(body)
        .map(({ service }) => ({
          ref: service.ref,
          on_ref: service.values.find(({ type }) => type === "On")?.ref,
          brightness: service.values.find(({ type }) => type === "Brightness")
            ?.value,
        }))
        .sort(byRef),
      lampsOn.sort(byRef),
    );
    assert.equal(body.not_evaluated_total, 7 * share);
    assert(body.not_evaluated.every(({ reason }) => reason === "unavailable"));
    assert.equal(body.switches.total, 3 * share);
    assert(body.switches.entries.every(({ on_ref: ref }) => ref));

    const full = await client.callTool({
      name: body.all_values.tool,
      arguments: body.all_values.arguments,
    });
    assert.equal(full.isError, undefined, full.content[0]?.text);
    assert(
      listed(full.structuredContent).some(({ service }) =>
        service.values.some(({ type }) => type === "Hue"),
      ),
    );
  }
  t.diagnostic(`find_devices {kind: light, state: on}: ${sizes.join(", ")}`);
});

// «Какие уведомления включены?» Only accessory.get reports a
// characteristic's notification (owner hub, 2026-10-12-notifications-live),
// so the whole-home answer reads each accessory once. It lists only the
// notifications that are on: the same answer at the owner's size and at
// twice it.
test("which notifications are on lists the same ones at the owner's size and at twice it, reading each accessory once", async (t) => {
  const apartment = await loadHomeFixture("apartment");
  const runs = [];
  for (const size of [80, 160]) {
    const { hub, client } = await connect(t, scaledHome(apartment, size));
    // Turned on in the SprutHub app: the kitchen leak sensor going offline
    // and the front door opening.
    const characteristic = (aId, sId, cId) =>
      hub.state.accessories
        .find(({ id }) => id === aId)
        .services.find((service) => service.sId === sId)
        .characteristics.find((item) => item.cId === cId);
    characteristic(23, 1, 8).notify = true;
    characteristic(11, 13, 14).notify = true;
    const before = hub.requests.length;
    const started = performance.now();
    const result = await client.callTool({
      name: "find_devices",
      arguments: { notify: true },
    });
    const ms = Math.round(performance.now() - started);
    assert.equal(result.isError, undefined, result.content[0]?.text);
    const native = hub.requests.slice(before);
    const byId = (left, right) => left - right;
    assert.deepEqual(
      native
        .filter(({ method }) => method === "accessory.get")
        .map(({ params }) => params.accessory.get.id)
        .sort(byId),
      hub.state.accessories.map(({ id }) => id).sort(byId),
    );
    runs.push({
      size,
      ms,
      requests: native.length,
      replyBytes: native.reduce(
        (sum, { responseBytes }) => sum + responseBytes,
        0,
      ),
      bytes: Buffer.byteLength(result.content[0].text),
      body: result.structuredContent,
    });
  }
  for (const { body } of runs) {
    assert.equal(body.next, null);
    assert.deepEqual(
      listed(body).map(({ service }) => [
        service.ref,
        [...(service.values ?? []), ...(service.characteristics ?? [])]
          .filter(({ notify }) => notify === true)
          .map(({ ref }) => ref),
      ]),
      [
        [
          `${home}/accessory/11/service/13`,
          [`${home}/accessory/11/service/13/characteristic/14`],
        ],
        [
          `${home}/accessory/23/service/1`,
          [`${home}/accessory/23/service/1/characteristic/8`],
        ],
      ],
    );
  }
  assert.equal(runs[0].bytes, runs[1].bytes);
  t.diagnostic(
    `find_devices {notify: true}: ${runs
      .map(
        ({ size, ms, requests, replyBytes, bytes }) =>
          `${size} accessories ${requests}req/${replyBytes}B native, ${bytes}B answer, ${ms}ms`,
      )
      .join("; ")}`,
  );
});
