import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serial = "virtual-link-test-hub";
const homeRef = `spruthub://hub/${serial}`;
const roomRef = `${homeRef}/room/1`;
const dimaServiceRef = `${homeRef}/accessory/34/service/13`;
const dashaServiceRef = `${homeRef}/accessory/35/service/14`;
const groupAccessoryRef = `${homeRef}/accessory/90`;
const groupBrightnessRef = `${groupAccessoryRef}/service/1/characteristic/2`;
const dimaBrightnessRef = `${dimaServiceRef}/characteristic/16`;
const dimaTemperatureRef = `${dimaServiceRef}/characteristic/17`;
const dashaBrightnessRef = `${dashaServiceRef}/characteristic/21`;

function lightCharacteristic(aId, sId, cId, type, value, extra = {}) {
  const valueKey = typeof value === "boolean" ? "boolValue" : "intValue";
  return {
    aId,
    sId,
    cId,
    control: {
      name: type,
      type,
      read: true,
      write: true,
      value: { [valueKey]: value },
      ...(type === "Brightness"
        ? { minValue: 0, maxValue: 100, minStep: 1 }
        : {}),
      ...extra.control,
    },
    ...extra.fields,
  };
}

function physicalLamp({ id, sId, name, brightness, temperature = false }) {
  return {
    id,
    roomId: 1,
    name,
    online: true,
    virtual: false,
    services: [
      {
        aId: id,
        sId,
        name: `${name} свет`,
        type: "Lightbulb",
        characteristics: [
          lightCharacteristic(id, sId, id === 34 ? 15 : 20, "On", false),
          lightCharacteristic(
            id,
            sId,
            id === 34 ? 16 : 21,
            "Brightness",
            brightness,
          ),
          ...(temperature
            ? [lightCharacteristic(id, sId, 17, "ColorTemperature", 300)]
            : []),
        ],
      },
    ],
  };
}

function virtualLamp({
  id,
  name,
  brightness,
  hasLinks = true,
  linkProcessing = 0,
  includeVirtual = true,
}) {
  const accessory = {
    id,
    roomId: 1,
    name,
    online: true,
    services: [
      {
        aId: id,
        sId: 1,
        name,
        type: "Lightbulb",
        characteristics: [
          lightCharacteristic(id, 1, 1, "On", false, {
            fields: { hasLinks, linkProcessing },
          }),
          lightCharacteristic(id, 1, 2, "Brightness", brightness, {
            fields: { hasLinks, linkProcessing },
          }),
        ],
      },
    ],
  };
  if (includeVirtual) accessory.virtual = true;
  return accessory;
}

function incoming(physicalAId, physicalSId, physicalCId) {
  return {
    type: "IN",
    index: `Virtual/${physicalAId}.${physicalCId}`,
    characteristics: [{ aId: physicalAId, sId: physicalSId, cId: physicalCId }],
  };
}

function outgoing(physicalAId, physicalCId, consumers) {
  return {
    type: "OUT",
    index: `Virtual/${physicalAId}.${physicalCId}`,
    characteristics: consumers.map((consumer) => ({ ...consumer })),
  };
}

function systemLink() {
  return {
    type: "SYSTEM",
    index: "native-source/example",
    controller: "zigbee_1",
  };
}

function defaultLinks() {
  return new Map([
    ["90.1.1", [incoming(34, 13, 15), incoming(35, 14, 20)]],
    ["90.1.2", [incoming(34, 13, 16), incoming(35, 14, 21)]],
    ["91.1.1", [incoming(35, 14, 20)]],
    ["91.1.2", [incoming(35, 14, 21)]],
    [
      "34.13.15",
      [
        systemLink(),
        { type: "OUT", index: "Virtual/34.15", characteristics: [] },
        outgoing(34, 15, [{ aId: 90, sId: 1, cId: 1 }]),
      ],
    ],
    [
      "34.13.16",
      [systemLink(), outgoing(34, 16, [{ aId: 90, sId: 1, cId: 2 }])],
    ],
    [
      "35.14.20",
      [
        systemLink(),
        outgoing(35, 20, [
          { aId: 90, sId: 1, cId: 1 },
          { aId: 91, sId: 1, cId: 1 },
        ]),
      ],
    ],
    [
      "35.14.21",
      [
        systemLink(),
        outgoing(35, 21, [
          { aId: 90, sId: 1, cId: 2 },
          { aId: 91, sId: 1, cId: 2 },
        ]),
      ],
    ],
  ]);
}

