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
import { FAKE_HUB_HOST, ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serial = "virtual-light-test-hub";
const homeRef = `spruthub://hub/${serial}`;
const roomRef = `${homeRef}/room/1`;
const memberServiceRefs = [
  `${homeRef}/accessory/34/service/13`,
  `${homeRef}/accessory/35/service/14`,
];

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
      ...extra,
    },
  };
}

function memberAccessory({ id, sId, name, temperature = false }) {
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
            id === 34 ? 40 : 70,
            { minValue: 0, maxValue: 100, minStep: 1 },
          ),
          ...(temperature
            ? [lightCharacteristic(id, sId, 17, "ColorTemperature", 300)]
            : []),
          lightCharacteristic(
            id,
            sId,
            id === 34 ? 18 : 22,
            "StatusActive",
            true,
            { write: false },
          ),
        ],
      },
    ],
  };
}

async function startHub() {
  const requests = [];
  const state = {
    rooms: [{ id: 1, name: "Офис", order: 1, visible: true }],
    accessories: [
      memberAccessory({ id: 34, sId: 13, name: "Димина", temperature: true }),
      memberAccessory({ id: 35, sId: 14, name: "Дашина" }),
      memberAccessory({ id: 36, sId: 15, name: "Чужая" }),
    ],
    serviceTypes: [
      {
        type: "Lightbulb",
        name: "Лампочка",
        required: [{ type: "On" }],
        optional: [
          { type: "Brightness" },
          { type: "ColorTemperature" },
          { type: "StatusActive" },
        ],
      },
    ],
    links: new Map(),
    nextAccessoryId: 90,
    behavior: {
      closeAfterAccessoryCreate: false,
      closeAfterAccessoryDelete: false,
      closeAccessoryGetAfterDelete: false,
      closeBeforeNextAccessoryGet: false,
      closeAfterNextLinkAdd: false,
      closeAfterNextLinkAddReadback: false,
      closeBeforeNextLinkList: false,
      closeLinkListAfterRemoveAt: undefined,
      closeBeforeNextLinkRemove: false,
      closeAfterNextLinkRemove: false,
      normalizeNextAccessoryName: false,
      preservePhysicalOutOnIncomingRemove: false,
      preserveEmptyPhysicalOutOnIncomingRemove: false,
      dropForeignPhysicalConsumersOnIncomingRemove: false,
      failLinkRemoveOnAttempt: undefined,
    },
    linkRemoveAttempts: 0,
    linkListsUntilCloseAfterRemove: undefined,
  };
  const server = new WebSocketServer({ host: FAKE_HUB_HOST, port: 0 });
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
        if (state.behavior.closeBeforeNextAccessoryGet) {
          state.behavior.closeBeforeNextAccessoryGet = false;
          socket.close();
          return;
        }
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
      } else if (params.service?.types) {
        result = {
          service: {
            types: {
              types: structuredClone(state.serviceTypes),
            },
          },
        };
      } else if (params.accessory?.create) {
        const createInput = structuredClone(params.accessory.create);
        if (state.behavior.normalizeNextAccessoryName) {
          createInput.name = createInput.name.slice(0, 30);
          state.behavior.normalizeNextAccessoryName = false;
        }
        const created = createVirtualAccessory(
          state.nextAccessoryId++,
          createInput,
        );
        state.accessories.push(created);
        if (state.behavior.closeAfterAccessoryCreate) {
          state.behavior.closeAfterAccessoryCreate = false;
          socket.close();
          return;
        }
        const createResponse = structuredClone(created);
        delete createResponse.virtual;
        result = { accessory: { create: createResponse } };
      } else if (params.accessory?.delete) {
        const at = state.accessories.findIndex(
          ({ id }) => id === params.accessory.delete.id,
        );
        if (at >= 0) state.accessories.splice(at, 1);
        for (const key of state.links.keys()) {
          if (key.startsWith(`${params.accessory.delete.id}.`)) {
            state.links.delete(key);
          }
        }
        if (state.behavior.closeAccessoryGetAfterDelete) {
          state.behavior.closeAccessoryGetAfterDelete = false;
          state.behavior.closeBeforeNextAccessoryGet = true;
        }
        if (state.behavior.closeAfterAccessoryDelete) {
          state.behavior.closeAfterAccessoryDelete = false;
          socket.close();
          return;
        }
        result = { accessory: { delete: {} } };
      } else if (params.link?.list) {
        if (state.linkListsUntilCloseAfterRemove !== undefined) {
          state.linkListsUntilCloseAfterRemove -= 1;
          if (state.linkListsUntilCloseAfterRemove === 0) {
            state.linkListsUntilCloseAfterRemove = undefined;
            socket.close();
            return;
          }
        }
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
        const key = linkKey(input);
        const links = state.links.get(key) ?? [];
        const incomingIndex = `Virtual/${input.tAId}.${input.tCId}`;
        let incoming = links.find(
          ({ index, type }) => type === "IN" && index === incomingIndex,
        );
        if (!incoming) {
          incoming = {
            index: incomingIndex,
            type: "IN",
            characteristics: [],
          };
          links.push(incoming);
          state.links.set(key, links);
        }
        if (
          !incoming.characteristics.some(
            ({ aId, sId, cId }) =>
              aId === input.tAId && sId === input.tSId && cId === input.tCId,
          )
        ) {
          incoming.characteristics.push({
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
          let outgoing = outgoingLinks.find(
            ({ index, type }) => type === "OUT" && index === outgoingIndex,
          );
          if (!outgoing) {
            outgoing = {
              index: outgoingIndex,
              type: "OUT",
              characteristics: [],
            };
            outgoingLinks.push(outgoing);
          }
          outgoing.characteristics.push({
            aId: input.aId,
            sId: input.sId,
            cId: input.cId,
          });
          state.links.set(outgoingKey, outgoingLinks);
        }
        if (state.behavior.closeAfterNextLinkAdd) {
          state.behavior.closeAfterNextLinkAdd = false;
          socket.close();
          return;
        }
        if (state.behavior.closeAfterNextLinkAddReadback) {
          state.behavior.closeAfterNextLinkAddReadback = false;
          state.behavior.closeBeforeNextLinkList = true;
        }
        result = { link: { addVirtual: structuredClone(incoming) } };
      } else if (params.link?.remove) {
        state.linkRemoveAttempts += 1;
        if (state.behavior.closeBeforeNextLinkRemove) {
          state.behavior.closeBeforeNextLinkRemove = false;
          socket.close();
          return;
        }
        if (state.behavior.closeLinkListAfterRemoveAt !== undefined) {
          state.linkListsUntilCloseAfterRemove =
            state.behavior.closeLinkListAfterRemoveAt;
          state.behavior.closeLinkListAfterRemoveAt = undefined;
        }
        if (
          state.linkRemoveAttempts === state.behavior.failLinkRemoveOnAttempt
        ) {
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: -32603, message: "Injected link.remove failure" },
            }),
          );
          return;
        }
        const key = linkKey(params.link.remove);
        const removed = (state.links.get(key) ?? []).find(
          ({ index }) => index === params.link.remove.linkId,
        );
        state.links.set(
          key,
          (state.links.get(key) ?? []).filter(
            ({ index }) => index !== params.link.remove.linkId,
          ),
        );
        if (removed?.type === "IN") {
          for (const target of removed.characteristics) {
            const outgoingKey = linkKey(target);
            if (!state.behavior.preservePhysicalOutOnIncomingRemove) {
              const remaining = [];
              for (const link of state.links.get(outgoingKey) ?? []) {
                if (link.type !== "OUT") {
                  remaining.push(link);
                  continue;
                }
                const characteristics = state.behavior
                  .dropForeignPhysicalConsumersOnIncomingRemove
                  ? []
                  : (link.characteristics ?? []).filter(
                      ({ aId, sId, cId }) =>
                        aId !== params.link.remove.aId ||
                        sId !== params.link.remove.sId ||
                        cId !== params.link.remove.cId,
                    );
                if (
                  characteristics.length > 0 ||
                  state.behavior.preserveEmptyPhysicalOutOnIncomingRemove
                ) {
                  remaining.push({ ...link, characteristics });
                }
              }
              state.links.set(outgoingKey, remaining);
            }
          }
        }
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
          const previousValue = structuredClone(characteristic.control.value);
          if (Object.hasOwn(input, "hasLinks")) {
            characteristic.hasLinks = input.hasLinks;
          }
          if (Object.hasOwn(input, "linkProcessing")) {
            characteristic.linkProcessing = input.linkProcessing;
          }
          if (input.control?.value) {
            characteristic.control.value = structuredClone(input.control.value);
            if (
              JSON.stringify(previousValue) !==
              JSON.stringify(input.control.value)
            ) {
              for (const link of state.links.get(linkKey(input)) ?? []) {
                if (link.type !== "IN") continue;
                for (const target of link.characteristics) {
                  findCharacteristic(state, target).control.value =
                    structuredClone(input.control.value);
                }
              }
            }
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

function createVirtualAccessory(id, input) {
  const serviceInput = input.services[0];
  const types = ["On", ...serviceInput.optional];
  return {
    id,
    roomId: input.roomId,
    name: input.name,
    online: true,
    virtual: true,
    services: [
      {
        aId: id,
        sId: 1,
        name: serviceInput.name,
        type: serviceInput.type,
        characteristics: types.map((type, index) =>
          lightCharacteristic(
            id,
            1,
            index + 1,
            type,
            type === "On" ? false : 0,
            type === "Brightness"
              ? { minValue: 0, maxValue: 100, minStep: 1 }
              : {},
          ),
        ),
      },
    ],
  };
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

async function setup(t) {
  const hub = await startHub();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-virtual-light-"),
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
      SPRUTHUB_TOKEN: "virtual-light-test-token",
      SPRUTHUB_SERIAL: serial,
      SPRUTHUB_CID: "virtual-light-test-client",
      SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "virtual-light-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

async function prepareGroup(client, extra = {}) {
  return client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "virtual_light_group",
      target_ref: homeRef,
      room_ref: roomRef,
      name: "Общий свет",
      member_service_refs: memberServiceRefs,
      characteristic_types: ["On", "Brightness"],
      reason: "Управлять двумя лампами как одним светом",
      ...extra,
    },
  });
}

