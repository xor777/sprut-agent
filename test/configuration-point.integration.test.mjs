import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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

const serial = "config-point-hub";
const otherSerial = "other-home";
const homeRef = `spruthub://hub/${serial}`;
const otherHomeRef = `spruthub://hub/${otherSerial}`;
const roomRef = `${homeRef}/room/1`;
const workshopRoomRef = `${homeRef}/room/2`;
const accessoryRef = `${homeRef}/accessory/34`;
const missingAccessoryRef = `${homeRef}/accessory/99`;
const serviceRef = `${homeRef}/accessory/34/service/13`;
const characteristicRef = `${serviceRef}/characteristic/15`;
const logicType = "SmoothBrightnessChange";
const logicRef = `${serviceRef}/logic/${logicType}`;
const scenarioRef = `${homeRef}/scenario/office-light`;
const deviceWindowKey = "Controller/zigbee_demo/Child/DEVICE_A/";
const deviceWindowRef = `${homeRef}/window/${encodeURIComponent(deviceWindowKey)}`;
const homeWindowRef = `${homeRef}/window/`;
const startupOptionKey = "/11/0006_OnOff/4003_StartUpOnOff/255";
const wifiSecret = "wifi-secret-must-not-leak";
const windowPasswordSecret = "window-password-must-not-leak";
const replacementWindowPasswordSecret = "new-window-password-must-not-leak";
const accessTokenSecret = "token-secret-must-not-leak";
const replacementTokenSecret = "other-token-must-not-leak";
const thenDelayPath = ["configuration", "value", "targets", 0, "then_delay"];

function officeBlockData({ delay = 0, blockId = 7, targetCount = 1 } = {}) {
  return {
    blockId,
    targets: Array.from({ length: targetCount }, (_, index) => ({
      type: "if",
      blockId: index + 1,
      mode: "EVERY",
      if: {
        type: "condition",
        blockId: 1000 + index,
        mode: "AND",
        state: "runtime-projection",
        conditions: [],
      },
      // biome-ignore lint/suspicious/noThenProperty: SprutHub BLOCK scenarios use this native key.
      then: [],
      else: [],
      then_delay: index === 0 ? delay : 0,
      else_delay: 0,
    })),
  };
}

function smoothLogicOptions(duration = 900) {
  return [
    {
      key: "Primary",
      name: "Плавное изменение яркости",
      type: "Group",
      inputType: "GROUP",
      read: true,
      write: false,
      disabled: false,
    },
    {
      key: "Duration",
      name: "Продолжительность",
      type: "GenericInteger",
      inputType: "NUMBER",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: duration },
    },
    {
      key: "AccessToken",
      name: "Access token",
      type: "GenericString",
      inputType: "LIST",
      read: true,
      write: true,
      disabled: false,
      value: { stringValue: accessTokenSecret },
      validValues: [
        { name: "Current", value: { stringValue: accessTokenSecret } },
        { name: "Replacement", value: { stringValue: replacementTokenSecret } },
      ],
    },
  ];
}

function deviceWindowOptions(startupValue = 255) {
  return [
    {
      key: startupOptionKey,
      name: "После восстановления питания",
      type: "GenericInteger",
      inputType: "LIST",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: startupValue },
      validValues: [
        { name: "Выключена", value: { intValue: 0 } },
        { name: "Включена", value: { intValue: 1 } },
        { name: "Предыдущее состояние", value: { intValue: 255 } },
      ],
    },
    {
      key: "DevicePassword",
      name: "Пароль устройства",
      type: "GenericString",
      inputType: "PASSWORD",
      read: true,
      write: true,
      disabled: false,
      value: { stringValue: windowPasswordSecret },
    },
    {
      key: "Reboot",
      name: "Перезагрузить",
      type: "GenericBoolean",
      inputType: "BUTTON",
      read: false,
      write: true,
      disabled: false,
      value: { boolValue: false },
    },
  ];
}

