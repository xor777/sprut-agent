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

// SprutHub encodes its replies as proto3 JSON, which leaves out a repeated
// field that is empty. On a live hub an existing room without devices
// answered accessory.list{roomId} with a list object and no accessories
// (research/protocol/2026-09-24-live-conformance.md); extensionChild.list,
// logic.getOptions and scenario.list{aId} did the same earlier. This hub
// drops every empty array from its replies the same way.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serial = "empty-lists-hub";
const homeRef = `spruthub://hub/${serial}`;
const livingRoomRef = `${homeRef}/room/1`;
const storeRoomRef = `${homeRef}/room/2`;
const sensorRef = `${homeRef}/accessory/10/service/13/characteristic/14`;
const lampServiceRef = `${homeRef}/accessory/11/service/13`;
const lampRef = `${lampServiceRef}/characteristic/14`;

function furnishedHome() {
  return {
    rooms: [
      { id: 1, order: 1, name: "Гостиная", visible: true },
      { id: 2, order: 2, name: "Кладовая", visible: true },
    ],
    accessories: [
      device(10, "Датчик движения", "MotionSensor", {
        name: "Движение",
        type: "MotionDetected",
        read: true,
        write: false,
        events: true,
        value: { boolValue: false },
      }),
      device(11, "Лампа", "Lightbulb", {
        name: "Включено",
        type: "On",
        read: true,
        write: true,
        events: true,
        value: { boolValue: false },
      }),
    ],
  };
}

function device(id, name, serviceType, control) {
  return {
    id,
    roomId: 1,
    name,
    online: true,
    services: [
      {
        aId: id,
        sId: 13,
        name,
        type: serviceType,
        characteristics: [{ aId: id, sId: 13, cId: 14, control }],
      },
    ],
  };
}

function withoutEmptyArrays(value) {
  if (Array.isArray(value)) return value.map(withoutEmptyArrays);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => !(Array.isArray(item) && item.length === 0))
      .map(([key, item]) => [key, withoutEmptyArrays(item)]),
  );
}

class NativeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const handlers = {
  "hub.list": () => ({
    hubs: [{ serial, name: "Пустые списки", online: true }],
  }),
  "room.list": (state) => ({ rooms: state.rooms }),
  "room.get": (state, { id }) => {
    const room = state.rooms.find((candidate) => candidate.id === id);
    // A live hub answers a missing scenario and logic this way.
    if (!room) throw new NativeError(-32603, "Not found");
    return room;
  },
  "room.create": (state, { name }) => {
    const room = {
      id: Math.max(0, ...state.rooms.map(({ id }) => id)) + 1,
      name,
      order: state.rooms.length + 1,
      visible: true,
    };
    state.rooms.push(room);
    return room;
  },
  "room.delete": (state, { id }) => {
    state.rooms = state.rooms.filter((room) => room.id !== id);
    return {};
  },
  "accessory.list": (state, { roomId }) => ({
    accessories: state.accessories.filter(
      (accessory) => roomId === undefined || accessory.roomId === roomId,
    ),
  }),
  "accessory.get": (state, { id }) =>
    state.accessories.find((accessory) => accessory.id === id) ?? null,
  "scenario.list": () => ({ scenarios: [] }),
  "extension.list": () => ({ extensions: [] }),
  "logic.list": () => ({ logics: [] }),
  "logic.types": () => ({ logicTypes: [] }),
  "link.list": () => ({ links: [] }),
  "characteristic.getOptions": () => ({ options: [] }),
};