test("the virtual light contract is discoverable without guessing a target", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const requestsBeforeContracts = hub.requests.length;

  const general = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "virtual_light_group" },
  });
  assert.equal(general.isError, undefined, general.content[0]?.text);
  assert.deepEqual(general.structuredContent.contract.characteristics, [
    "On",
    "Brightness",
  ]);
  assert.equal(general.structuredContent.contract.feedback, "LAST_VALUE");
  assert.equal(
    general.structuredContent.contract.limitations.some((limitation) =>
      limitation.includes("same-valued virtual command"),
    ),
    true,
  );

  const selectedHome = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "virtual_light_group", target_ref: homeRef },
  });
  assert.equal(selectedHome.isError, undefined, selectedHome.content[0]?.text);
  assert.deepEqual(
    selectedHome.structuredContent.contract,
    general.structuredContent.contract,
  );

  for (const targetRef of [
    `${homeRef}/room/1`,
    "spruthub://hub/another-home",
  ]) {
    const refused = await client.callTool({
      name: "get_native_change_contract",
      arguments: {
        operation: "virtual_light_group",
        target_ref: targetRef,
      },
    });
    assert.equal(refused.isError, true);
  }
  assert.equal(hub.requests.length, requestsBeforeContracts);
});

test("the public native path creates only the common light controls and is repeat-safe", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  const prepared = await prepareGroup(client);
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.deepEqual(prepared.structuredContent.characteristic_types, [
    "On",
    "Brightness",
  ]);
  assert.deepEqual(
    prepared.structuredContent.member_service_refs,
    memberServiceRefs,
  );
  assert.equal(
    hub.requests.some(
      ({ accessory, link, characteristic }) =>
        accessory?.create || link?.addVirtual || characteristic?.update,
    ),
    false,
  );

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(
    applied.structuredContent.virtual_accessory_creation_owned,
    true,
  );
  assert.equal(applied.structuredContent.native_acknowledged, true);
  assert.equal(applied.structuredContent.configuration_matches, true);
  assert.deepEqual(applied.structuredContent.characteristics, [
    {
      type: "On",
      ref: `${homeRef}/accessory/90/service/1/characteristic/1`,
    },
    {
      type: "Brightness",
      ref: `${homeRef}/accessory/90/service/1/characteristic/2`,
    },
  ]);

  const createRequests = hub.requests.filter(
    ({ accessory }) => accessory?.create,
  );
  assert.deepEqual(createRequests, [
    {
      accessory: {
        create: {
          name: "Общий свет",
          roomId: 1,
          services: [
            {
              name: "Общий свет",
              type: "Lightbulb",
              optional: ["Brightness"],
            },
          ],
        },
      },
    },
  ]);
  assert.deepEqual(
    hub.requests
      .filter(({ link }) => link?.addVirtual)
      .map(({ link }) => link.addVirtual),
    [
      { aId: 90, sId: 1, cId: 1, tAId: 34, tSId: 13, tCId: 15 },
      { aId: 90, sId: 1, cId: 1, tAId: 35, tSId: 14, tCId: 20 },
      { aId: 90, sId: 1, cId: 2, tAId: 34, tSId: 13, tCId: 16 },
      { aId: 90, sId: 1, cId: 2, tAId: 35, tSId: 14, tCId: 21 },
    ],
  );
  assert.deepEqual(
    hub.requests
      .filter(({ characteristic }) => characteristic?.update)
      .map(({ characteristic }) => characteristic.update),
    [
      { aId: 90, sId: 1, cId: 1, hasLinks: true },
      { aId: 90, sId: 1, cId: 2, hasLinks: true },
    ],
  );
  assert.deepEqual(
    hub.state.accessories
      .find(({ id }) => id === 90)
      .services[0].characteristics.map(({ control }) => control.type),
    ["On", "Brightness"],
  );

  const writesBeforeRepeat = hub.requests.filter(isGroupWrite).length;
  const repeated = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(isGroupWrite).length, writesBeforeRepeat);

  findCharacteristic(hub.state, { aId: 34, sId: 13, cId: 16 }).control.value = {
    intValue: 10,
  };
  assert.deepEqual(
    findCharacteristic(hub.state, { aId: 35, sId: 14, cId: 21 }).control.value,
    { intValue: 70 },
    "reading/reconciling the group must not copy one member's manual value to another",
  );
  const inspected = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(inspected.structuredContent.status, "applied");
  assert.deepEqual(
    findCharacteristic(hub.state, { aId: 35, sId: 14, cId: 21 }).control.value,
    { intValue: 70 },
  );
  assert.equal(
    hub.requests.some(
      ({ link }) =>
        link?.addVirtual && [17, 18, 22].includes(link.addVirtual.tCId),
    ),
    false,
  );
});