function createState() {
  return {
    rooms: [
      { id: 1, name: "Офис" },
      { id: 2, name: "Мастерская" },
    ],
    accessories: [
      {
        id: 34,
        roomId: 1,
        name: "Лампа офиса",
        online: true,
        extensionKey: "zigbee",
        deviceId: "device-a",
        deviceWindow: deviceWindowKey,
        services: [
          {
            aId: 34,
            sId: 13,
            name: "Свет",
            type: "Lightbulb",
            characteristics: [
              {
                aId: 34,
                sId: 13,
                cId: 15,
                hasOptions: false,
                control: {
                  name: "On",
                  type: "On",
                  read: true,
                  write: true,
                  events: true,
                  value: { boolValue: false },
                },
              },
              {
                aId: 34,
                sId: 13,
                cId: 16,
                hasOptions: false,
                control: {
                  name: "WiFiPassword",
                  type: "GenericString",
                  read: true,
                  write: false,
                  events: false,
                  value: { stringValue: wifiSecret },
                },
              },
            ],
          },
        ],
      },
    ],
    scenarios: [
      {
        index: "office-light",
        name: "Свет в офисе",
        desc: "Вечерний свет",
        type: "BLOCK",
        predefined: false,
        active: true,
        onStart: false,
        sync: false,
        rooms: [1],
        iconsIf: ["light"],
        iconsThen: ["bulb"],
        error: false,
        order: 4,
        optionsWindow: "opaque-scenario-window",
        data: JSON.stringify(officeBlockData()),
      },
    ],
    logics: [
      {
        aId: 34,
        sId: 13,
        type: logicType,
        name: "Плавное изменение яркости",
        active: true,
        optionsWindow: "logic-window",
      },
    ],
    logicTypes: [
      {
        type: logicType,
        name: "Плавное изменение яркости",
        desc: "Плавно меняет яркость",
      },
    ],
    logicOptions: smoothLogicOptions(),
    windows: {
      [deviceWindowKey]: {
        windowKey: deviceWindowKey,
        label: { text: "Настройки лампы" },
        options: deviceWindowOptions(),
      },
      "opaque-scenario-window": {
        windowKey: "opaque-scenario-window",
        label: { text: "Свет в офисе" },
        options: [
          {
            key: "Name",
            name: "Name",
            type: "GenericString",
            inputType: "TEXT",
            read: true,
            write: true,
            value: { stringValue: "Свет в офисе" },
          },
        ],
      },
      "": {
        windowKey: "",
        label: { text: "Настройки хаба" },
        options: [
          {
            key: "Time",
            name: "Time",
            type: "GenericString",
            inputType: "STATUS",
            read: true,
            write: false,
            value: { stringValue: "2026-09-16 - 12:00:00 (GMT+00:00)" },
          },
        ],
      },
    },
    behavior: {
      failNextWindowGet: false,
      failLogicGet: false,
    },
  };
}

async function startHub() {
  const state = createState();
  const requests = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      const params = request.params ?? {};
      if (state.behavior.failNextWindowGet && params.window?.get) {
        state.behavior.failNextWindowGet = false;
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32000, message: "window get failed" },
          }),
        );
        return;
      }
      if (state.behavior.failLogicGet && params.logic?.get) {
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32000, message: "logic get failed" },
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({ id: request.id, result: respond(state, request) }),
      );
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    state,
    requests,
    server,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