async function startHub() {
  const requests = [];
  const state = {
    rooms: [{ id: 1, name: "Спальня", order: 1, visible: true }],
    accessories: [
      physicalLamp({
        id: 34,
        sId: 13,
        name: "Димина",
        brightness: 6,
        temperature: true,
      }),
      physicalLamp({ id: 35, sId: 14, name: "Дашина", brightness: 46 }),
      virtualLamp({ id: 90, name: "Свет спальни", brightness: 46 }),
      virtualLamp({ id: 91, name: "Другая группа", brightness: 46 }),
      {
        id: 80,
        roomId: 1,
        name: "Флаги",
        online: true,
        services: [
          {
            aId: 80,
            sId: 1,
            name: "Флаги",
            type: "Switch",
            characteristics: [
              lightCharacteristic(80, 1, 1, "On", false),
              lightCharacteristic(80, 1, 2, "On", false, {
                fields: { hasLinks: false, linkProcessing: 0 },
              }),
              lightCharacteristic(80, 1, 3, "On", false, {
                fields: { hasLinks: true, linkProcessing: 2 },
              }),
            ],
          },
        ],
      },
    ],
    links: defaultLinks(),
    behavior: {
      closeAfterNextLinkAdd: false,
      closeAfterNextLinkAddReadback: false,
      closeBeforeNextLinkList: false,
      closeAfterNextLinkRemove: false,
      closeBeforeNextLinkRemove: false,
    },
  };
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      const params = request.params;
      requests.push(structuredClone(params));
      let result;
      if (params.hub?.list) {
        result = {
          hub: { list: { hubs: [{ serial, name: "Дом", online: true }] } },
        };
      } else if (params.room?.get) {
        result = {
          room: {
            get:
              structuredClone(
                state.rooms.find(({ id }) => id === params.room.get.id),
              ) ?? null,
          },
        };
      } else if (params.accessory?.get) {
        result = {
          accessory: {
            get:
              structuredClone(
                state.accessories.find(
                  ({ id }) => id === params.accessory.get.id,
                ),
              ) ?? null,
          },
        };
      } else if (params.accessory?.list) {
        result = {
          accessory: {
            list: {
              accessories: state.accessories
                .filter(
                  ({ roomId }) =>
                    params.accessory.list.roomId === undefined ||
                    roomId === params.accessory.list.roomId,
                )
                .map((accessory) => structuredClone(accessory)),
            },
          },
        };
      } else if (params.link?.list) {
        if (state.behavior.closeBeforeNextLinkList) {
          state.behavior.closeBeforeNextLinkList = false;
          socket.close();
          return;
        }
        result = {
          link: {
            list: {
              links: structuredClone(
                state.links.get(linkKey(params.link.list)) ?? [],
              ),
            },
          },
        };
      } else if (params.link?.addVirtual) {
        const input = params.link.addVirtual;
        addVirtualLink(state, input);
        if (state.behavior.closeAfterNextLinkAdd) {
          state.behavior.closeAfterNextLinkAdd = false;
          socket.close();
          return;
        }
        if (state.behavior.closeAfterNextLinkAddReadback) {
          state.behavior.closeAfterNextLinkAddReadback = false;
          state.behavior.closeBeforeNextLinkList = true;
        }
        const incomingLink = (state.links.get(linkKey(input)) ?? []).find(
          ({ type, index }) =>
            type === "IN" && index === `Virtual/${input.tAId}.${input.tCId}`,
        );
        result = { link: { addVirtual: structuredClone(incomingLink) } };
      } else if (params.link?.remove) {
        if (state.behavior.closeBeforeNextLinkRemove) {
          state.behavior.closeBeforeNextLinkRemove = false;
          socket.close();
          return;
        }
        removeIncomingLink(state, params.link.remove);
        if (state.behavior.closeAfterNextLinkRemove) {
          state.behavior.closeAfterNextLinkRemove = false;
          socket.close();
          return;
        }
        result = { link: { remove: {} } };
      } else if (params.characteristic?.get) {
        result = {
          characteristic: {
            get: structuredClone(
              findCharacteristic(state, params.characteristic.get),
            ),
          },
        };
      } else if (params.characteristic?.update) {
        const input = params.characteristic.update;
        const characteristic = findCharacteristic(state, input);
        if (characteristic) {
          if (Object.hasOwn(input, "hasLinks")) {
            characteristic.hasLinks = input.hasLinks;
          }
          if (Object.hasOwn(input, "linkProcessing")) {
            characteristic.linkProcessing = input.linkProcessing;
          }
          if (input.control?.value) {
            characteristic.control.value = structuredClone(input.control.value);
          }
        }
        result = { characteristic: { update: {} } };
      } else {
        socket.send(
          JSON.stringify({
            id: request.id,
            error: {
              code: -32601,
              message: `Unexpected request: ${JSON.stringify(params)}`,
            },
          }),
        );
        return;
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  return {
    requests,
    server,
    state,
    url: `ws://127.0.0.1:${server.address().port}`,
  };
}

function addVirtualLink(state, input) {
  const key = linkKey(input);
  const links = state.links.get(key) ?? [];
  const incomingIndex = `Virtual/${input.tAId}.${input.tCId}`;
  let incomingLink = links.find(
    ({ index, type }) => type === "IN" && index === incomingIndex,
  );
  if (!incomingLink) {
    incomingLink = { index: incomingIndex, type: "IN", characteristics: [] };
    links.push(incomingLink);
    state.links.set(key, links);
  }
  const alreadyPresent = incomingLink.characteristics.some(
    ({ aId, sId, cId }) =>
      aId === input.tAId && sId === input.tSId && cId === input.tCId,
  );
  if (alreadyPresent) return;
  incomingLink.characteristics.push({
    aId: input.tAId,
    sId: input.tSId,
    cId: input.tCId,
  });
  const outgoingKey = linkKey({
    aId: input.tAId,
    sId: input.tSId,
    cId: input.tCId,
  });
  const outgoingLinks = state.links.get(outgoingKey) ?? [];
  const outgoingIndex = `Virtual/${input.tAId}.${input.tCId}`;
  let outgoingLink = outgoingLinks.find(
    ({ index, type }) => type === "OUT" && index === outgoingIndex,
  );
  if (!outgoingLink) {
    outgoingLink = { index: outgoingIndex, type: "OUT", characteristics: [] };
    outgoingLinks.push(outgoingLink);
  }
  outgoingLink.characteristics.push({
    aId: input.aId,
    sId: input.sId,
    cId: input.cId,
  });
  state.links.set(outgoingKey, outgoingLinks);
  const physical = findCharacteristic(state, {
    aId: input.tAId,
    sId: input.tSId,
    cId: input.tCId,
  });
  const virtualCharacteristic = findCharacteristic(state, input);
  if (physical?.control?.value && virtualCharacteristic?.control) {
    virtualCharacteristic.control.value = structuredClone(
      physical.control.value,
    );
  }
}

function removeIncomingLink(state, input) {
  const key = linkKey(input);
  const removed = (state.links.get(key) ?? []).find(
    ({ index }) => index === input.linkId,
  );
  state.links.set(
    key,
    (state.links.get(key) ?? []).filter(({ index }) => index !== input.linkId),
  );
  if (removed?.type !== "IN") return;
  for (const target of removed.characteristics) {
    const outgoingKey = linkKey(target);
    const remaining = [];
    for (const link of state.links.get(outgoingKey) ?? []) {
      if (link.type !== "OUT") {
        remaining.push(link);
        continue;
      }
      const characteristics = (link.characteristics ?? []).filter(
        ({ aId, sId, cId }) =>
          aId !== input.aId || sId !== input.sId || cId !== input.cId,
      );
      if (characteristics.length > 0 || link.characteristics.length === 0) {
        remaining.push({ ...link, characteristics });
      }
    }
    state.links.set(outgoingKey, remaining);
  }
}

function linkKey({ aId, sId, cId }) {
  return `${aId}.${sId}.${cId}`;
}

function findCharacteristic(state, { aId, sId, cId }) {
  return state.accessories
    .find(({ id }) => id === aId)
    ?.services.find((service) => service.sId === sId)
    ?.characteristics.find((characteristic) => characteristic.cId === cId);
}

function incomingTargets(state, source) {
  return (state.links.get(linkKey(source)) ?? [])
    .filter(({ type }) => type === "IN")
    .flatMap(({ characteristics }) =>
      characteristics.map(({ aId, sId, cId }) => `${aId}.${sId}.${cId}`),
    )
    .sort();
}

function outgoingConsumers(state, source) {
  return (state.links.get(linkKey(source)) ?? [])
    .filter(({ type }) => type === "OUT")
    .flatMap(({ characteristics }) =>
      characteristics.map(({ aId, sId, cId }) => `${aId}.${sId}.${cId}`),
    )
    .sort();
}

function isLinkWrite({ accessory, link, characteristic }) {
  return Boolean(
    accessory?.create ||
      accessory?.delete ||
      accessory?.update ||
      link?.addVirtual ||
      link?.remove ||
      characteristic?.update,
  );
}

async function setup(t) {
  const hub = await startHub();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-virtual-link-"),
  );
  t.after(async () => {
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, stateDirectory };
}

async function startClient(t, hub, stateDirectory) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "virtual-link-test-token",
      SPRUTHUB_SERIAL: serial,
      SPRUTHUB_CID: "virtual-link-test-client",
      SPRUTHUB_TIMEOUT_MS: "500",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "virtual-link-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

async function prepareLink(client, extra = {}) {
  return client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "virtual_light_link",
      target_ref: groupBrightnessRef,
      endpoint_ref: dashaBrightnessRef,
      value: false,
      reason: "Исключить Дашину лампу только из общей яркости",
      ...extra,
    },
  });
}

