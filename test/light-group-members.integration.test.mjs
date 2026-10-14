import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  BEDROOM_LAMP,
  GROUP,
  GROUP_CHARACTERISTICS,
  LAMP_CHARACTERISTICS,
  NEW_LAMP,
  OFFLINE_MEMBER,
} from "./fixtures/homes/kitchen-chandelier.mjs";
import {
  diffHomeSnapshots,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// «Я поменял лампу в люстре — перевяжи группу»: an existing virtual lamp
// group of the owner's kind (test/fixtures/homes/kitchen-chandelier.mjs)
// gets the named set of lamps through virtual_light_group with the group's
// lamp service as target_ref. The group stays the same accessory; a joining
// lamp gets a link for each characteristic the group links, a leaving one
// loses its links, and undo puts the previous links back.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const TYPES = Object.keys(GROUP_CHARACTERISTICS);
const groupRef = `${homeRef}/accessory/${GROUP.aId}/service/${GROUP.sId}`;
const lampRef = (aId) => `${homeRef}/accessory/${aId}/service/13`;
// A kitchen lamp with colour but no colour temperature.
const PLAIN_LAMP = 47;

async function setup(t, patch = (fixture) => fixture, hubOptions = {}) {
  const hub = await startSimulatedHub(
    patch(await loadHomeFixture("kitchen-chandelier")),
    hubOptions,
  );
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-light-group-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: "2000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "light-group-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

async function prepareMembers(client, members, reason = "Перевязать люстру") {
  return call(client, "prepare_native_change", {
    operation: "virtual_light_group",
    target_ref: groupRef,
    member_service_refs: members.map(lampRef),
    reason,
  });
}

// The lamps each group characteristic has an IN link to, by type.
function groupLinks(hub) {
  return Object.fromEntries(
    TYPES.map((type) => [
      type,
      (hub.state.links.get(`44.13.${GROUP_CHARACTERISTICS[type]}`) ?? [])
        .filter(({ type: linkType }) => linkType === "IN")
        .flatMap(({ characteristics }) => characteristics)
        .map(({ aId, sId, cId }) => `${aId}.${sId}.${cId}`)
        .sort(),
    ]),
  );
}

// Each group type linked to exactly these lamps' characteristic of the
// same type.
function expectedLinks(lamps, types = TYPES) {
  return Object.fromEntries(
    TYPES.map((type) => [
      type,
      lamps
        .filter((lamp) => types.includes(type) || lamp !== PLAIN_LAMP)
        .map((lamp) => `${lamp}.13.${LAMP_CHARACTERISTICS[type]}`)
        .sort(),
    ]),
  );
}

function memberOf(result, aId) {
  return result.members.find(({ service_ref: ref }) => ref === lampRef(aId));
}

function value(hub, aId, cId) {
  const control = hub.state.accessories
    .find(({ id }) => id === aId)
    .services.find(({ sId }) => sId === 13)
    .characteristics.find((entry) => entry.cId === cId).control;
  return Object.values(control.value)[0];
}

function linkRequestsSince(hub, from) {
  return hub.requests
    .slice(from)
    .filter(
      ({ method }) => method.startsWith("link.") && method !== "link.list",
    );
}

test("the contract of a lamp group names its lamps and what it links; a real lamp is not a group", async (t) => {
  const { hub, client } = await setup(t);

  const read = await call(client, "get_native_change_contract", {
    operation: "virtual_light_group",
    target_ref: groupRef,
  });

  assert.equal(read.contract.lamp_group.ref, groupRef);
  assert.equal(read.contract.lamp_group.name, "Люстра");
  assert.equal(read.contract.lamp_group.room, "Кухня");
  assert.deepEqual(read.contract.characteristics, TYPES);
  assert.deepEqual(
    read.contract.members.map(({ service_ref: ref, name, online }) => [
      ref,
      name,
      online,
    ]),
    [
      [lampRef(41), "Лампа люстры 1", true],
      [lampRef(42), "Лампа люстры 2", true],
      [lampRef(43), "Лампа люстры 3", false],
    ],
  );
  assert.deepEqual(hub.writes(), []);

  const lamp = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "virtual_light_group", target_ref: lampRef(41) },
  });
  assert.equal(lamp.isError, true);
  assert.equal(lamp.structuredContent.error.code, "not_a_lamp_group");
});

