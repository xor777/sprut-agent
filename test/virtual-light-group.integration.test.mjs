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
    links: new Map(),
    nextAccessoryId: 90,
    behavior: {
      closeAfterAccessoryCreate: false,
      closeAfterNextLinkAdd: false,
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
      } else if (params.service?.types) {
        result = {
          service: {
            types: {
              types: [
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
            },
          },
        };
      } else if (params.accessory?.create) {
        const created = createVirtualAccessory(
          state.nextAccessoryId++,
          params.accessory.create,
        );
        state.accessories.push(created);
        if (state.behavior.closeAfterAccessoryCreate) {
          state.behavior.closeAfterAccessoryCreate = false;
          socket.close();
          return;
        }
        result = { accessory: { create: structuredClone(created) } };
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
        result = { accessory: { delete: {} } };
      } else if (params.link?.list) {
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
        let incoming = links.find(({ type }) => type === "IN");
        if (!incoming) {
          incoming = {
            index: `Virtual/${input.aId}.${input.cId}`,
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
        }
        if (state.behavior.closeAfterNextLinkAdd) {
          state.behavior.closeAfterNextLinkAdd = false;
          socket.close();
          return;
        }
        result = { link: { addVirtual: structuredClone(incoming) } };
      } else if (params.link?.remove) {
        const key = linkKey(params.link.remove);
        state.links.set(
          key,
          (state.links.get(key) ?? []).filter(
            ({ index }) => index !== params.link.remove.linkId,
          ),
        );
        result = { link: { remove: {} } };
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
      SPRUTHUB_TIMEOUT_MS: "500",
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
      { aId: 90, sId: 1, cId: 1, hasLinks: true, linkProcessing: 0 },
      { aId: 90, sId: 1, cId: 2, hasLinks: true, linkProcessing: 0 },
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
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(client);
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  const restored = await client.callTool({
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
    hub.state.accessories.map(({ id }) => id),
    [34, 35, 36],
  );
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

test("a lost link response is reconciled without adding that link twice", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await prepareGroup(firstClient);
  hub.state.behavior.closeAfterNextLinkAdd = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "uncertain");
  assert.equal(hub.requests.filter(({ link }) => link?.addVirtual).length, 1);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(hub.requests.filter(({ link }) => link?.addVirtual).length, 1);
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

function isGroupWrite({ accessory, link, characteristic }) {
  return Boolean(
    accessory?.create ||
      accessory?.delete ||
      link?.addVirtual ||
      link?.remove ||
      characteristic?.update,
  );
}