async function applyChange(client, changeRef) {
  return client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: changeRef },
  });
}

function assertBedroomIdentity(state) {
  const group = state.accessories.find(({ id }) => id === 90);
  assert.equal(group.name, "Свет спальни");
  assert.equal(group.roomId, 1);
  assert.equal(group.virtual, true);
}

function assertUnchangedPhysicalValues(state) {
  assert.deepEqual(
    findCharacteristic(state, { aId: 34, sId: 13, cId: 15 }).control.value,
    {
      boolValue: false,
    },
  );
  assert.deepEqual(
    findCharacteristic(state, { aId: 34, sId: 13, cId: 16 }).control.value,
    {
      intValue: 6,
    },
  );
  assert.deepEqual(
    findCharacteristic(state, { aId: 35, sId: 14, cId: 20 }).control.value,
    {
      boolValue: false,
    },
  );
  assert.deepEqual(
    findCharacteristic(state, { aId: 35, sId: 14, cId: 21 }).control.value,
    {
      intValue: 46,
    },
  );
}

test("get_entity keeps virtual, has_links and link_processing distinct from missing, false and zero", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  const room = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: roomRef },
  });
  assert.equal(room.isError, undefined, room.content[0]?.text);
  const bedroom = room.structuredContent.entity.accessories.find(
    ({ ref }) => ref === groupAccessoryRef,
  );
  const dima = room.structuredContent.entity.accessories.find(
    ({ ref }) => ref === `${homeRef}/accessory/34`,
  );
  const flagsAccessory = room.structuredContent.entity.accessories.find(
    ({ ref }) => ref === `${homeRef}/accessory/80`,
  );
  assert.equal(bedroom.virtual, true);
  assert.equal(dima.virtual, false);
  assert.equal(flagsAccessory.virtual, null);

  const group = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: groupAccessoryRef },
  });
  assert.equal(group.isError, undefined, group.content[0]?.text);
  assert.equal(group.structuredContent.entity.virtual, true);
  const brightness =
    group.structuredContent.entity.services[0].characteristics.find(
      ({ type }) => type === "Brightness",
    );
  assert.equal(brightness.has_links, true);
  assert.equal(brightness.link_processing, 0);

  const physicalBrightness = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: dimaBrightnessRef },
  });
  assert.equal(physicalBrightness.structuredContent.entity.has_links, null);
  assert.equal(
    physicalBrightness.structuredContent.entity.link_processing,
    null,
  );

  const missingFlags = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: `${homeRef}/accessory/80/service/1/characteristic/1`,
    },
  });
  const disabledLinks = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: `${homeRef}/accessory/80/service/1/characteristic/2`,
    },
  });
  const syncLinks = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: `${homeRef}/accessory/80/service/1/characteristic/3`,
    },
  });
  assert.equal(missingFlags.structuredContent.entity.has_links, null);
  assert.equal(missingFlags.structuredContent.entity.link_processing, null);
  assert.equal(disabledLinks.structuredContent.entity.has_links, false);
  assert.equal(disabledLinks.structuredContent.entity.link_processing, 0);
  assert.equal(syncLinks.structuredContent.entity.has_links, true);
  assert.equal(syncLinks.structuredContent.entity.link_processing, 2);

  const relations = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: groupBrightnessRef,
      include: ["relations"],
    },
  });
  assert.equal(relations.isError, undefined, relations.content[0]?.text);
  const related =
    relations.structuredContent.entity.relations.characteristic_links
      .filter(({ type }) => type === "IN")
      .flatMap(({ related_characteristic_refs }) => related_characteristic_refs)
      .sort();
  assert.deepEqual(related, [dimaBrightnessRef, dashaBrightnessRef].sort());
});