test("a replaced lamp: the new one joins on every characteristic, the offline one leaves, and the group switches the new one", async (t) => {
  const { hub, client } = await setup(t);
  const before = hub.snapshot();

  const prepared = await prepareMembers(client, [41, 42, NEW_LAMP]);

  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.operation, "virtual_light_group");
  assert.deepEqual(prepared.characteristics, TYPES);
  assert.deepEqual(memberOf(prepared, NEW_LAMP), {
    service_ref: lampRef(NEW_LAMP),
    name: "Лампочка",
    room: "Кухня",
    online: true,
    change: "joins",
    links_added: TYPES,
  });
  assert.deepEqual(memberOf(prepared, OFFLINE_MEMBER), {
    service_ref: lampRef(OFFLINE_MEMBER),
    name: "Лампа люстры 3",
    room: "Кухня",
    online: false,
    change: "leaves",
    links_removed: TYPES,
  });
  assert.equal(memberOf(prepared, 41).change, "stays");
  assert.equal(memberOf(prepared, 42).change, "stays");
  assert.deepEqual(hub.writes(), [], "prepare writes nothing");

  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });

  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.deepEqual(groupLinks(hub), expectedLinks([41, 42, NEW_LAMP]));
  // The group is the same accessory and nothing else in the home changed:
  // the links of the group, the joining and the leaving lamp, and the
  // values the group took from the joining lamp (last-value feedback).
  const unexpected = diffHomeSnapshots(before, hub.snapshot()).filter(
    ({ key }) =>
      !/^link\/(44|45|43)\.13\.\d+$/.test(key) &&
      !/^characteristic\/44\.13\.\d+\/\w+$/.test(key),
  );
  assert.deepEqual(unexpected, []);

  // «Включи люстру»: the group's command reaches the new lamp.
  const sent = await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: [
      {
        target_ref: `${groupRef}/characteristic/${GROUP_CHARACTERISTICS.On}`,
        value: true,
      },
    ],
    reason: "Включи люстру",
  });
  assert.equal(sent.results[0].status, "applied");
  assert.equal(value(hub, NEW_LAMP, LAMP_CHARACTERISTICS.On), true);
  assert.equal(value(hub, 41, LAMP_CHARACTERISTICS.On), true);
  assert.equal(value(hub, OFFLINE_MEMBER, LAMP_CHARACTERISTICS.On), false);
  assert.equal(value(hub, BEDROOM_LAMP, LAMP_CHARACTERISTICS.On), false);
});

test("an added lamp leaves every member's links as they were", async (t) => {
  const { hub, client } = await setup(t);
  const memberLinks = () =>
    TYPES.map((type) =>
      JSON.stringify(
        hub.state.links
          .get(`44.13.${GROUP_CHARACTERISTICS[type]}`)
          .filter(({ characteristics }) =>
            characteristics.some(({ aId }) => aId !== NEW_LAMP),
          ),
      ),
    );
  const before = memberLinks();

  const prepared = await prepareMembers(client, [41, 42, 43, NEW_LAMP]);
  assert.deepEqual(
    prepared.members.map(({ change }) => change),
    ["stays", "stays", "stays", "joins"],
  );
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });

  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.deepEqual(groupLinks(hub), expectedLinks([41, 42, 43, NEW_LAMP]));
  assert.deepEqual(memberLinks(), before);
  assert.deepEqual(
    linkRequestsSince(hub, 0).map(({ method }) => method),
    TYPES.map(() => "link.addVirtual"),
  );
});