test("restore deletes only an unchanged owned virtual accessory", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(firstClient);
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(
    hub.requests.filter(({ accessory }) => accessory?.delete),
    [{ accessory: { delete: { id: 90 } } }],
  );
  assert.deepEqual(
    hub.requests
      .filter(({ link }) => link?.remove)
      .map(({ link }) => link.remove),
    [
      { aId: 90, sId: 1, cId: 1, linkId: "Virtual/34.15" },
      { aId: 90, sId: 1, cId: 1, linkId: "Virtual/35.20" },
      { aId: 90, sId: 1, cId: 2, linkId: "Virtual/34.16" },
      { aId: 90, sId: 1, cId: 2, linkId: "Virtual/35.21" },
    ],
  );
  assert.equal(
    hub.requests.findIndex(({ link }) => link?.remove) <
      hub.requests.findIndex(({ accessory }) => accessory?.delete),
    true,
    "the native UI removes the virtual IN link before deleting its accessory",
  );
  assert.deepEqual(
    [...hub.state.links.entries()].filter(([, links]) => links.length > 0),
    [],
    "restore must not leave the empty physical OUT artifacts observed live",
  );
  assert.deepEqual(
    hub.state.accessories.map(({ id }) => id),
    [34, 35, 36],
  );
});

test("create and restore tolerate omitted repeated fields without removing system links", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.serviceTypes.unshift(
    {
      type: "GenericService",
      name: "Неизвестный сервис",
      optional: [{ type: "GenericBoolean" }],
    },
    {
      type: "AudioStreamManagement",
      name: "Управление аудио потоком",
      required: [{ type: "SupportedAudioStreamConfiguration" }],
    },
  );
  const systemLink = {
    type: "SYSTEM",
    index: "native-source/example",
    controller: "zigbee_1",
  };
  hub.state.links.set("34.13.16", [structuredClone(systemLink)]);
  const client = await startClient(t, hub, stateDirectory);

  const prepared = await prepareGroup(client);
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(hub.state.links.get("34.13.16"), [systemLink]);
  assert.deepEqual(
    hub.state.accessories.map(({ id }) => id),
    [34, 35, 36],
  );
});

