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

// The kitchen's services in find_devices, by ref.
async function kitchenServices(client) {
  const page = await call(client, "find_devices", {
    home_ref: homeRef,
    room_ref: `${homeRef}/room/4`,
  });
  return new Map(
    page.rooms.flatMap((room) =>
      room.devices.flatMap((device) =>
        device.services.map((service) => [service.ref, service]),
      ),
    ),
  );
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

// The group takes the on/off of a lamp that joins (2026-10-14
// light-group-relink, 11 and 14) and a command equal to what it shows
// does not reach the lamps (12): a new lamp that is on leaves the kept,
// switched-off lamps out of step, and «включи люстру» then misses them.
test("a lamp that joins switched on leaves the kept lamps out of step, and the preview names them", async (t) => {
  const { client: quiet } = await setup(t);
  const allOff = await prepareMembers(quiet, [41, 42, NEW_LAMP]);
  assert.ok(
    !(allOff.notes ?? []).some((note) => /Лампа люстры [12]/.test(note)),
    JSON.stringify(allOff.notes),
  );

  const { hub, client } = await setup(t, (fixture) => {
    fixture.accessories
      .find(({ id }) => id === NEW_LAMP)
      .services[0].characteristics.find(
        ({ type }) => type === "On",
      ).value = true;
    return fixture;
  });

  const prepared = await prepareMembers(client, [41, 42, NEW_LAMP]);

  const note = (prepared.notes ?? []).find((text) =>
    /Лампа люстры 1/.test(text),
  );
  assert.ok(note, JSON.stringify(prepared.notes));
  assert.match(note, /Лампа люстры 2/);
  assert.doesNotMatch(note, /Лампа люстры 3/);
  // What the note warns of: after apply the group reads on, and turning it
  // on reaches none of the kept lamps.
  await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
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
  assert.notEqual(sent.results[0].status, "rejected");
  assert.equal(value(hub, 41, LAMP_CHARACTERISTICS.On), false);
});

// «Люстра» is a lamp to the ordinary reads; they say it is a group of
// which lamps, and which lamps are in a group, so the agent relinks a lamp
// already on the hub instead of pairing it again.
test("find_devices and get_entity show a lamp group with its lamps and the lamps in it", async (t) => {
  const { client } = await setup(t);
  const kitchen = await kitchenServices(client);

  // A lamp of the group is offline, so the group names the online lamps
  // of its room that are in no group, with what the group links that they
  // lack: «Свет на кухне» has no colour. Not the bedroom's unlinked
  // «Лампочка», not the group's own lamps.
  assert.deepEqual(kitchen.get(groupRef).lamp_group, {
    lamps: [
      { name: "Лампа люстры 1", room: "Кухня", online: true },
      { name: "Лампа люстры 2", room: "Кухня", online: true },
      { name: "Лампа люстры 3", room: "Кухня", online: false },
    ],
    unlinked_lamps_in_room: [
      {
        name: "Свет на кухне",
        service_ref: `${homeRef}/accessory/22/service/13`,
        lacks: ["Hue", "Saturation", "ColorTemperature"],
      },
      { name: "Лампочка", service_ref: lampRef(NEW_LAMP) },
    ],
  });
  const inChandelier = [
    { name: "Люстра", room: "Кухня", service_ref: groupRef },
  ];
  assert.deepEqual(kitchen.get(lampRef(41)).in_lamp_groups, inChandelier);
  assert.deepEqual(kitchen.get(lampRef(43)).in_lamp_groups, inChandelier);
  for (const ref of [lampRef(NEW_LAMP), `${homeRef}/accessory/22/service/13`]) {
    assert.equal(kitchen.get(ref).in_lamp_groups, undefined, ref);
    assert.equal(kitchen.get(ref).lamp_group, undefined, ref);
  }
  // get_entity marks lamps from a home snapshot that is fresh, as it is
  // right after find_devices; it does not read the home for them.
  const group = await call(client, "get_entity", {
    entity_ref: `${homeRef}/accessory/${GROUP.aId}`,
  });
  assert.deepEqual(
    group.entity.services.find(({ ref }) => ref === groupRef).lamp_group,
    kitchen.get(groupRef).lamp_group,
  );
  const lamp = await call(client, "get_entity", {
    entity_ref: `${homeRef}/accessory/41`,
  });
  assert.deepEqual(
    lamp.entity.services.find(({ ref }) => ref === lampRef(41)).in_lamp_groups,
    inChandelier,
  );

  // The agent's own relink shows in the next read.
  const prepared = await prepareMembers(client, [41, 42, NEW_LAMP]);
  await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  const after = await kitchenServices(client);
  assert.deepEqual(after.get(groupRef).lamp_group, {
    lamps: [
      { name: "Лампа люстры 1", room: "Кухня", online: true },
      { name: "Лампа люстры 2", room: "Кухня", online: true },
      { name: "Лампочка", room: "Кухня", online: true },
    ],
  });
  assert.deepEqual(after.get(lampRef(NEW_LAMP)).in_lamp_groups, inChandelier);
  assert.equal(after.get(lampRef(43)).in_lamp_groups, undefined);
});

// lacks follows the group's links, not its lamps' type: a group linking
// only On and Brightness finds nothing missing in «Свет на кухне».
test("what an unlinked lamp lacks follows what the group links", async (t) => {
  const { client } = await setup(t, (fixture) => {
    fixture.links = fixture.links.filter(
      ({ aId, cId }) =>
        aId !== GROUP.aId ||
        cId === GROUP_CHARACTERISTICS.On ||
        cId === GROUP_CHARACTERISTICS.Brightness,
    );
    return fixture;
  });

  const kitchen = await kitchenServices(client);

  assert.deepEqual(kitchen.get(groupRef).lamp_group.unlinked_lamps_in_room, [
    {
      name: "Свет на кухне",
      service_ref: `${homeRef}/accessory/22/service/13`,
    },
    { name: "Лампочка", service_ref: lampRef(NEW_LAMP) },
  ]);
});

// A white lamp that replaced a colour one is still a lamp the group can
// take (prepare links it on what it has): it is shown with what it lacks.
test("a white lamp in the room is shown with what it lacks, not left out", async (t) => {
  const { client } = await setup(t, (fixture) => {
    const lamp = fixture.accessories.find(({ id }) => id === NEW_LAMP);
    lamp.services[0].characteristics = lamp.services[0].characteristics.filter(
      ({ type }) => type === "On" || type === "Brightness",
    );
    return fixture;
  });

  const kitchen = await kitchenServices(client);
  const unlinked = kitchen.get(groupRef).lamp_group.unlinked_lamps_in_room;

  assert.deepEqual(
    unlinked.find(({ service_ref }) => service_ref === lampRef(NEW_LAMP)),
    {
      name: "Лампочка",
      service_ref: lampRef(NEW_LAMP),
      lacks: ["Hue", "Saturation", "ColorTemperature"],
    },
  );
});

// A new lamp that joined in another room, or none on the hub: the kitchen
// has no unlinked lamp, and the group says only that, never that the new
// lamp is not on the hub.
test("with no unlinked lamp in the room the group does not claim the new lamp is missing", async (t) => {
  const { client } = await setup(t, (fixture) => {
    fixture.accessories.find(({ id }) => id === NEW_LAMP).roomId = 5;
    fixture.accessories.find(({ id }) => id === 22).online = false;
    return fixture;
  });

  const kitchen = await kitchenServices(client);
  const group = kitchen.get(groupRef).lamp_group;

  assert.deepEqual(group.unlinked_lamps_in_room, []);
  assert.match(group.no_unlinked_lamp, /Кухня/);
  assert.match(group.no_unlinked_lamp, /another room/);
  assert.doesNotMatch(group.no_unlinked_lamp, /not on the hub/);
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