function respond(state, request) {
  const params = request.params;
  if (params.hub?.list) {
    return {
      hub: {
        list: {
          hubs: [
            {
              serial,
              name: "Офис",
              online: true,
              owner: "owner@example.invalid",
              model: "Sprut.hub 2",
              version: { current: { version: "3.0.0b", revision: "20131" } },
            },
            {
              serial: otherSerial,
              name: "Другой дом",
              online: true,
              owner: "other@example.invalid",
              model: "Sprut.hub 2",
              version: { current: { version: "3.0.0b", revision: "20131" } },
            },
          ],
        },
      },
    };
  }
  if (params.room?.list) return { room: { list: { rooms: state.rooms } } };
  if (params.room?.get) {
    return {
      room: {
        get: state.rooms.find(({ id }) => id === params.room.get.id) ?? null,
      },
    };
  }
  if (params.accessory?.list) {
    return {
      accessory: {
        list: {
          accessories: state.accessories.filter(
            ({ roomId }) =>
              params.accessory.list.roomId === undefined ||
              roomId === params.accessory.list.roomId,
          ),
        },
      },
    };
  }
  if (params.accessory?.get) {
    return {
      accessory: {
        get:
          state.accessories.find(({ id }) => id === params.accessory.get.id) ??
          null,
      },
    };
  }
  if (params.scenario?.list) {
    return { scenario: { list: { scenarios: state.scenarios } } };
  }
  if (params.scenario?.get) {
    return {
      scenario: {
        get:
          state.scenarios.find(
            ({ index }) => index === params.scenario.get.index,
          ) ?? null,
      },
    };
  }
  if (params.logic?.types) {
    return { logic: { types: { logicTypes: state.logicTypes } } };
  }
  if (params.logic?.list) {
    return {
      logic: {
        list: {
          logics: state.logics.filter(
            ({ aId, sId }) =>
              aId === params.logic.list.aId && sId === params.logic.list.sId,
          ),
        },
      },
    };
  }
  if (params.logic?.get) {
    const logic = state.logics.find(
      ({ aId, sId, type }) =>
        aId === params.logic.get.aId &&
        sId === params.logic.get.sId &&
        type === params.logic.get.type,
    );
    return { logic: { get: structuredClone(logic) ?? null } };
  }
  if (params.logic?.getOptions) {
    return { logic: { getOptions: { options: state.logicOptions } } };
  }
  if (params.window?.get) {
    const window = state.windows[params.window.get.windowKey];
    return { window: { get: structuredClone(window) ?? null } };
  }
  if (params.link?.list) return { link: { list: { links: [] } } };
  throw new Error(`unexpected hub request ${JSON.stringify(params)}`);
}

function hubWriteRequests(requests) {
  return requests.filter((request) => {
    const params = request.params ?? {};
    return Object.values(params).some((section) => {
      if (!section || typeof section !== "object") return false;
      return [
        "update",
        "create",
        "delete",
        "run",
        "setOptions",
        "add",
        "remove",
        "backups",
        "prepare",
        "part",
        "complete",
      ].some((method) => Object.hasOwn(section, method));
    });
  });
}

async function setup(t) {
  const hub = await startHub();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-config-point-"),
  );
  t.after(async () => {
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, stateDirectory };
}