test("restore removes only its consumer from shared and pre-existing physical links", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const foreignConsumer = { aId: 80, sId: 1, cId: 2 };
  const systemLink = {
    type: "SYSTEM",
    index: "native-source/example",
    controller: "zigbee_1",
  };
  const sharedOut = {
    type: "OUT",
    index: "Virtual/34.16",
    characteristics: [foreignConsumer],
  };
  const emptyOut = {
    type: "OUT",
    index: "Virtual/34.15",
    characteristics: [],
  };
  hub.state.links.set("34.13.15", structuredClone([systemLink, emptyOut]));
  hub.state.links.set("34.13.16", structuredClone([sharedOut]));
  hub.state.behavior.preserveEmptyPhysicalOutOnIncomingRemove = true;
  const client = await startClient(t, hub, stateDirectory);

  const prepared = await prepareGroup(client);
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(
    restored.structuredContent.native_link_residues.map(
      ({ member_ref, characteristic_type, link }) => ({
        member_ref,
        characteristic_type,
        type: link.type,
        characteristics: link.characteristics,
      }),
    ),
    [
      {
        member_ref: memberServiceRefs[1],
        characteristic_type: "On",
        type: "OUT",
        characteristics: [],
      },
      {
        member_ref: memberServiceRefs[1],
        characteristic_type: "Brightness",
        type: "OUT",
        characteristics: [],
      },
    ],
  );
  assert.deepEqual(hub.state.links.get("34.13.15"), [systemLink, emptyOut]);
  assert.deepEqual(hub.state.links.get("34.13.16"), [sharedOut]);
  assert.equal(
    hub.state.accessories.some(({ id }) => id === 90),
    false,
  );
});

test("restore stops when its link removal drops a foreign consumer", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const foreignConsumer = { aId: 80, sId: 1, cId: 2 };
  hub.state.links.set("34.13.16", [
    {
      type: "OUT",
      index: "Virtual/34.16",
      characteristics: [foreignConsumer],
    },
  ]);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(client);
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  hub.state.behavior.dropForeignPhysicalConsumersOnIncomingRemove = true;
  hub.state.behavior.preserveEmptyPhysicalOutOnIncomingRemove = true;

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "uncertain");
  assert.equal(
    restored.structuredContent.conflict_reason,
    "foreign_link_changed_during_cleanup",
  );
  assert.deepEqual(
    restored.structuredContent.physical_link_preservation_failures,
    [
      {
        member_ref: memberServiceRefs[0],
        characteristic_type: "Brightness",
        missing_links: [
          {
            type: "OUT",
            index: "Virtual/34.16",
            characteristics: [foreignConsumer],
          },
        ],
      },
    ],
  );
  assert.ok(hub.state.accessories.some(({ id }) => id === 90));
  assert.equal(
    hub.requests.some(({ accessory }) => accessory?.delete),
    false,
  );
});