test("an offline lamp is taken out and the others keep following the group", async (t) => {
  const { hub, client } = await setup(t);

  const prepared = await prepareMembers(client, [41, 42]);
  assert.equal(memberOf(prepared, OFFLINE_MEMBER).change, "leaves");
  assert.equal(memberOf(prepared, OFFLINE_MEMBER).online, false);
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });

  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.deepEqual(groupLinks(hub), expectedLinks([41, 42]));
  await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: [
      {
        target_ref: `${groupRef}/characteristic/${GROUP_CHARACTERISTICS.Brightness}`,
        value: 40,
      },
    ],
    reason: "Люстру на 40%",
  });
  assert.equal(value(hub, 41, LAMP_CHARACTERISTICS.Brightness), 40);
  assert.equal(value(hub, 42, LAMP_CHARACTERISTICS.Brightness), 40);
  assert.equal(value(hub, OFFLINE_MEMBER, LAMP_CHARACTERISTICS.Brightness), 80);
});

test("the same lamps again is already desired and writes nothing", async (t) => {
  const { hub, client } = await setup(t);

  const prepared = await prepareMembers(client, [43, 42, 41]);

  assert.equal(prepared.status, "already_desired");
  assert.deepEqual(hub.writes(), []);
});

// A group of two whose other lamp is gone keeps the one left.
test("a group may keep a single lamp", async (t) => {
  const { client } = await setup(t);

  const prepared = await prepareMembers(client, [41]);

  assert.equal(prepared.status, "prepared");
  assert.deepEqual(
    prepared.members.map(({ change }) => change),
    ["stays", "leaves", "leaves"],
  );
});

test("undo puts back the previous lamps with their links", async (t) => {
  const { hub, client } = await setup(t);
  const initial = Object.fromEntries(
    TYPES.map((type) => [
      type,
      structuredClone(
        hub.state.links.get(`44.13.${GROUP_CHARACTERISTICS[type]}`),
      ),
    ]),
  );
  const prepared = await prepareMembers(client, [41, 42, NEW_LAMP]);
  await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });

  const restored = await call(client, "restore_native_change", {
    change_refs: [prepared.change_ref],
  });

  assert.equal(restored.status, "ok", JSON.stringify(restored));
  assert.equal(restored.results[0].status, "restored");
  assert.equal(restored.results[0].operation, "virtual_light_group");
  for (const type of TYPES) {
    assert.deepEqual(
      hub.state.links
        .get(`44.13.${GROUP_CHARACTERISTICS[type]}`)
        .map(({ index, characteristics }) => ({ index, characteristics }))
        .sort((left, right) => left.index.localeCompare(right.index)),
      initial[type]
        .map(({ index, characteristics }) => ({ index, characteristics }))
        .sort((left, right) => left.index.localeCompare(right.index)),
      type,
    );
  }
  const checked = await call(client, "get_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(checked.status, "restored");
});

test("a link changed by hand between apply and undo is reported and left as the owner set it", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await prepareMembers(client, [41, 42, NEW_LAMP]);
  await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  // The owner unlinks the first lamp's On in the SprutHub app.
  hub.request({
    link: {
      remove: {
        ...GROUP,
        cId: GROUP_CHARACTERISTICS.On,
        linkId: `Virtual/41.${LAMP_CHARACTERISTICS.On}`,
      },
    },
  });
  const from = hub.requests.length;

  const restored = await call(client, "restore_native_change", {
    change_refs: [prepared.change_ref],
  });

  assert.equal(restored.results[0].status, "skipped");
  assert.equal(restored.results[0].reason, "changed_since");
  assert.deepEqual(linkRequestsSince(hub, from), [], "nothing written");
  const expected = expectedLinks([41, 42, NEW_LAMP]);
  expected.On = expected.On.filter((key) => !key.startsWith("41."));
  assert.deepEqual(groupLinks(hub), expected);
});