async function startClient(t, hub, stateDirectory, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "config-point-test-token",
      SPRUTHUB_SERIAL: serial,
      SPRUTHUB_CID: "config-point-test-client",
      SPRUTHUB_TIMEOUT_MS: "500",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      ...extraEnv,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "config-point-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

function toolResult(result) {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

function toolError(result) {
  assert.equal(result.isError, true, result.content[0]?.text);
  return result.structuredContent;
}

function comparisonFor(compared, entityRef) {
  return compared.comparison.entities.find(
    (entity) => entity.entity_ref === entityRef,
  );
}

function changeAt(entity, path) {
  return entity.changes.find(
    (change) => JSON.stringify(change.path) === JSON.stringify(path),
  );
}

function findComparedChange(result, entityRef, path) {
  const candidates = [];
  if (result.comparison) candidates.push(result.comparison);
  const selected = result.selection?.value;
  if (selected && typeof selected === "object") candidates.push(selected);
  for (const candidate of candidates) {
    const entities = Array.isArray(candidate.entities)
      ? candidate.entities
      : candidate.entity_ref
        ? [candidate]
        : [];
    for (const entity of entities) {
      if (entity.entity_ref !== entityRef || !Array.isArray(entity.changes)) {
        continue;
      }
      const change = changeAt(entity, path);
      if (change) return change;
    }
  }
  return null;
}

function nextTowardComparison(result) {
  const parts = result.representation?.available_parts ?? [];
  const comparisonPart = parts.find((part) =>
    (part.pointer ?? "").startsWith("/comparison"),
  );
  if (comparisonPart?.next) return comparisonPart.next;
  if (result.representation?.next) return result.representation.next;
  if (result.selection?.next) return result.selection.next;
  return null;
}

async function followComparedChange(client, page, entityRef, path) {
  let current = page;
  for (let step = 0; step < 20; step += 1) {
    const found = findComparedChange(current, entityRef, path);
    if (found) return found;
    const nextCall = nextTowardComparison(current);
    assert.ok(
      nextCall,
      `compared change ${JSON.stringify(path)} was not addressable`,
    );
    current = toolResult(
      await client.callTool({
        name: nextCall.tool,
        arguments: nextCall.arguments,
      }),
    );
  }
  assert.fail(`compared change ${JSON.stringify(path)} was not reached`);
}

function assertNotComparedOption(entity, optionKey, reason) {
  assert.equal(
    entity.changes.some((change) =>
      optionKey ? change.path.includes(optionKey) : false,
    ),
    false,
    JSON.stringify(entity.changes),
  );
  assert.equal(
    entity.not_compared.some(
      (item) =>
        item.reason === reason &&
        (optionKey
          ? JSON.stringify(item.path) === JSON.stringify(["options", optionKey])
          : JSON.stringify(item.path) === JSON.stringify(["options"])),
    ),
    true,
    JSON.stringify(entity.not_compared),
  );
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(fullPath)));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

test("a later agent finds a saved configuration point and compares real setting changes after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await firstClient.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [
          scenarioRef,
          accessoryRef,
          logicRef,
          deviceWindowRef,
          roomRef,
          homeWindowRef,
          characteristicRef,
        ],
      },
    }),
  );
  assert.equal(saved.status, "ok");
  assert.match(
    saved.point_ref,
    /^spruthub-point:\/\/hub\/config-point-hub\/configuration\/[a-f0-9]{24}$/,
  );
  assert.equal(saved.coverage, "selected_entities");
  assert.equal(saved.house_complete, false);
  assert.ok(Date.parse(saved.capture_started_at));
  assert.ok(Date.parse(saved.capture_finished_at));
  assert.deepEqual(
    saved.captured.map(({ entity_ref, kind }) => ({ entity_ref, kind })),
    [
      { entity_ref: scenarioRef, kind: "scenario" },
      { entity_ref: accessoryRef, kind: "accessory" },
      { entity_ref: logicRef, kind: "logic" },
      { entity_ref: deviceWindowRef, kind: "window" },
    ],
  );
  assert.deepEqual(
    saved.not_captured.map(({ entity_ref, reason }) => ({
      entity_ref,
      reason,
    })),
    [
      { entity_ref: roomRef, reason: "unsupported_entity_kind" },
      { entity_ref: homeWindowRef, reason: "home_settings_window" },
      { entity_ref: characteristicRef, reason: "unsupported_entity_kind" },
    ],
  );
  assert.deepEqual(saved.next, {
    tool: "get_configuration_point",
    arguments: { point_ref: saved.point_ref },
  });
  await firstClient.close();

  const accessory = hub.state.accessories[0];
  accessory.name = "Лампа кабинета";
  accessory.roomId = 2;
  accessory.online = false;
  accessory.services[0].characteristics[0].control.value = { boolValue: true };
  hub.state.scenarios[0].name = "Свет кабинета";
  hub.state.scenarios[0].error = true;
  hub.state.scenarios[0].rooms = [2];
  hub.state.scenarios[0].iconsIf = ["night"];
  hub.state.scenarios[0].data = JSON.stringify(
    officeBlockData({ delay: 5, blockId: 99 }),
  );
  hub.state.logics[0].active = false;
  hub.state.logicOptions = smoothLogicOptions(300);
  hub.state.logicOptions.find(({ key }) => key === "AccessToken").value = {
    stringValue: replacementTokenSecret,
  };
  hub.state.windows[deviceWindowKey].options = deviceWindowOptions(1);

  const secondClient = await startClient(t, hub, stateDirectory);
  const listed = toolResult(
    await secondClient.callTool({
      name: "list_configuration_points",
      arguments: { home_ref: homeRef, entity_ref: accessoryRef },
    }),
  );
  assert.equal(listed.points.length, 1);
  assert.equal(listed.points[0].point_ref, saved.point_ref);
  assert.equal(listed.coverage, "selected_entities");

  const past = toolResult(
    await secondClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref },
    }),
  );
  assert.equal(past.entity.kind, "configuration_point");
  assert.equal(past.entity.ref, saved.point_ref);
  assert.equal(past.comparison, undefined);
  const pastAccessory = past.entity.entities.find(
    ({ entity_ref }) => entity_ref === accessoryRef,
  );
  assert.deepEqual(pastAccessory.settings, {
    name: "Лампа офиса",
    room_ref: roomRef,
  });
  assert.equal(
    past.entity.entities.some((entity) =>
      JSON.stringify(entity).includes("online"),
    ),
    false,
  );

  const compared = toolResult(
    await secondClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref, compare: true },
    }),
  );
  assert.equal(compared.comparison.coverage, "selected_entities");
  assert.equal(compared.comparison.house_complete, false);

  const accessoryDiff = comparisonFor(compared, accessoryRef);
  assert.equal(accessoryDiff.status, "changed");
  assert.deepEqual(changeAt(accessoryDiff, ["name"]), {
    path: ["name"],
    from: "Лампа офиса",
    to: "Лампа кабинета",
  });
  assert.deepEqual(changeAt(accessoryDiff, ["room_ref"]), {
    path: ["room_ref"],
    from: roomRef,
    to: workshopRoomRef,
  });
  assert.equal(
    accessoryDiff.changes.some((change) =>
      JSON.stringify(change.path).includes("online"),
    ),
    false,
  );

  const scenarioDiff = comparisonFor(compared, scenarioRef);
  assert.equal(scenarioDiff.status, "changed");
  assert.deepEqual(changeAt(scenarioDiff, ["name"]), {
    path: ["name"],
    from: "Свет в офисе",
    to: "Свет кабинета",
  });
  assert.deepEqual(
    changeAt(scenarioDiff, [
      "configuration",
      "value",
      "targets",
      0,
      "then_delay",
    ]),
    {
      path: ["configuration", "value", "targets", 0, "then_delay"],
      from: 0,
      to: 5,
    },
  );
  assert.equal(
    scenarioDiff.changes.some((change) =>
      ["error", "rooms", "iconsIf", "blockId", "state"].some((noise) =>
        change.path.includes(noise),
      ),
    ),
    false,
  );

  const logicDiff = comparisonFor(compared, logicRef);
  assert.equal(logicDiff.status, "changed");
  assert.deepEqual(changeAt(logicDiff, ["active"]), {
    path: ["active"],
    from: true,
    to: false,
  });
  assert.deepEqual(
    changeAt(logicDiff, ["options", "Duration", "configured_value"]),
    {
      path: ["options", "Duration", "configured_value"],
      from: 900,
      to: 300,
    },
  );
  assert.equal(
    logicDiff.not_compared.some((item) => item.reason === "redacted"),
    true,
  );
  assert.equal(JSON.stringify(logicDiff).includes("AccessToken"), false);
  assert.equal(
    logicDiff.changes.some((change) => change.path.includes("AccessToken")),
    false,
  );

  const windowDiff = comparisonFor(compared, deviceWindowRef);
  assert.equal(windowDiff.status, "changed");
  assert.deepEqual(
    changeAt(windowDiff, ["options", startupOptionKey, "configured_value"]),
    {
      path: ["options", startupOptionKey, "configured_value"],
      from: 255,
      to: 1,
    },
  );
  assert.equal(
    windowDiff.changes.some((change) => change.path.includes("Reboot")),
    false,
  );

  assert.equal(hubWriteRequests(hub.requests).length, 0);
});