test("retry keeps proof that its completed removal preserved a later-removed foreign consumer", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const foreignConsumer = { aId: 80, sId: 1, cId: 1 };
  hub.state.links.set("34.13.15", [
    {
      type: "OUT",
      index: "Virtual/34.15",
      characteristics: [foreignConsumer],
    },
  ]);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(firstClient);
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");

  hub.state.behavior.failLinkRemoveOnAttempt = 2;
  const interrupted = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(interrupted.isError, true);
  assert.deepEqual(hub.state.links.get("34.13.15"), [
    {
      type: "OUT",
      index: "Virtual/34.15",
      characteristics: [foreignConsumer],
    },
  ]);
  await firstClient.close();

  hub.state.links.set("34.13.15", []);
  hub.state.behavior.failLinkRemoveOnAttempt = undefined;
  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.conflict_reason, undefined);
  assert.equal(
    hub.state.accessories.some(({ id }) => id === 90),
    false,
  );
});

test("get keeps completed removal proof after a lost delete readback and later foreign removal", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const foreignConsumer = { aId: 80, sId: 1, cId: 1 };
  hub.state.links.set("34.13.15", [
    {
      type: "OUT",
      index: "Virtual/34.15",
      characteristics: [foreignConsumer],
    },
  ]);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(firstClient);
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");

  hub.state.behavior.closeAfterAccessoryDelete = true;
  hub.state.behavior.closeAccessoryGetAfterDelete = true;
  const interrupted = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(interrupted.isError, true);
  assert.equal(
    hub.state.accessories.some(({ id }) => id === 90),
    false,
  );
  await firstClient.close();

  hub.state.links.set("34.13.15", []);
  const secondClient = await startClient(t, hub, stateDirectory);
  const inspected = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(inspected.isError, undefined, inspected.content[0]?.text);
  assert.equal(inspected.structuredContent.status, "restored");
  assert.equal(inspected.structuredContent.conflict_reason, undefined);

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
});

test("restore preserves a virtual group after a manual link was added", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(client);
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.links.get("90.1.1").push({
    index: "Manual/keep",
    type: "IN",
    characteristics: [{ aId: 36, sId: 15, cId: 20 }],
  });

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "conflict");
  assert.equal(restored.structuredContent.conflict_reason, "manual_change");
  assert.ok(hub.state.accessories.some(({ id }) => id === 90));
  assert.equal(
    hub.requests.some(({ accessory }) => accessory?.delete),
    false,
  );
});

test("a lost delete response is reconciled without deleting twice", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(client);
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.closeAfterAccessoryDelete = true;

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.native_acknowledged, false);
  assert.equal(
    restored.structuredContent.recovered_after_uncertain_write,
    true,
  );
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.delete).length,
    1,
  );

  const repeated = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "restored");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.delete).length,
    1,
  );
});

test("a lost link-remove response is reconciled without removing that link twice", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(client);
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.closeAfterNextLinkRemove = true;

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.native_acknowledged, false);
  assert.equal(
    restored.structuredContent.recovered_after_uncertain_write,
    true,
  );
  assert.equal(hub.requests.filter(({ link }) => link?.remove).length, 4);

  const repeated = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "restored");
  assert.equal(hub.requests.filter(({ link }) => link?.remove).length, 4);
});