test("the public native path excludes one lamp from shared brightness and keeps shared on", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const writesBefore = hub.requests.filter(isLinkWrite).length;

  const prepared = await prepareLink(client);
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.equal(prepared.structuredContent.operation, "virtual_light_link");
  assert.equal(prepared.structuredContent.target_ref, groupBrightnessRef);
  assert.equal(prepared.structuredContent.endpoint_ref, dashaBrightnessRef);
  assert.equal(prepared.structuredContent.requested_presence, false);
  assert.equal(hub.requests.filter(isLinkWrite).length, writesBefore);

  const applied = await applyChange(
    client,
    prepared.structuredContent.change_ref,
  );
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.observed_presence, false);
  assert.equal(applied.structuredContent.observed_virtual_value.value, 46);
  assert.equal(
    hub.requests.some(({ characteristic }) => characteristic?.update),
    false,
  );
  assert.equal(
    hub.requests.some(
      ({ accessory }) => accessory?.create || accessory?.delete,
    ),
    false,
  );

  assert.deepEqual(incomingTargets(hub.state, { aId: 90, sId: 1, cId: 2 }), [
    "34.13.16",
  ]);
  assert.deepEqual(incomingTargets(hub.state, { aId: 90, sId: 1, cId: 1 }), [
    "34.13.15",
    "35.14.20",
  ]);
  assert.deepEqual(
    outgoingConsumers(hub.state, { aId: 35, sId: 14, cId: 21 }),
    ["91.1.2"],
  );
  assert.deepEqual(
    outgoingConsumers(hub.state, { aId: 35, sId: 14, cId: 20 }),
    ["90.1.1", "91.1.1"],
  );
  assert.equal(
    findCharacteristic(hub.state, { aId: 90, sId: 1, cId: 2 }).hasLinks,
    true,
  );
  assert.equal(
    findCharacteristic(hub.state, { aId: 90, sId: 1, cId: 2 }).linkProcessing,
    0,
  );
  assertBedroomIdentity(hub.state);
  assertUnchangedPhysicalValues(hub.state);
  assert.deepEqual(
    findCharacteristic(hub.state, { aId: 90, sId: 1, cId: 2 }).control.value,
    { intValue: 46 },
  );

  const alreadyAbsent = await prepareLink(client, {
    reason: "Повторить исключение уже снятой яркости",
  });
  assert.equal(alreadyAbsent.structuredContent.status, "already_desired");
  assert.equal(alreadyAbsent.structuredContent.owned_change_created, false);
  assert.equal(alreadyAbsent.structuredContent.native_write_sent, false);
});