test("sensitive configuration is redacted before save and hidden values are not treated as equal", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [logicRef, deviceWindowRef, accessoryRef],
      },
    }),
  );
  const dumped = JSON.stringify([
    saved,
    toolResult(
      await client.callTool({
        name: "get_configuration_point",
        arguments: { point_ref: saved.point_ref },
      }),
    ),
  ]);
  for (const secret of [
    wifiSecret,
    windowPasswordSecret,
    accessTokenSecret,
    replacementTokenSecret,
  ]) {
    assert.equal(dumped.includes(secret), false, secret);
  }

  const stored = await filesUnder(stateDirectory);
  assert.ok(stored.length > 0);
  for (const file of stored) {
    const text = await readFile(file, "utf8");
    for (const secret of [
      wifiSecret,
      windowPasswordSecret,
      accessTokenSecret,
      replacementTokenSecret,
    ]) {
      assert.equal(text.includes(secret), false, `${file} ${secret}`);
    }
  }
});

test("a broken point, a failed entity read, and another home stay distinct from missing history", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [accessoryRef, logicRef, missingAccessoryRef],
      },
    }),
  );
  assert.equal(
    saved.not_captured.find(
      ({ entity_ref }) => entity_ref === missingAccessoryRef,
    )?.reason,
    "entity_not_found",
  );
  assert.equal(
    saved.captured.some(({ entity_ref }) => entity_ref === accessoryRef),
    true,
  );

  hub.state.behavior.failLogicGet = true;
  const partial = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [accessoryRef, logicRef],
      },
    }),
  );
  assert.equal(
    partial.not_captured.find(({ entity_ref }) => entity_ref === logicRef)
      ?.reason,
    "read_error",
  );
  assert.equal(
    partial.captured.some(({ entity_ref }) => entity_ref === accessoryRef),
    true,
  );

  const otherHome = toolError(
    await client.callTool({
      name: "list_configuration_points",
      arguments: { home_ref: otherHomeRef },
    }),
  );
  assert.equal(otherHome.error.code, "wrong_home");

  const pointDirs = (await readdir(stateDirectory)).filter((name) =>
    name.startsWith("configuration-points-"),
  );
  assert.equal(pointDirs.length, 1);
  const pointDir = path.join(stateDirectory, pointDirs[0]);
  await writeFile(path.join(pointDir, `${"ab".repeat(12)}.json`), "{", {
    mode: 0o600,
  });
  const listed = toolResult(
    await client.callTool({
      name: "list_configuration_points",
      arguments: { home_ref: homeRef },
    }),
  );
  assert.equal(
    listed.points.some(({ point_ref }) => point_ref === saved.point_ref),
    true,
  );
  assert.equal(
    listed.unavailable.some(
      ({ reason }) => reason === "corrupt_configuration_point",
    ),
    true,
  );
  const corrupt = toolError(
    await client.callTool({
      name: "get_configuration_point",
      arguments: {
        point_ref: `spruthub-point://hub/${serial}/configuration/${"ab".repeat(12)}`,
      },
    }),
  );
  assert.equal(corrupt.error.code, "corrupt_configuration_point");

  const foreignDir = path.join(
    stateDirectory,
    "configuration-points-ffffffffffffffffffffffff",
  );
  await mkdir(foreignDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(foreignDir, `${"cd".repeat(12)}.json`),
    `${JSON.stringify({
      version: 1,
      id: "cd".repeat(12),
      home_ref: otherHomeRef,
    })}\n`,
    { mode: 0o600 },
  );
  const afterForeign = toolResult(
    await client.callTool({
      name: "list_configuration_points",
      arguments: { home_ref: homeRef },
    }),
  );
  assert.equal(
    afterForeign.points.some((point) =>
      point.point_ref.includes("cd".repeat(12)),
    ),
    false,
  );
  assert.equal(hubWriteRequests(hub.requests).length, 0);
});