async function startHub(t, initialState) {
  const state = structuredClone(initialState);
  const exchanges = [];
  // (method, params) => a result sent verbatim instead of the handler's.
  let override = () => undefined;
  const server = new WebSocketServer({ host: FAKE_HUB_HOST, port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      const [domain] = Object.keys(request.params);
      const [operation] = Object.keys(request.params[domain]);
      const method = `${domain}.${operation}`;
      const params = request.params[domain][operation];
      let reply;
      try {
        const raw = override(method, params);
        if (raw !== undefined) {
          reply = { id: request.id, result: raw };
        } else {
          const handler = handlers[method];
          if (!handler) throw new NativeError(-32601, `Unsupported ${method}`);
          reply = {
            id: request.id,
            result: withoutEmptyArrays({
              [domain]: { [operation]: handler(state, params) },
            }),
          };
        }
      } catch (error) {
        if (!(error instanceof NativeError)) throw error;
        reply = {
          id: request.id,
          error: { code: error.code, message: error.message },
        };
      }
      exchanges.push({ method, params, reply });
      socket.send(JSON.stringify(reply));
    });
  });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    state,
    exchanges,
    url: `ws://127.0.0.1:${server.address().port}`,
    override(next) {
      override = next;
    },
    sent(method) {
      return exchanges.filter((exchange) => exchange.method === method);
    },
  };
}

async function startClient(t, hub) {
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-empty-lists-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "empty-lists-test-token",
      SPRUTHUB_SERIAL: serial,
      SPRUTHUB_CID: "empty-lists-test-client",
      SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "empty-lists-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

async function callError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, result.content[0]?.text);
  return result.structuredContent.error;
}

function previewArguments() {
  return {
    name: "Движение включает лампу",
    reason: "Включать лампу при движении",
    source_room_ref: livingRoomRef,
    source_characteristic_ref: sensorRef,
    source_value: true,
    target_room_ref: livingRoomRef,
    target_characteristic_ref: lampRef,
    target_value: true,
  };
}

test("a room without devices reads as an empty room", async (t) => {
  const hub = await startHub(t, furnishedHome());
  const client = await startClient(t, hub);

  const room = await call(client, "get_entity", { entity_ref: storeRoomRef });
  assert.deepEqual(
    pickFields(room.entity, ["kind", "ref", "name", "accessories"]),
    { kind: "room", ref: storeRoomRef, name: "Кладовая", accessories: [] },
  );

  const services = await call(client, "read_services", {
    home_ref: homeRef,
    room_ref: storeRoomRef,
  });
  assert.deepEqual(services.scope.room, {
    ref: storeRoomRef,
    name: "Кладовая",
  });
  assert.deepEqual(services.services, []);
  assert.equal(services.scope_status, "empty");

  // The hub really left the list field out, as the live hub did.
  const roomLists = hub
    .sent("accessory.list")
    .filter(({ params }) => params.roomId === 2);
  assert.equal(roomLists.length, 2);
  for (const { reply } of roomLists) {
    assert.deepEqual(reply.result, { accessory: { list: {} } });
  }
});

test("a room the agent created and left empty is removed by restore", async (t) => {
  const hub = await startHub(t, furnishedHome());
  const client = await startClient(t, hub);

  const prepared = await call(client, "prepare_native_change", {
    operation: "room_create",
    target_ref: homeRef,
    name: "Мастерская",
    reason: "Создать комнату для паяльной станции",
  });
  assert.equal(prepared.status, "prepared");
  const created = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(created.status, "applied");
  assert.equal(created.room_creation_owned, true);
  const createdRoomId = Number(created.room.ref.split("/").at(-1));
  assert.equal(
    hub.state.rooms.some(({ id }) => id === createdRoomId),
    true,
  );

  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(
    hub.state.rooms.some(({ id }) => id === createdRoomId),
    false,
  );
  assert.deepEqual(
    hub.sent("room.delete").map(({ params }) => params),
    [{ id: createdRoomId }],
  );
  assert.deepEqual(
    hub.state.rooms.map(({ name }) => name),
    ["Гостиная", "Кладовая"],
  );
});

test("a home with nothing set up yet reads as empty", async (t) => {
  const hub = await startHub(t, { rooms: [], accessories: [] });
  const client = await startClient(t, hub);

  const rooms = await call(client, "list_rooms", {});
  assert.deepEqual(rooms.rooms, []);

  const home = await call(client, "inspect_home", { home_ref: homeRef });
  assert.deepEqual(home.entities, {
    rooms: [],
    scenarios: [],
    extensions: [],
  });

  const services = await call(client, "read_services", {
    home_ref: homeRef,
  });
  assert.deepEqual(services.services, []);
  assert.equal(services.scope_status, "empty");
  assert.deepEqual(hub.sent("room.list")[0].reply.result, {
    room: { list: {} },
  });
});