test("restore finishes from sufficient current evidence after removal readback is lost", async (t) => {
  for (const scenario of [
    {
      name: "source readback lost with no foreign links",
      closeAt: 1,
      foreignConsumer: undefined,
      accessoryRemovedManually: false,
    },
    {
      name: "physical readback lost while the foreign link remains visible",
      closeAt: 2,
      foreignConsumer: { aId: 80, sId: 1, cId: 1 },
      accessoryRemovedManually: false,
    },
    {
      name: "the owned accessory and links were already removed manually",
      closeAt: 1,
      foreignConsumer: undefined,
      accessoryRemovedManually: true,
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const { hub, stateDirectory } = await setup(t);
      if (scenario.foreignConsumer) {
        hub.state.links.set("34.13.15", [
          {
            type: "OUT",
            index: "Virtual/34.15",
            characteristics: [scenario.foreignConsumer],
          },
        ]);
      }
      const firstClient = await startClient(t, hub, stateDirectory);
      const prepared = await prepareGroup(firstClient);
      const applied = await firstClient.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(applied.structuredContent.status, "applied");

      hub.state.behavior.closeLinkListAfterRemoveAt = scenario.closeAt;
      const interrupted = await firstClient.callTool({
        name: "restore_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(interrupted.isError, true);
      assert.equal(
        interrupted.structuredContent.error.code,
        "connection_closed",
      );
      await firstClient.close();

      if (scenario.accessoryRemovedManually) {
        hub.state.accessories = hub.state.accessories.filter(
          ({ id }) => id !== 90,
        );
        for (const [key, links] of hub.state.links) {
          if (key.startsWith("90.")) {
            hub.state.links.delete(key);
            continue;
          }
          hub.state.links.set(
            key,
            links.flatMap((link) => {
              const characteristics = (link.characteristics ?? []).filter(
                ({ aId }) => aId !== 90,
              );
              return link.type === "OUT" && characteristics.length === 0
                ? []
                : [{ ...link, characteristics }];
            }),
          );
        }
      }

      const secondClient = await startClient(t, hub, stateDirectory);
      const result = await secondClient.callTool({
        name: scenario.accessoryRemovedManually
          ? "get_native_change"
          : "restore_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(result.isError, undefined, result.content[0]?.text);
      assert.equal(result.structuredContent.status, "restored");
      assert.equal(result.structuredContent.conflict_reason, undefined);
      assert.equal(
        hub.state.accessories.some(({ id }) => id === 90),
        false,
      );
      assert.equal(
        [...hub.state.links.values()].some((links) =>
          links.some((link) =>
            link.characteristics?.some(({ aId }) => aId === 90),
          ),
        ),
        false,
      );
      if (scenario.foreignConsumer) {
        assert.deepEqual(
          hub.state.links.get("34.13.15")?.[0]?.characteristics,
          [scenario.foreignConsumer],
        );
      }
    });
  }
});

test("restore retries one uncertain removal only for the same owned link", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(firstClient);
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");

  hub.state.behavior.closeBeforeNextLinkRemove = true;
  const uncertain = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(
    uncertain.structuredContent.conflict_reason,
    "link_remove_outcome_unknown",
  );
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(hub.requests.filter(({ link }) => link?.remove).length, 5);
  assert.equal(
    hub.state.accessories.some(({ id }) => id === 90),
    false,
  );
});

test("a retry starts fresh after a foreign consumer changed before its remove attempt", async (t) => {
  for (const inspectAfterManualAccessoryRemoval of [false, true]) {
    await t.test(
      inspectAfterManualAccessoryRemoval
        ? "later manual accessory removal does not preserve stale evidence"
        : "the retry uses current physical links as its before evidence",
      async (t) => {
        const { hub, stateDirectory } = await setup(t);
        const foreignConsumer = { aId: 80, sId: 1, cId: 1 };
        hub.state.links.set("34.13.15", [
          {
            type: "OUT",
            index: "Virtual/34.15",
            characteristics: [foreignConsumer],
          },
        ]);
        const firstClient = await startClient(t, hub, stateDirectory);
        const prepared = await prepareGroup(firstClient);
        const applied = await firstClient.callTool({
          name: "apply_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });
        assert.equal(applied.structuredContent.status, "applied");

        hub.state.behavior.closeBeforeNextLinkRemove = true;
        const uncertain = await firstClient.callTool({
          name: "restore_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });
        assert.equal(uncertain.structuredContent.status, "uncertain");
        await firstClient.close();

        hub.state.links.get("34.13.15")[0].characteristics = hub.state.links
          .get("34.13.15")[0]
          .characteristics.filter(({ aId }) => aId !== 80);
        const secondClient = await startClient(t, hub, stateDirectory);
        const retried = await secondClient.callTool({
          name: "restore_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });

        if (inspectAfterManualAccessoryRemoval) {
          hub.state.accessories = hub.state.accessories.filter(
            ({ id }) => id !== 90,
          );
          for (const [key, links] of hub.state.links) {
            if (key.startsWith("90.")) {
              hub.state.links.delete(key);
              continue;
            }
            hub.state.links.set(
              key,
              links.flatMap((link) => {
                const characteristics = (link.characteristics ?? []).filter(
                  ({ aId }) => aId !== 90,
                );
                return link.type === "OUT" && characteristics.length === 0
                  ? []
                  : [{ ...link, characteristics }];
              }),
            );
          }
          const inspected = await secondClient.callTool({
            name: "get_native_change",
            arguments: { change_ref: prepared.structuredContent.change_ref },
          });
          assert.equal(inspected.structuredContent.status, "restored");
          assert.equal(inspected.structuredContent.conflict_reason, undefined);
        } else {
          assert.equal(retried.isError, undefined, retried.content[0]?.text);
          assert.equal(retried.structuredContent.status, "restored");
          assert.equal(retried.structuredContent.conflict_reason, undefined);
        }
        assert.equal(
          hub.state.accessories.some(({ id }) => id === 90),
          false,
        );
      },
    );
  }
});

test("a rejected uncertain retry can be attempted again on the next restore", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(firstClient);
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");

  hub.state.behavior.closeBeforeNextLinkRemove = true;
  const uncertain = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(hub.requests.filter(({ link }) => link?.remove).length, 1);
  await firstClient.close();

  hub.state.behavior.failLinkRemoveOnAttempt = 2;
  const secondClient = await startClient(t, hub, stateDirectory);
  const rejected = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, "request_rejected");
  assert.equal(hub.requests.filter(({ link }) => link?.remove).length, 2);
  await secondClient.close();

  hub.state.behavior.failLinkRemoveOnAttempt = undefined;
  const thirdClient = await startClient(t, hub, stateDirectory);
  const restored = await thirdClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(hub.requests.filter(({ link }) => link?.remove).length, 6);
});

test("two interrupted sends on one owned link allow a later restore", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(firstClient);
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");

  for (const expectedRemoveRequests of [1, 2]) {
    hub.state.behavior.closeBeforeNextLinkRemove = true;
    const client =
      expectedRemoveRequests === 1
        ? firstClient
        : await startClient(t, hub, stateDirectory);
    const uncertain = await client.callTool({
      name: "restore_native_change",
      arguments: { change_ref: prepared.structuredContent.change_ref },
    });
    assert.equal(uncertain.structuredContent.status, "uncertain");
    assert.equal(
      uncertain.structuredContent.conflict_reason,
      "link_remove_outcome_unknown",
    );
    assert.equal(
      hub.requests.filter(({ link }) => link?.remove).length,
      expectedRemoveRequests,
    );
    await client.close();
  }

  const thirdClient = await startClient(t, hub, stateDirectory);
  const restored = await thirdClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(hub.requests.filter(({ link }) => link?.remove).length, 6);
});

test("restore does not retry an uncertain removal after the link identity changed", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(firstClient);
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.closeBeforeNextLinkRemove = true;
  const uncertain = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  await firstClient.close();

  hub.state.links.get("90.1.1")[0].index = "Manual/replacement";
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(
    repeated.structuredContent.conflict_reason,
    "link_remove_outcome_unknown",
  );
  assert.equal(hub.requests.filter(({ link }) => link?.remove).length, 1);
  assert.ok(hub.state.accessories.some(({ id }) => id === 90));
});

test("restore keeps the virtual accessory when native IN removal leaves physical OUT residue", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(client);
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.preservePhysicalOutOnIncomingRemove = true;

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "uncertain");
  assert.equal(
    restored.structuredContent.conflict_reason,
    "link_cleanup_incomplete",
  );
  assert.equal(restored.structuredContent.physical_link_residues.length, 4);
  assert.equal(
    hub.requests.some(({ accessory }) => accessory?.delete),
    false,
  );
  assert.ok(hub.state.accessories.some(({ id }) => id === 90));

  const inspected = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(inspected.structuredContent.status, "uncertain");
  assert.equal(
    inspected.structuredContent.conflict_reason,
    "link_cleanup_incomplete",
  );
});

test("a repeated group command reports a member that did not receive the native write", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const preparedGroup = await prepareGroup(client);
  const appliedGroup = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: preparedGroup.structuredContent.change_ref },
  });
  const brightnessRef = appliedGroup.structuredContent.characteristics.find(
    ({ type }) => type === "Brightness",
  ).ref;
  findCharacteristic(hub.state, { aId: 34, sId: 13, cId: 16 }).control.value = {
    intValue: 10,
  };
  findCharacteristic(hub.state, { aId: 90, sId: 1, cId: 2 }).control.value = {
    intValue: 10,
  };

  const preparedCommand = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: brightnessRef,
      value: 10,
      reason: "Повторить яркость всей группы",
    },
  });
  const appliedCommand = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: preparedCommand.structuredContent.change_ref },
  });

  assert.equal(appliedCommand.structuredContent.status, "uncertain");
  assert.equal(
    appliedCommand.structuredContent.conflict_reason,
    "group_members_not_converged",
  );
  assert.equal(
    appliedCommand.structuredContent.group_delivery_confirmed,
    false,
  );
  assert.deepEqual(
    appliedCommand.structuredContent.group_member_observations.map(
      ({ member_ref, value }) => ({ member_ref, value: value.value }),
    ),
    [
      { member_ref: memberServiceRefs[0], value: 10 },
      { member_ref: memberServiceRefs[1], value: 70 },
    ],
  );

  const preparedDifferentCommand = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: brightnessRef,
      value: 20,
      reason: "Задать новое значение яркости всей группе",
    },
  });
  const appliedDifferentCommand = await client.callTool({
    name: "apply_native_change",
    arguments: {
      change_ref: preparedDifferentCommand.structuredContent.change_ref,
    },
  });
  assert.equal(appliedDifferentCommand.structuredContent.status, "applied");
  assert.equal(
    appliedDifferentCommand.structuredContent.group_delivery_confirmed,
    true,
  );
  assert.deepEqual(
    [
      findCharacteristic(hub.state, { aId: 34, sId: 13, cId: 16 }),
      findCharacteristic(hub.state, { aId: 35, sId: 14, cId: 21 }),
    ].map(({ control }) => control.value),
    [{ intValue: 20 }, { intValue: 20 }],
  );
});