test("the saved point remains readable after restart without a live hub", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await firstClient.callTool({
      name: "save_configuration_point",
      arguments: { home_ref: homeRef, entity_refs: [accessoryRef, logicRef] },
    }),
  );
  await firstClient.close();
  for (const socket of hub.server.clients) socket.terminate();
  await new Promise((resolve) => hub.server.close(resolve));

  const offlineClient = await startClient(t, { url: hub.url }, stateDirectory);
  const listed = toolResult(
    await offlineClient.callTool({
      name: "list_configuration_points",
      arguments: { home_ref: homeRef },
    }),
  );
  assert.equal(listed.points[0].point_ref, saved.point_ref);
  const past = toolResult(
    await offlineClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref },
    }),
  );
  assert.equal(
    past.entity.entities.find(({ entity_ref }) => entity_ref === accessoryRef)
      .settings.name,
    "Лампа офиса",
  );
  const compareOffline = toolError(
    await offlineClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref, compare: true },
    }),
  );
  assert.equal(
    ["connection_failed", "connection_closed", "timeout"].includes(
      compareOffline.error.code,
    ),
    true,
    compareOffline.error.code,
  );
});

test("a later agent follows get_configuration_point next to a compared change of a large saved point", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.scenarios[0].data = JSON.stringify(
    officeBlockData({ delay: 0, targetCount: 250 }),
  );
  const client = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: { home_ref: homeRef, entity_refs: [scenarioRef] },
    }),
  );
  hub.state.scenarios[0].data = JSON.stringify(
    officeBlockData({ delay: 5, targetCount: 250 }),
  );

  for (const maxBytes of [16_000, 32_768]) {
    const overview = toolResult(
      await client.callTool({
        name: "get_configuration_point",
        arguments: {
          point_ref: saved.point_ref,
          compare: true,
          max_bytes: maxBytes,
        },
      }),
    );
    assert.equal(overview.representation.kind, "entity_overview");
    assert.equal(overview.comparison, undefined);
    assert.deepEqual(
      await followComparedChange(client, overview, scenarioRef, thenDelayPath),
      { path: thenDelayPath, from: 0, to: 5 },
    );
  }
  assert.equal(hubWriteRequests(hub.requests).length, 0);
});