test("a device without scenarios, logic, links or options reads as checked empty", async (t) => {
  const hub = await startHub(t, furnishedHome());
  const client = await startClient(t, hub);

  const lamp = await call(client, "get_entity", {
    entity_ref: lampRef,
    include: ["relations", "options"],
  });
  // A read options array, empty or not, is the checked scope.
  assert.deepEqual(lamp.entity.options, []);
  assert.deepEqual(lamp.entity.relations.checked, {
    scenario_accessory_index: "checked_empty",
    block_scenarios_read: 0,
    logic_assignments: "checked_empty",
    characteristic_links: "checked_empty",
  });
  assert.deepEqual(lamp.entity.relations.unchecked, []);
  assert.deepEqual(lamp.entity.relations.scenario_roles, []);
  assert.deepEqual(lamp.entity.relations.assigned_logics, []);
  assert.deepEqual(lamp.entity.relations.characteristic_links, []);

  const service = await call(client, "get_entity", {
    entity_ref: lampServiceRef,
  });
  assert.deepEqual(service.entity.assigned_logics, []);
  assert.deepEqual(service.entity.available_logic_types, []);
});

test("the first automation of a home without scenarios is previewed", async (t) => {
  const hub = await startHub(t, furnishedHome());
  const client = await startClient(t, hub);

  const preview = await call(
    client,
    "preview_boolean_automation",
    previewArguments(),
  );
  assert.equal(preview.status, "prepared");
  assert.deepEqual(preview.existing_rules, []);
  for (const side of ["source", "target"]) {
    assert.deepEqual(preview.context[side], {
      scenario_associations: [],
      assigned_logics: [],
      links: [],
    });
  }
});

test("a list reply without its list object or with a non-array list is not an empty list", async (t) => {
  const hub = await startHub(t, furnishedHome());
  const client = await startClient(t, hub);

  for (const broken of [
    { accessory: {} },
    { accessory: { list: null } },
    { accessory: { list: { accessories: null } } },
    { accessory: { list: { accessories: {} } } },
    {},
  ]) {
    hub.override((method) =>
      method === "accessory.list" ? broken : undefined,
    );
    const error = await callError(client, "get_entity", {
      entity_ref: storeRoomRef,
    });
    assert.equal(error.code, "incompatible_response", JSON.stringify(broken));
  }

  // A preview must not report "no scenarios, logic or links tied to the
  // pair" when those lists were not read. The home-wide scenario catalog
  // stays readable so that only the pair's list is broken.
  for (const [method, broken] of [
    ["scenario.list", { scenario: {} }],
    ["scenario.list", { scenario: { list: { scenarios: null } } }],
    ["logic.list", { logic: {} }],
    ["link.list", {}],
  ]) {
    hub.override((candidate, params) => {
      if (candidate === "scenario.list" && params.aId === undefined) {
        return { scenario: { list: { scenarios: [] } } };
      }
      return candidate === method ? broken : undefined;
    });
    const error = await callError(
      client,
      "preview_boolean_automation",
      previewArguments(),
    );
    assert.equal(error.code, "incompatible_response", method);
  }

  hub.override((method) =>
    method === "room.list" ? { room: { list: { rooms: null } } } : undefined,
  );
  assert.equal(
    (await callError(client, "list_rooms", {})).code,
    "incompatible_response",
  );
});

test("a created room is not deleted when its contents were not read", async (t) => {
  const hub = await startHub(t, furnishedHome());
  const client = await startClient(t, hub);
  const prepared = await call(client, "prepare_native_change", {
    operation: "room_create",
    target_ref: homeRef,
    name: "Мастерская",
    reason: "Создать комнату для паяльной станции",
  });
  const created = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(created.status, "applied");

  hub.override((method) =>
    method === "accessory.list" ? { accessory: {} } : undefined,
  );
  const refused = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.change_ref },
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /incompatible_response/);
  assert.deepEqual(hub.sent("room.delete"), []);
  assert.equal(
    hub.state.rooms.some(({ name }) => name === "Мастерская"),
    true,
  );
});

function pickFields(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}