test("a later process can return the same brightness member without duplicating the link", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const first = await startClient(t, hub, stateDirectory);
  const removed = await prepareLink(first);
  await applyChange(first, removed.structuredContent.change_ref);
  await first.close();

  const second = await startClient(t, hub, stateDirectory);
  const prepared = await prepareLink(second, {
    value: true,
    reason: "Вернуть Дашину лампу под общую яркость",
  });
  assert.equal(prepared.structuredContent.status, "prepared");
  const applied = await applyChange(
    second,
    prepared.structuredContent.change_ref,
  );
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.observed_presence, true);
  assert.deepEqual(incomingTargets(hub.state, { aId: 90, sId: 1, cId: 2 }), [
    "34.13.16",
    "35.14.21",
  ]);
  assert.deepEqual(
    outgoingConsumers(hub.state, { aId: 35, sId: 14, cId: 21 }),
    ["90.1.2", "91.1.2"],
  );
  assert.equal(
    incomingTargets(hub.state, { aId: 90, sId: 1, cId: 2 }).filter(
      (target) => target === "35.14.21",
    ).length,
    1,
  );
  assert.deepEqual(
    findCharacteristic(hub.state, { aId: 90, sId: 1, cId: 2 }).control.value,
    { intValue: 46 },
  );
  assertUnchangedPhysicalValues(hub.state);

  const repeated = await prepareLink(second, {
    value: true,
    reason: "Повторно вернуть уже связанную лампу",
  });
  assert.equal(repeated.structuredContent.status, "already_desired");
  assert.equal(repeated.structuredContent.owned_change_created, false);
  assert.equal(repeated.structuredContent.native_write_sent, false);
});