test("a lost accessory-create response is never retried or claimed", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(firstClient);
  hub.state.behavior.closeAfterAccessoryCreate = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "uncertain");
  assert.equal(
    applied.structuredContent.virtual_accessory_creation_owned,
    false,
  );
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.create).length,
    1,
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.create).length,
    1,
  );

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "not_owned");
  assert.ok(hub.state.accessories.some(({ id }) => id === 90));
});

test("an acknowledged normalized accessory name keeps ownership and reports both names", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const requestedName = "Очень длинное имя общего света 123456789";
  const prepared = await prepareGroup(client, { name: requestedName });
  hub.state.behavior.normalizeNextAccessoryName = true;

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(
    applied.structuredContent.virtual_accessory_creation_owned,
    true,
  );
  assert.equal(applied.structuredContent.requested_name, requestedName);
  assert.equal(
    applied.structuredContent.observed_name,
    requestedName.slice(0, 30),
  );
  assert.equal(applied.structuredContent.name_normalized, true);
});

test("a lost link response is read back and completed without adding that link twice", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(firstClient);
  hub.state.behavior.closeAfterNextLinkAdd = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, false);
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);
  assert.equal(hub.requests.filter(({ link }) => link?.addVirtual).length, 4);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(({ link }) => link?.addVirtual).length, 4);
});