test("incomplete logic and window options are not compared as added, removed, or equal", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const available = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [logicRef, deviceWindowRef],
      },
    }),
  );

  hub.state.windows[deviceWindowKey].options.find(
    ({ key }) => key === "DevicePassword",
  ).value = { stringValue: replacementWindowPasswordSecret };
  const passwordCompared = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: available.point_ref, compare: true },
    }),
  );
  const passwordWindow = comparisonFor(passwordCompared, deviceWindowRef);
  assert.equal(passwordWindow.status, "unchanged");
  assert.equal(passwordWindow.changes.length, 0);
  assertNotComparedOption(passwordWindow, null, "redacted");
  const passwordDump = JSON.stringify(passwordCompared);
  assert.equal(passwordDump.includes("DevicePassword"), false);
  assert.equal(passwordDump.includes(replacementWindowPasswordSecret), false);
  assert.equal(passwordDump.includes(windowPasswordSecret), false);

  hub.state.logicOptions.find(({ key }) => key === "Duration").disabled = true;
  hub.state.windows[deviceWindowKey].options = deviceWindowOptions(7);
  const unavailableCompared = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: available.point_ref, compare: true },
    }),
  );
  assertNotComparedOption(
    comparisonFor(unavailableCompared, logicRef),
    "Duration",
    "disabled",
  );
  assertNotComparedOption(
    comparisonFor(unavailableCompared, deviceWindowRef),
    startupOptionKey,
    "current_value_not_listed",
  );

  const unavailable = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [logicRef, deviceWindowRef],
      },
    }),
  );
  hub.state.logicOptions = smoothLogicOptions(300);
  hub.state.windows[deviceWindowKey].options = deviceWindowOptions(1);
  const restoredCompared = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: unavailable.point_ref, compare: true },
    }),
  );
  assertNotComparedOption(
    comparisonFor(restoredCompared, logicRef),
    "Duration",
    "disabled",
  );
  assertNotComparedOption(
    comparisonFor(restoredCompared, deviceWindowRef),
    startupOptionKey,
    "current_value_not_listed",
  );
  assert.equal(hubWriteRequests(hub.requests).length, 0);
});