test("restore in a new process undoes only the owned brightness membership", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const first = await startClient(t, hub, stateDirectory);
  const prepared = await prepareLink(first);
  await applyChange(first, prepared.structuredContent.change_ref);
  await first.close();

  const second = await startClient(t, hub, stateDirectory);
  const restored = await second.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(incomingTargets(hub.state, { aId: 90, sId: 1, cId: 2 }), [
    "34.13.16",
    "35.14.21",
  ]);
  assert.deepEqual(incomingTargets(hub.state, { aId: 90, sId: 1, cId: 1 }), [
    "34.13.15",
    "35.14.20",
  ]);
  assert.deepEqual(
    outgoingConsumers(hub.state, { aId: 35, sId: 14, cId: 21 }),
    ["90.1.2", "91.1.2"],
  );
  assertBedroomIdentity(hub.state);
  assertUnchangedPhysicalValues(hub.state);
});

test("an incompatible color or type is refused before any link write", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const writesBefore = hub.requests.filter(isLinkWrite).length;

  const color = await prepareLink(client, {
    endpoint_ref: dimaTemperatureRef,
    reason: "Связать температуру белого как общую яркость",
  });
  assert.equal(color.isError, true);
  assert.equal(
    color.structuredContent.error.code,
    "incompatible_link_endpoint",
  );
  assert.equal(hub.requests.filter(isLinkWrite).length, writesBefore);

  const last = await prepareLink(client);
  await applyChange(client, last.structuredContent.change_ref);
  const writesAfterRemove = hub.requests.filter(isLinkWrite).length;
  const removeLast = await prepareLink(client, {
    endpoint_ref: dimaBrightnessRef,
    reason: "Снять последнюю общую яркость",
  });
  assert.equal(removeLast.isError, true);
  assert.equal(
    removeLast.structuredContent.error.code,
    "last_incoming_link_protected",
  );
  assert.equal(hub.requests.filter(isLinkWrite).length, writesAfterRemove);
  assert.deepEqual(incomingTargets(hub.state, { aId: 90, sId: 1, cId: 2 }), [
    "34.13.16",
  ]);
});

test("a lost link write stays unknown until the graph is read and does not duplicate", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  hub.state.behavior.closeAfterNextLinkRemove = true;
  const prepared = await prepareLink(client);
  const interrupted = await applyChange(
    client,
    prepared.structuredContent.change_ref,
  );
  assert.equal(interrupted.isError, true);

  const recovered = await startClient(t, hub, stateDirectory);
  const inspected = await recovered.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(inspected.structuredContent.status, "applied");
  assert.equal(
    inspected.structuredContent.recovered_after_uncertain_write,
    true,
  );
  assert.deepEqual(incomingTargets(hub.state, { aId: 90, sId: 1, cId: 2 }), [
    "34.13.16",
  ]);
  const addWritesBefore = hub.requests.filter(
    ({ link }) => link?.addVirtual,
  ).length;
  const repeated = await applyChange(
    recovered,
    prepared.structuredContent.change_ref,
  );
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ link }) => link?.addVirtual).length,
    addWritesBefore,
  );
  assert.equal(hub.requests.filter(({ link }) => link?.remove).length, 1);
});

test("a later manual rewrite of the selected link is not overwritten by restore", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await prepareLink(client);
  await applyChange(client, prepared.structuredContent.change_ref);
  addVirtualLink(hub.state, {
    aId: 90,
    sId: 1,
    cId: 2,
    tAId: 35,
    tSId: 14,
    tCId: 21,
  });
  assert.deepEqual(incomingTargets(hub.state, { aId: 90, sId: 1, cId: 2 }), [
    "34.13.16",
    "35.14.21",
  ]);

  const writesBeforeRestore = hub.requests.filter(isLinkWrite).length;
  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(hub.requests.filter(isLinkWrite).length, writesBeforeRestore);
  assert.deepEqual(incomingTargets(hub.state, { aId: 90, sId: 1, cId: 2 }), [
    "34.13.16",
    "35.14.21",
  ]);
});