test("restore reconstructs a link whose acknowledged add lost its readback", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(firstClient);
  hub.state.behavior.closeAfterNextLinkAddReadback = true;
  hub.state.behavior.preserveEmptyPhysicalOutOnIncomingRemove = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, true);
  assert.equal(applied.structuredContent.error.code, "connection_closed");
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const inspected = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(inspected.structuredContent.status, "uncertain");
  assert.equal(
    inspected.structuredContent.verification.result,
    "owned_partial_group_observed",
  );

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(
    hub.requests
      .filter(({ link }) => link?.remove)
      .map(({ link }) => link.remove),
    [{ aId: 90, sId: 1, cId: 1, linkId: "Virtual/34.15" }],
  );
  assert.equal(
    hub.requests.findIndex(({ link }) => link?.remove) <
      hub.requests.findIndex(({ accessory }) => accessory?.delete),
    true,
    "the observed IN must be removed before its virtual accessory",
  );
  assert.deepEqual(
    restored.structuredContent.native_link_residues.map(
      ({ member_ref, characteristic_type, link }) => ({
        member_ref,
        characteristic_type,
        type: link.type,
        characteristics: link.characteristics,
      }),
    ),
    [
      {
        member_ref: memberServiceRefs[0],
        characteristic_type: "On",
        type: "OUT",
        characteristics: [],
      },
    ],
  );
  assert.equal(
    [...hub.state.links.values()].some((links) =>
      links.some((link) => link.characteristics?.some(({ aId }) => aId === 90)),
    ),
    false,
  );
});

test("restoring one owned group does not block restoring another shared group", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const first = await prepareGroup(client, { name: "Первый общий свет" });
  const firstApplied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  assert.equal(firstApplied.structuredContent.status, "applied");
  const second = await prepareGroup(client, { name: "Второй общий свет" });
  const secondApplied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: second.structuredContent.change_ref },
  });
  assert.equal(secondApplied.structuredContent.status, "applied");

  const firstRestored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  assert.equal(firstRestored.structuredContent.status, "restored");
  const secondRestores = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    secondRestores.push(
      await client.callTool({
        name: "restore_native_change",
        arguments: { change_ref: second.structuredContent.change_ref },
      }),
    );
  }
  assert.deepEqual(
    secondRestores.map(({ structuredContent }) => structuredContent.status),
    ["restored", "restored", "restored"],
  );
  assert.deepEqual(
    hub.state.accessories.map(({ id }) => id),
    [34, 35, 36],
  );
  assert.equal(
    [...hub.state.links.values()].some((links) =>
      links.some((link) =>
        link.characteristics?.some(({ aId }) => aId === 90 || aId === 91),
      ),
    ),
    false,
  );
});

test("the group rejects a capability that is absent from one member", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  const prepared = await prepareGroup(client, {
    characteristic_types: ["On", "Brightness", "ColorTemperature"],
  });
  assert.equal(prepared.isError, true);
  assert.equal(
    prepared.structuredContent.error.code,
    "unsupported_group_characteristics",
  );
  assert.equal(hub.requests.some(isGroupWrite), false);
});

test("a matching pre-existing virtual light is a conflict, not owned or duplicated", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.accessories.push(
    createVirtualAccessory(80, {
      name: "Общий свет",
      roomId: 1,
      services: [
        { name: "Общий свет", type: "Lightbulb", optional: ["Brightness"] },
      ],
    }),
  );
  const client = await startClient(t, hub, stateDirectory);

  const prepared = await prepareGroup(client);
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "conflict");
  assert.equal(
    prepared.structuredContent.conflict_reason,
    "matching_virtual_accessory_exists",
  );
  assert.equal(prepared.structuredContent.owned_change_created, false);
  assert.equal(hub.requests.some(isGroupWrite), false);
});

test("apply revalidates member bindings before creating the group", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(client);
  const dasha = hub.state.accessories.find(({ id }) => id === 35);
  dasha.services[0].characteristics = dasha.services[0].characteristics.filter(
    ({ control }) => control.type !== "Brightness",
  );

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, true);
  assert.equal(
    applied.structuredContent.error.code,
    "unsupported_group_characteristics",
  );
  assert.equal(hub.requests.some(isGroupWrite), false);
});

function isGroupWrite({ accessory, link, characteristic }) {
  return Boolean(
    accessory?.create ||
      accessory?.delete ||
      link?.addVirtual ||
      link?.remove ||
      characteristic?.update,
  );
}