test("undo after the owner put the lamps back by hand says it is already as before", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await prepareMembers(client, [41, 42, NEW_LAMP]);
  await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  // In the app: the new lamp out, the old one back.
  for (const type of TYPES) {
    const source = { ...GROUP, cId: GROUP_CHARACTERISTICS[type] };
    hub.request({
      link: {
        remove: {
          ...source,
          linkId: `Virtual/${NEW_LAMP}.${LAMP_CHARACTERISTICS[type]}`,
        },
      },
    });
    hub.request({
      link: {
        addVirtual: {
          ...source,
          tAId: OFFLINE_MEMBER,
          tSId: 13,
          tCId: LAMP_CHARACTERISTICS[type],
        },
      },
    });
  }
  const from = hub.requests.length;

  const restored = await call(client, "restore_native_change", {
    change_refs: [prepared.change_ref],
  });

  assert.equal(restored.results[0].status, "skipped", JSON.stringify(restored));
  assert.equal(restored.results[0].reason, "changed_since");
  assert.equal(restored.results[0].already_previous, true);
  assert.deepEqual(linkRequestsSince(hub, from), []);
});

test("a lamp without colour temperature joins on what it has, and the preview says what it lacks", async (t) => {
  const { hub, client } = await setup(t, (fixture) => {
    fixture.accessories.push({
      id: PLAIN_LAMP,
      roomId: 4,
      name: "Лампа без температуры",
      extensionKey: "Controller:zigbee",
      manufacturer: "Sprut",
      model: "SIM-RGB",
      services: [
        {
          sId: 13,
          type: "Lightbulb",
          name: "Свет",
          characteristics: TYPES.filter(
            (type) => type !== "ColorTemperature",
          ).map((type) => ({
            cId: LAMP_CHARACTERISTICS[type],
            type,
            value: type === "On" ? false : 10,
          })),
        },
      ],
    });
    return fixture;
  });

  const prepared = await prepareMembers(client, [41, 42, 43, PLAIN_LAMP]);

  assert.deepEqual(memberOf(prepared, PLAIN_LAMP).links_added, [
    "On",
    "Brightness",
    "Hue",
    "Saturation",
  ]);
  assert.deepEqual(memberOf(prepared, PLAIN_LAMP).lacks, ["ColorTemperature"]);
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.deepEqual(
    groupLinks(hub),
    expectedLinks(
      [41, 42, 43, PLAIN_LAMP],
      ["On", "Brightness", "Hue", "Saturation"],
    ),
  );
});

// A link write lost on its way is unknown, not done or failed; applying
// again reads the links first and sends only what is missing.
test("a lost link write is unknown until apply again reads and finishes it", async (t) => {
  const { hub, client } = await setup(t, undefined, {
    faults: {
      droppedReply: [{ method: "link.addVirtual", applied: false }],
    },
  });
  const prepared = await prepareMembers(client, [41, 42, 43, NEW_LAMP]);

  const first = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(first.status, "uncertain", JSON.stringify(first));
  assert.equal(first.conflict_reason, "link_write_outcome_unknown");

  const again = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });

  assert.equal(again.status, "applied", JSON.stringify(again));
  assert.deepEqual(groupLinks(hub), expectedLinks([41, 42, 43, NEW_LAMP]));
});

test("a link step the hub refuses leaves a partial change that undo removes", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await prepareMembers(client, [41, 42, NEW_LAMP]);
  hub.refuseNext("link.remove", { code: -32000, message: "Busy" });

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.change_ref },
  });

  assert.equal(applied.isError, true);
  const refused = applied.structuredContent;
  assert.equal(refused.hub_effect, "partial", JSON.stringify(refused));
  assert.deepEqual(refused.next, {
    tool: "restore_native_change",
    arguments: { change_ref: prepared.change_ref },
  });
  // The new lamp joined, the old one is still linked.
  assert.deepEqual(groupLinks(hub), expectedLinks([41, 42, 43, NEW_LAMP]));

  const restored = await call(client, "restore_native_change", {
    change_refs: [prepared.change_ref],
  });

  assert.equal(
    restored.results[0].status,
    "restored",
    JSON.stringify(restored),
  );
  assert.deepEqual(groupLinks(hub), expectedLinks([41, 42, 43]));
});
