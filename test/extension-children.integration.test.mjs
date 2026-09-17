import assert from "node:assert/strict";
import { once } from "node:events";
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

const homeSerial = "home/A";
const homeRef = "spruthub://hub/home%2FA";
const xiaomiKey = "Controller:xiaomi_air";
const bridgeKey = "Bridge:homekit_1";
const emptyKey = "Controller:empty_bus";
const telegramKey = "Notification:telegram";
const xiaomiRef = `${homeRef}/extension/${encodeURIComponent(xiaomiKey)}`;
const bridgeRef = `${homeRef}/extension/${encodeURIComponent(bridgeKey)}`;
const emptyRef = `${homeRef}/extension/${encodeURIComponent(emptyKey)}`;
const telegramRef = `${homeRef}/extension/${encodeURIComponent(telegramKey)}`;
const sharedChildId = "aqs-1";
const xiaomiChildRef = `${xiaomiRef}/child/${encodeURIComponent(sharedChildId)}`;
const bridgeChildRef = `${bridgeRef}/child/${encodeURIComponent(sharedChildId)}`;
const xiaomiChildWindowKey = "Controller/xiaomi_air/child/aqs-1";
const xiaomiChildWindowRef = `${homeRef}/window/${encodeURIComponent(xiaomiChildWindowKey)}`;
const writableListWindowKey = "Controller/xiaomi_air/child/writable-list";
const unreadListWindowKey = "Controller/xiaomi_air/child/unread-list";
const mixedListWindowKey = "Controller/xiaomi_air/child/mixed-list";
const emptyListWindowKey = "Controller/xiaomi_air/child/empty-list";
const malformedListWindowKey = "Controller/xiaomi_air/child/malformed-list";
const linkedAccessoryRef = `${homeRef}/accessory/49`;
const decoyAccessoryRef = `${homeRef}/accessory/50`;
const childSecret = "child-description-secret-must-not-leak";
const envelopeSecret = "child-envelope-secret-must-not-leak";
const rawEnvelopeSecret = "raw-envelope-secret-must-not-leak";
const largeChildCount = 40;

function telegramListItem() {
  return {
    extensionKey: telegramKey,
    type: "telegram",
    index: "telegram",
    bundleType: "NOTIFICATION",
    name: "Telegram",
    optionsWindow: "Notification/telegram/",
    childCount: 0,
    enabled: true,
    state: "FAILED",
  };
}

function telegramDetail() {
  return {
    ...telegramListItem(),
    spaces: [
      {
        key: "main",
        type: "SPACE_CHILDREN",
        label: { header: "Telegram", text: "Получатели" },
      },
    ],
  };
}

function xiaomiListItem() {
  return {
    extensionKey: xiaomiKey,
    type: "xiaomi",
    index: "xiaomi_air",
    bundleType: "CONTROLLER",
    name: "Шлюз Xiaomi",
    optionsWindow: "Controller/xiaomi_air/",
    mainWindow: "Controller/xiaomi_air/main",
    childCount: 3,
    enabled: true,
    state: "LOADED",
  };
}

function xiaomiDetail() {
  return {
    ...xiaomiListItem(),
    spaces: [
      {
        key: "main",
        type: "SPACE_CHILDREN",
        label: {
          header: "Controller",
          text: "Подключённые устройства",
          button: "Мои устройства",
        },
        actions: [{ id: 1, type: "ACTION_DISCOVERY", button: "Искать" }],
      },
      {
        key: "discovery",
        type: "SPACE_CHILDREN",
        label: {
          header: "Discovery",
          text: "Ранее обнаруженные",
          button: "Найденные",
        },
      },
    ],
    options: [{ key: "raw-option", value: { stringValue: "must-not-appear" } }],
    buttons: ["EXT_B_DISCOVERY"],
  };
}

function bridgeListItem() {
  return {
    extensionKey: bridgeKey,
    type: "homekit",
    index: "homekit_1",
    bundleType: "BRIDGE",
    name: "HomeKit",
    optionsWindow: "Bridge/homekit_1/",
    mainWindow: "Bridge/homekit_1/main",
    childCount: largeChildCount + 3,
    enabled: true,
    state: "LOADED",
  };
}

function bridgeDetail() {
  return {
    ...bridgeListItem(),
    spaces: [
      {
        key: "main",
        type: "SPACE_CHILDREN",
        label: { header: "Bridge", text: "Опубликованные" },
      },
      {
        key: "notConnected",
        type: "SPACE_CHILDREN",
        label: { header: "Bridge", text: "Не в мосте" },
      },
    ],
  };
}

function xiaomiChildren() {
  return [
    {
      extensionKey: xiaomiKey,
      spaceKey: "main",
      id: sharedChildId,
      name: "Станция качества воздуха",
      description: `token: ${childSecret}`,
      online: false,
      status: "sleep",
      optionsWindow: xiaomiChildWindowKey,
      features: [{ count: 1, type: "TemperatureSensor" }],
      transports: [{ type: "cloud" }],
      options: [{ key: "raw", value: { stringValue: "child-option-secret" } }],
      buttons: ["CHILD_B_REMOVE"],
    },
    {
      extensionKey: xiaomiKey,
      spaceKey: "discovery",
      id: "found-plug",
      name: "Найденная розетка",
      online: true,
      optionsWindow: "Controller/xiaomi_air/child/found-plug",
    },
    {
      extensionKey: xiaomiKey,
      spaceKey: "discovery",
      id: "found-bulb",
      name: "Найденная лампа",
      optionsWindow: "Controller/xiaomi_air/child/found-bulb",
    },
  ];
}

function bridgeChildren() {
  const extras = Array.from({ length: largeChildCount }, (_, index) => ({
    extensionKey: bridgeKey,
    spaceKey: "notConnected",
    id: `extra-${String(index).padStart(2, "0")}`,
    name: `Неопубликованный ${index} ${"ы".repeat(24)}`,
    online: index === 0,
    optionsWindow: `Bridge/homekit_1/child/extra-${index}`,
  }));
  return [
    {
      extensionKey: bridgeKey,
      spaceKey: "main",
      id: "bridge-main-1",
      name: "Мост опубликован",
      online: true,
      groupId: 7,
      optionsWindow: "Bridge/homekit_1/child/bridge-main-1",
    },
    {
      extensionKey: bridgeKey,
      spaceKey: "notConnected",
      id: sharedChildId,
      name: "Совпадающий id",
      online: true,
      optionsWindow: "Bridge/homekit_1/child/aqs-1",
    },
    {
      extensionKey: bridgeKey,
      spaceKey: "notConnected",
      id: "missing-online",
      name: "Без online",
      optionsWindow: "Bridge/homekit_1/child/missing-online",
    },
    ...extras,
  ];
}

function xiaomiChildWindow() {
  return {
    windowKey: xiaomiChildWindowKey,
    label: { text: "Настройки станции" },
    options: [
      {
        key: "LinkedAccessories",
        name: "Связанные аксессуары",
        type: "GenericInteger",
        inputType: "ACCESSORY_LIST",
        read: true,
        write: false,
        events: false,
        value: { intValue: 0 },
        validValues: [
          { value: { intValue: 49 }, name: "Станция качества воздуха" },
        ],
      },
      {
        key: "Mode",
        name: "Режим",
        type: "GenericInteger",
        inputType: "LIST",
        read: true,
        write: true,
        events: false,
        value: { intValue: 1 },
        validValues: [
          { value: { intValue: 1 }, name: "Авто" },
          { value: { intValue: 49 }, name: "Не аксессуар" },
        ],
      },
      {
        key: "Night",
        name: "Ночной режим",
        type: "GenericBoolean",
        inputType: "CHECKBOX",
        read: true,
        write: true,
        events: false,
        value: { boolValue: false },
      },
      {
        key: "Label",
        name: "Подпись",
        type: "GenericString",
        inputType: "TEXT",
        read: true,
        write: true,
        events: false,
        value: { stringValue: "Гостиная" },
      },
      {
        key: "DecoyNumber",
        name: "Порог",
        type: "GenericInteger",
        inputType: "NUMBER",
        read: true,
        write: true,
        events: false,
        minValue: 1,
        maxValue: 100,
        minStep: 1,
        value: { intValue: 49 },
      },
    ],
  };
}

function unreliableAccessoryWindow() {
  return accessoryListWindow("Controller/xiaomi_air/child/found-plug", {
    read: true,
    write: false,
  });
}

function accessoryListWindow(windowKey, { read, write, validValues }) {
  return {
    windowKey,
    label: { text: "Список" },
    options: [
      {
        key: "LinkedAccessories",
        name: "Связанные аксессуары",
        type: "GenericInteger",
        inputType: "ACCESSORY_LIST",
        read,
        write,
        events: false,
        value: { intValue: 0 },
        ...(validValues !== undefined ? { validValues } : {}),
      },
    ],
  };
}

function confirmedAccessoryValues() {
  return [
    { value: { intValue: 49 }, name: "Станция качества воздуха" },
    { value: { intValue: 50 }, name: "Другая станция" },
  ];
}

function homeState() {
  return {
    rooms: [{ id: 1, name: "Гостиная" }],
    accessories: [
      {
        id: 49,
        roomId: 1,
        name: "Станция качества воздуха",
        online: true,
        services: [],
      },
      {
        id: 50,
        roomId: 1,
        name: "Станция качества воздуха",
        online: true,
        services: [],
      },
    ],
    scenarios: [],
    extensions: [
      xiaomiListItem(),
      bridgeListItem(),
      telegramListItem(),
      {
        extensionKey: emptyKey,
        type: "bus",
        index: "empty_bus",
        bundleType: "CONTROLLER",
        name: "Пустая шина",
        optionsWindow: "Controller/empty_bus/",
        childCount: 0,
        enabled: true,
        state: "LOADED",
      },
    ],
    extensionDetails: new Map([
      [xiaomiKey, xiaomiDetail()],
      [bridgeKey, bridgeDetail()],
      [telegramKey, telegramDetail()],
      [
        emptyKey,
        {
          extensionKey: emptyKey,
          type: "bus",
          index: "empty_bus",
          bundleType: "CONTROLLER",
          name: "Пустая шина",
          optionsWindow: "Controller/empty_bus/",
          childCount: 0,
          enabled: true,
          state: "LOADED",
          spaces: [
            {
              key: "main",
              type: "SPACE_CHILDREN",
              label: { text: "Нет устройств" },
            },
          ],
        },
      ],
    ]),
    children: new Map([
      [xiaomiKey, xiaomiChildren()],
      [bridgeKey, bridgeChildren()],
      [emptyKey, []],
    ]),
    windows: new Map([
      [xiaomiChildWindowKey, xiaomiChildWindow()],
      ["Controller/xiaomi_air/child/found-plug", unreliableAccessoryWindow()],
      [
        writableListWindowKey,
        accessoryListWindow(writableListWindowKey, {
          read: true,
          write: true,
          validValues: confirmedAccessoryValues(),
        }),
      ],
      [
        unreadListWindowKey,
        accessoryListWindow(unreadListWindowKey, {
          read: false,
          write: false,
          validValues: confirmedAccessoryValues(),
        }),
      ],
      [
        mixedListWindowKey,
        accessoryListWindow(mixedListWindowKey, {
          read: true,
          write: false,
          validValues: [
            { value: { intValue: 49 }, name: "Станция качества воздуха" },
            { value: { stringValue: "50" }, name: "Строка" },
            { value: { intValue: -3 }, name: "Отрицательное" },
          ],
        }),
      ],
      [
        emptyListWindowKey,
        accessoryListWindow(emptyListWindowKey, {
          read: true,
          write: false,
          validValues: [],
        }),
      ],
      [
        malformedListWindowKey,
        accessoryListWindow(malformedListWindowKey, {
          read: true,
          write: false,
          validValues: [
            { value: { stringValue: "49" }, name: "Строка" },
            { value: { intValue: -1 }, name: "Отрицательное" },
          ],
        }),
      ],
    ]),
  };
}

async function startHub() {
  const state = homeState();
  const requests = [];
  const behavior = {
    childListErrorKey: null,
    childListUnsupportedKey: null,
    childListHangKey: null,
    childListForm: new Map([[telegramKey, "omitted_children"]]),
    childGetMutator: null,
    extensionGetErrorKey: null,
  };
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      const reply = respond(state, request, behavior);
      if (reply === undefined) return;
      socket.send(JSON.stringify({ id: request.id, ...reply }));
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    state,
    requests,
    behavior,
    server,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

function respond(state, request, behavior) {
  const params = request.params ?? {};
  if (params.hub?.list) {
    return {
      result: {
        hub: {
          list: {
            hubs: [
              {
                serial: homeSerial,
                name: "Дом",
                online: true,
                owner: "owner@example.invalid",
                model: "Sprut.hub 2",
                version: { current: { version: "3.0.0b", revision: "20131" } },
              },
            ],
          },
        },
      },
    };
  }
  if (params.device) {
    return { error: { code: -32601, message: "Module not found" } };
  }
  if (request.serial !== homeSerial) {
    return {
      error: { code: -32603, message: `unexpected serial ${request.serial}` },
    };
  }
  if (params.room?.list)
    return { result: { room: { list: { rooms: state.rooms } } } };
  if (params.scenario?.list) {
    return { result: { scenario: { list: { scenarios: state.scenarios } } } };
  }
  if (params.extension?.list) {
    return {
      result: { extension: { list: { extensions: state.extensions } } },
    };
  }
  if (params.extension?.get) {
    const key = params.extension.get.extensionKey;
    if (behavior.extensionGetErrorKey === key) {
      return hubFault(`Not found: '${envelopeSecret}'`);
    }
    return {
      result: { extension: { get: state.extensionDetails.get(key) ?? null } },
    };
  }
  if (params.extensionChild?.list) {
    const key = params.extensionChild.list.extensionKey;
    if (behavior.childListHangKey === key) return undefined;
    if (behavior.childListUnsupportedKey === key) {
      return { error: { code: -32601, message: "Method not found" } };
    }
    if (behavior.childListErrorKey === key) {
      return hubFault(`Not found: '${envelopeSecret}'`);
    }
    const form = behavior.childListForm.get(key);
    if (form === "omitted_children") {
      return { result: { extensionChild: { list: {} } } };
    }
    if (form === "empty_array") {
      return { result: { extensionChild: { list: { children: [] } } } };
    }
    if (form === "null_list") {
      return { result: { extensionChild: { list: null } } };
    }
    if (form === "missing_list") {
      return { result: { extensionChild: {} } };
    }
    if (form === "missing_envelope") {
      return { result: {} };
    }
    if (form === "null_children") {
      return { result: { extensionChild: { list: { children: null } } } };
    }
    if (form === "wrong_type") {
      return { result: { extensionChild: { list: { children: {} } } } };
    }
    if (form === "foreign_identity") {
      return {
        result: {
          extensionChild: {
            list: {
              children: [
                {
                  extensionKey: "Notification:other",
                  spaceKey: "main",
                  id: "foreign-1",
                  name: "Чужой получатель",
                },
              ],
            },
          },
        },
      };
    }
    if (!state.children.has(key)) {
      return { result: { extensionChild: { list: null } } };
    }
    return {
      result: {
        extensionChild: { list: { children: state.children.get(key) } },
      },
    };
  }
  if (params.extensionChild?.get) {
    const { extensionKey, id } = params.extensionChild.get;
    const child = (state.children.get(extensionKey) ?? []).find(
      (candidate) => candidate.id === id,
    );
    let payload = child ?? null;
    if (payload && behavior.childGetMutator) {
      payload = behavior.childGetMutator(payload);
    }
    return { result: { extensionChild: { get: payload } } };
  }
  if (params.window?.get) {
    const windowKey = params.window.get.windowKey;
    return {
      result: { window: { get: state.windows.get(windowKey) ?? null } },
    };
  }
  if (params.accessory?.get) {
    return {
      result: {
        accessory: {
          get:
            state.accessories.find(
              ({ id }) => id === params.accessory.get.id,
            ) ?? null,
        },
      },
    };
  }
  if (params.accessory?.list) {
    return {
      result: { accessory: { list: { accessories: state.accessories } } },
    };
  }
  return {
    error: {
      code: -32601,
      message: `unsupported test request: ${JSON.stringify(params)}`,
    },
  };
}

async function startClient(t, hub) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "opaque-4f9a8b7c",
      SPRUTHUB_SERIAL: homeSerial,
      SPRUTHUB_CID: "extension-child-test",
      SPRUTHUB_TIMEOUT_MS: "500",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "extension-child-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
  });
  await client.connect(transport);
  return client;
}

function paramsOf(request) {
  return request.params ?? {};
}

function hubFault(message) {
  return {
    error: {
      code: -32603,
      message,
      data: {
        jsonrpc: "2.0",
        raw: { envelope: rawEnvelopeSecret },
      },
    },
  };
}

function assertNoHubSecrets(payload) {
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, new RegExp(envelopeSecret));
  assert.doesNotMatch(text, new RegExp(rawEnvelopeSecret));
  assert.doesNotMatch(text, /jsonrpc/);
}

function assertEmptyChildCatalog(result, { enabled, state }) {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  const entity = result.structuredContent.entity;
  assert.equal(entity.kind, "extension");
  assert.equal(entity.enabled, enabled);
  assert.equal(entity.state, state);
  assert.equal(entity.child_count, 0);
  assert.deepEqual(entity.children, []);
  assert.deepEqual(entity.include_resolution.applied, ["children"]);
  assert.equal(
    entity.include_resolution.not_applied.some(
      ({ include }) => include === "children",
    ),
    false,
  );
  return entity;
}

function assertUnreadChildren(result, { enabled, state, errorCode }) {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  const entity = result.structuredContent.entity;
  assert.equal(entity.kind, "extension");
  assert.equal(entity.enabled, enabled);
  assert.equal(entity.state, state);
  assert.equal(Object.hasOwn(entity, "children"), false);
  assert.equal(entity.include_resolution.applied.includes("children"), false);
  const outcome = entity.include_resolution.not_applied.find(
    ({ include }) => include === "children",
  );
  assert.equal(outcome.reason, "read_failed");
  assert.equal(outcome.error_code, errorCode);
  assert.deepEqual(outcome.next, {
    tool: "get_entity",
    arguments: { entity_ref: entity.ref, include: ["children"] },
  });
  assertNoHubSecrets(result);
  return entity;
}

function childrenIncludeNext(entityRef) {
  return {
    tool: "get_entity",
    arguments: { entity_ref: entityRef, include: ["children"] },
  };
}

function assertIncludeReadPointerError(
  result,
  { code, retryable, action, next },
) {
  assert.equal(result.isError, true, result.content[0]?.text);
  assert.equal(result.structuredContent.error.code, code);
  assert.equal(result.structuredContent.error.retryable, retryable);
  assert.notEqual(code, "entity_pointer_not_found");
  if (action === undefined) {
    assert.equal(
      Object.hasOwn(result.structuredContent.error, "action"),
      false,
    );
  } else {
    assert.equal(result.structuredContent.error.action, action);
  }
  if (next === undefined) {
    assert.equal(Object.hasOwn(result.structuredContent, "next"), false);
  } else {
    assert.deepEqual(result.structuredContent.next, next);
  }
  assert.equal(Object.hasOwn(result.structuredContent, "entity"), false);
  assert.equal(Object.hasOwn(result.structuredContent, "selection"), false);
  assertNoHubSecrets(result);
}

function isMutation(params) {
  return Boolean(
    params.window?.update ||
      params.extension?.action ||
      params.extension?.setOptions ||
      params.extension?.delete ||
      params.extensionChild?.create ||
      params.extensionChild?.delete ||
      params.extensionChild?.setOptions ||
      params.accessory?.update ||
      params.accessory?.create ||
      params.device,
  );
}

function extensionChildListKeys(requests) {
  return requests
    .map(paramsOf)
    .filter((params) => params.extensionChild?.list)
    .map((params) => params.extensionChild.list.extensionKey);
}

async function collectPagedIdentities(client, entityRef, pointer, maxBytes) {
  let page = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: entityRef,
      include: ["children"],
      pointer,
      max_bytes: maxBytes,
    },
  });
  assert.equal(page.isError, undefined, page.content[0]?.text);
  if (Array.isArray(page.structuredContent.selection?.value)) {
    return page.structuredContent.selection.value.map((child) => ({
      ref: child.ref,
      id: child.id,
      space_key: child.space_key,
      name: child.name,
    }));
  }
  const identities = [];
  while (true) {
    const representation = page.structuredContent.representation;
    assert.ok(representation?.available_parts, page.content[0]?.text);
    const complete = representation.available_parts_complete === true;
    assert.equal(complete, representation.next == null);
    if (!complete) assert.ok(representation.remaining_parts > 0);
    for (const part of representation.available_parts) {
      assert.equal(typeof part.identity?.ref, "string", part.pointer);
      identities.push(part.identity);
    }
    if (!representation.next) break;
    page = await client.callTool({
      name: representation.next.tool,
      arguments: representation.next.arguments,
    });
    assert.equal(page.isError, undefined, page.content[0]?.text);
    assert(Buffer.byteLength(page.content[0].text) <= maxBytes);
  }
  return identities;
}

async function readAccessoryList(client, windowKey) {
  const window = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: `${homeRef}/window/${encodeURIComponent(windowKey)}`,
    },
  });
  assert.equal(window.isError, undefined, window.content[0]?.text);
  return window.structuredContent.entity.options.find(
    ({ input_type }) => input_type === "ACCESSORY_LIST",
  );
}

test("controller children outside rooms are found with settings and a linked accessory", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);

  const overview = await client.callTool({
    name: "inspect_home",
    arguments: { home_ref: homeRef },
  });
  assert.equal(overview.isError, undefined, overview.content[0]?.text);
  const controller = overview.structuredContent.entities.extensions.find(
    ({ name }) => name === "Шлюз Xiaomi",
  );
  assert.equal(controller.ref, xiaomiRef);
  assert.equal(controller.child_count, 3);
  assert.equal(
    controller.main_window_ref,
    `${homeRef}/window/${encodeURIComponent("Controller/xiaomi_air/main")}`,
  );
  assert.equal(Object.hasOwn(controller, "spaces"), false);
  assert.equal(Object.hasOwn(controller, "children"), false);

  const extension = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: controller.ref },
  });
  assert.equal(extension.isError, undefined, extension.content[0]?.text);
  const extensionEntity = extension.structuredContent.entity;
  assert.equal(extensionEntity.kind, "extension");
  assert.equal(extensionEntity.type, "xiaomi");
  assert.equal(extensionEntity.bundle_type, "CONTROLLER");
  assert.equal(extensionEntity.child_count, 3);
  assert.deepEqual(
    extensionEntity.spaces.map(({ key, type, label }) => ({
      key,
      type,
      label,
    })),
    [
      {
        key: "main",
        type: "SPACE_CHILDREN",
        label: {
          header: "Controller",
          text: "Подключённые устройства",
          button: "Мои устройства",
        },
      },
      {
        key: "discovery",
        type: "SPACE_CHILDREN",
        label: {
          header: "Discovery",
          text: "Ранее обнаруженные",
          button: "Найденные",
        },
      },
    ],
  );
  assert.equal(Object.hasOwn(extensionEntity, "children"), false);
  assert.equal(Object.hasOwn(extensionEntity, "options"), false);
  assert.equal(Object.hasOwn(extensionEntity, "buttons"), false);
  assert.equal(
    hub.requests.some((request) => paramsOf(request).extension?.get),
    true,
  );
  assert.deepEqual(extensionChildListKeys(hub.requests), []);
  assert.equal(
    hub.requests.some((request) => paramsOf(request).window?.get),
    false,
  );

  const listed = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: controller.ref, include: ["children"] },
  });
  assert.equal(listed.isError, undefined, listed.content[0]?.text);
  const listedEntity = listed.structuredContent.entity;
  assert.deepEqual(listedEntity.include_resolution.applied, ["children"]);
  assert.equal(listedEntity.children.length, 3);
  const mainChild = listedEntity.children.find(
    ({ space_key, id }) => space_key === "main" && id === sharedChildId,
  );
  const discoveryIds = listedEntity.children
    .filter(({ space_key }) => space_key === "discovery")
    .map(({ id }) => id)
    .sort();
  assert.equal(mainChild.ref, xiaomiChildRef);
  assert.equal(mainChild.kind, "extension_child");
  assert.equal(mainChild.online, false);
  assert.equal(mainChild.options_window_ref, xiaomiChildWindowRef);
  assert.deepEqual(discoveryIds, ["found-bulb", "found-plug"]);
  assert.equal(
    listedEntity.children.some((child) => Object.hasOwn(child, "options")),
    false,
  );
  assert.deepEqual(extensionChildListKeys(hub.requests), [xiaomiKey]);
  assert.equal(
    hub.requests.some((request) => paramsOf(request).extensionChild?.get),
    false,
  );
  assert.equal(
    hub.requests.some((request) => paramsOf(request).window?.get),
    false,
  );

  const child = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: mainChild.ref,
      include: ["options", "physical_configuration"],
    },
  });
  assert.equal(child.isError, undefined, child.content[0]?.text);
  const childEntity = child.structuredContent.entity;
  assert.equal(childEntity.kind, "extension_child");
  assert.equal(childEntity.ref, xiaomiChildRef);
  assert.equal(childEntity.id, sharedChildId);
  assert.equal(childEntity.extension_ref, xiaomiRef);
  assert.equal(childEntity.space_key, "main");
  assert.equal(childEntity.name, "Станция качества воздуха");
  assert.equal(childEntity.description, "[REDACTED]");
  assert.equal(childEntity.online, false);
  assert.equal(childEntity.status, "sleep");
  assert.deepEqual(childEntity.features, [
    { count: 1, type: "TemperatureSensor" },
  ]);
  assert.deepEqual(childEntity.transports, [{ type: "cloud" }]);
  assert.equal(childEntity.options_window_ref, xiaomiChildWindowRef);
  assert.equal(Object.hasOwn(childEntity, "options"), false);
  assert.equal(Object.hasOwn(childEntity, "physical_configuration"), false);
  assert.equal(Object.hasOwn(childEntity, "buttons"), false);
  assert.doesNotMatch(JSON.stringify(child), new RegExp(childSecret));
  const optionsOutcome = childEntity.include_resolution.not_applied.find(
    ({ include }) => include === "options",
  );
  const configurationOutcome = childEntity.include_resolution.not_applied.find(
    ({ include }) => include === "physical_configuration",
  );
  assert.deepEqual(optionsOutcome.next, {
    tool: "get_entity",
    arguments: { entity_ref: xiaomiChildWindowRef },
  });
  assert.deepEqual(configurationOutcome.next, {
    tool: "get_entity",
    arguments: {
      entity_ref: xiaomiChildWindowRef,
      include: ["physical_configuration"],
    },
  });
  const childGets = hub.requests
    .map(paramsOf)
    .filter((params) => params.extensionChild?.get)
    .map((params) => params.extensionChild.get);
  assert.deepEqual(childGets, [{ extensionKey: xiaomiKey, id: sharedChildId }]);

  const window = await client.callTool({
    name: optionsOutcome.next.tool,
    arguments: optionsOutcome.next.arguments,
  });
  assert.equal(window.isError, undefined, window.content[0]?.text);
  const windowEntity = window.structuredContent.entity;
  const accessoryList = windowEntity.options.find(
    ({ input_type }) => input_type === "ACCESSORY_LIST",
  );
  const listControl = windowEntity.options.find(
    ({ input_type }) => input_type === "LIST",
  );
  const numberControl = windowEntity.options.find(
    ({ input_type }) => input_type === "NUMBER",
  );
  const checkbox = windowEntity.options.find(
    ({ input_type }) => input_type === "CHECKBOX",
  );
  const text = windowEntity.options.find(
    ({ input_type }) => input_type === "TEXT",
  );
  assert.equal(accessoryList.configured_value, 0);
  assert.equal(accessoryList.read, true);
  assert.equal(accessoryList.write, false);
  assert.deepEqual(accessoryList.linked_accessories, {
    status: "confirmed",
    accessories: [
      { ref: linkedAccessoryRef, name: "Станция качества воздуха" },
    ],
  });
  assert.equal(listControl.configured_value, 1);
  assert.equal(Object.hasOwn(listControl, "linked_accessories"), false);
  assert.equal(numberControl.configured_value, 49);
  assert.equal(Object.hasOwn(numberControl, "linked_accessories"), false);
  assert.equal(checkbox.configured_value, false);
  assert.equal(text.configured_value, "Гостиная");
  assert.equal(accessoryList.native_change.supported, false);

  const accessory = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: linkedAccessoryRef },
  });
  assert.equal(accessory.isError, undefined, accessory.content[0]?.text);
  assert.equal(accessory.structuredContent.entity.kind, "accessory");
  assert.equal(accessory.structuredContent.entity.ref, linkedAccessoryRef);

  const windowKeys = hub.requests
    .map(paramsOf)
    .filter((params) => params.window?.get)
    .map((params) => params.window.get.windowKey);
  assert.deepEqual(windowKeys, [xiaomiChildWindowKey]);
  assert.equal(
    hub.requests.some((request) => isMutation(paramsOf(request))),
    false,
  );
  assert.deepEqual(extensionChildListKeys(hub.requests), [xiaomiKey]);
  assert.equal(
    JSON.stringify(listedEntity.children.map(({ ref }) => ref)).includes(
      decoyAccessoryRef,
    ),
    false,
  );
});

test("bridge children keep owner identity and do not guess connection from online", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);

  const listed = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: bridgeRef, include: ["children"] },
  });
  assert.equal(listed.isError, undefined, listed.content[0]?.text);
  const listedEntity = listed.structuredContent.entity;
  assert.equal(listedEntity.bundle_type, "BRIDGE");
  const shared = listedEntity.children.find(({ id }) => id === sharedChildId);
  const missingOnline = listedEntity.children.find(
    ({ id }) => id === "missing-online",
  );
  assert.equal(shared.ref, bridgeChildRef);
  assert.notEqual(shared.ref, xiaomiChildRef);
  assert.equal(shared.space_key, "notConnected");
  assert.equal(shared.online, true);
  assert.equal(missingOnline.online, null);
  assert.equal(Object.hasOwn(missingOnline, "available"), false);

  const child = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: shared.ref },
  });
  assert.equal(child.isError, undefined, child.content[0]?.text);
  const childEntity = child.structuredContent.entity;
  assert.equal(childEntity.kind, "extension_child");
  assert.equal(childEntity.extension_ref, bridgeRef);
  assert.equal(childEntity.id, sharedChildId);
  assert.equal(childEntity.space_key, "notConnected");
  assert.equal(childEntity.online, true);
  assert.equal(childEntity.group_id, undefined);

  const xiaomiChild = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: xiaomiChildRef },
  });
  assert.equal(xiaomiChild.isError, undefined, xiaomiChild.content[0]?.text);
  assert.equal(xiaomiChild.structuredContent.entity.extension_ref, xiaomiRef);
  assert.equal(xiaomiChild.structuredContent.entity.space_key, "main");
  assert.equal(xiaomiChild.structuredContent.entity.online, false);

  const unknownOnline = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: missingOnline.ref },
  });
  assert.equal(
    unknownOnline.isError,
    undefined,
    unknownOnline.content[0]?.text,
  );
  assert.equal(unknownOnline.structuredContent.entity.online, null);
  assert.equal(
    unknownOnline.structuredContent.entity.space_key,
    "notConnected",
  );

  const childGets = hub.requests
    .map(paramsOf)
    .filter((params) => params.extensionChild?.get)
    .map((params) => params.extensionChild.get);
  assert.deepEqual(childGets, [
    { extensionKey: bridgeKey, id: sharedChildId },
    { extensionKey: xiaomiKey, id: sharedChildId },
    { extensionKey: bridgeKey, id: "missing-online" },
  ]);
});

test("child catalogs paginate, distinguish empty from errors, and hide raw hub faults", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);

  const identities = await collectPagedIdentities(
    client,
    bridgeRef,
    "/children",
    2_048,
  );
  assert.equal(identities.length, largeChildCount + 3);
  assert.equal(
    new Set(identities.map(({ ref }) => ref)).size,
    identities.length,
  );
  assert.ok(identities.some(({ id }) => id === "extra-39"));
  assert.ok(
    identities.every(
      ({ kind }) => kind === "extension_child" || kind === undefined,
    ),
  );
  assert.ok(
    identities.every((identity) => Object.hasOwn(identity, "space_key")),
  );
  assert.ok(
    identities.some(
      ({ space_key, id }) => space_key === "main" && id === "bridge-main-1",
    ),
  );
  assert.equal(
    identities.filter(({ space_key }) => space_key === "notConnected").length,
    largeChildCount + 2,
  );

  const empty = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: emptyRef, include: ["children"] },
  });
  assert.equal(empty.isError, undefined, empty.content[0]?.text);
  assert.deepEqual(empty.structuredContent.entity.children, []);
  assert.deepEqual(empty.structuredContent.entity.include_resolution.applied, [
    "children",
  ]);

  hub.behavior.childListErrorKey = xiaomiKey;
  const rejected = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: xiaomiRef, include: ["children"] },
  });
  const rejectedEntity = assertUnreadChildren(rejected, {
    enabled: true,
    state: "LOADED",
    errorCode: "request_rejected",
  });
  assert.equal(rejectedEntity.child_count, 3);

  hub.behavior.childListErrorKey = null;
  hub.behavior.childListUnsupportedKey = xiaomiKey;
  const unsupported = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: xiaomiRef, include: ["children"] },
  });
  const unsupportedEntity = assertUnreadChildren(unsupported, {
    enabled: true,
    state: "LOADED",
    errorCode: "unsupported",
  });
  assert.equal(unsupportedEntity.child_count, 3);

  hub.behavior.childListUnsupportedKey = null;
  hub.behavior.childGetMutator = (child) => ({
    ...child,
    extensionKey: "Controller:other",
  });
  const mismatched = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: xiaomiChildRef },
  });
  assert.equal(mismatched.isError, true);
  assert.equal(
    mismatched.structuredContent.error.code,
    "incompatible_response",
  );
  assert.doesNotMatch(JSON.stringify(mismatched), /Controller:other/);

  hub.behavior.childGetMutator = (child) => ({
    ...child,
    id: "other-id",
  });
  const mismatchedId = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: xiaomiChildRef },
  });
  assert.equal(mismatchedId.isError, true);
  assert.equal(
    mismatchedId.structuredContent.error.code,
    "incompatible_response",
  );
  assert.doesNotMatch(JSON.stringify(mismatchedId), /other-id/);

  const unreliable = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: `${homeRef}/window/${encodeURIComponent("Controller/xiaomi_air/child/found-plug")}`,
    },
  });
  assert.equal(unreliable.isError, undefined, unreliable.content[0]?.text);
  const unreliableList = unreliable.structuredContent.entity.options.find(
    ({ input_type }) => input_type === "ACCESSORY_LIST",
  );
  assert.equal(unreliableList.linked_accessories.status, "unreliable_form");
  assert.equal(
    Object.hasOwn(unreliableList.linked_accessories, "accessories"),
    false,
  );
});

test("empty notification children stay empty and keep provider status when the catalog cannot be read", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);

  const omitted = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: telegramRef,
      include: ["children", "diagnostics"],
    },
  });
  const omittedEntity = assertEmptyChildCatalog(omitted, {
    enabled: true,
    state: "FAILED",
  });
  assert.deepEqual(
    omittedEntity.spaces.map(({ key, type }) => ({ key, type })),
    [{ key: "main", type: "SPACE_CHILDREN" }],
  );
  const diagnosticsOutcome = omittedEntity.include_resolution.not_applied.find(
    ({ include }) => include === "diagnostics",
  );
  assert.equal(diagnosticsOutcome.reason, "window_scoped");
  assert.equal(omittedEntity.child_count, 0);

  hub.behavior.childListForm.set(telegramKey, "empty_array");
  const explicitEmpty = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: telegramRef, include: ["children"] },
  });
  assertEmptyChildCatalog(explicitEmpty, { enabled: true, state: "FAILED" });

  const listed = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: xiaomiRef, include: ["children"] },
  });
  assert.equal(listed.isError, undefined, listed.content[0]?.text);
  const mainChild = listed.structuredContent.entity.children.find(
    ({ space_key, id }) => space_key === "main" && id === sharedChildId,
  );
  assert.equal(mainChild.ref, xiaomiChildRef);
  const child = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: mainChild.ref },
  });
  assert.equal(child.isError, undefined, child.content[0]?.text);
  assert.equal(child.structuredContent.entity.ref, xiaomiChildRef);
  const window = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: mainChild.options_window_ref },
  });
  assert.equal(window.isError, undefined, window.content[0]?.text);
  assert.equal(window.structuredContent.entity.kind, "window");

  for (const [form, errorCode] of [
    ["null_list", "incompatible_response"],
    ["missing_list", "incompatible_response"],
    ["missing_envelope", "incompatible_response"],
    ["null_children", "incompatible_response"],
    ["wrong_type", "incompatible_response"],
    ["foreign_identity", "incompatible_response"],
  ]) {
    hub.behavior.childListForm.set(telegramKey, form);
    const unread = await client.callTool({
      name: "get_entity",
      arguments: { entity_ref: telegramRef, include: ["children"] },
    });
    const unreadEntity = assertUnreadChildren(unread, {
      enabled: true,
      state: "FAILED",
      errorCode,
    });
    assert.equal(unreadEntity.child_count, 0);
    assert.doesNotMatch(JSON.stringify(unread), /Notification:other/);
    assert.doesNotMatch(JSON.stringify(unread), /foreign-1/);
  }

  hub.behavior.childListForm.delete(telegramKey);
  hub.behavior.childListErrorKey = telegramKey;
  const rejected = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: telegramRef, include: ["children"] },
  });
  assertUnreadChildren(rejected, {
    enabled: true,
    state: "FAILED",
    errorCode: "request_rejected",
  });

  hub.behavior.childListErrorKey = null;
  hub.behavior.childListHangKey = telegramKey;
  const timedOut = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: telegramRef, include: ["children"] },
  });
  assertUnreadChildren(timedOut, {
    enabled: true,
    state: "FAILED",
    errorCode: "timeout",
  });

  hub.behavior.childListHangKey = null;
  hub.behavior.extensionGetErrorKey = telegramKey;
  const missingProvider = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: telegramRef, include: ["children"] },
  });
  assert.equal(missingProvider.isError, true);
  assert.equal(
    missingProvider.structuredContent.error.code,
    "request_rejected",
  );
  assert.equal(
    Object.hasOwn(missingProvider.structuredContent, "entity"),
    false,
  );
  assertNoHubSecrets(missingProvider);
});

test("a pointer into unread children keeps the include read failure", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);

  hub.behavior.childListHangKey = telegramKey;
  const timedOut = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: telegramRef,
      include: ["children"],
      pointer: "/children",
    },
  });
  assertIncludeReadPointerError(timedOut, {
    code: "timeout",
    retryable: true,
    action: "retry",
    next: childrenIncludeNext(telegramRef),
  });

  const nested = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: telegramRef,
      include: ["children"],
      pointer: "/children/0",
    },
  });
  assertIncludeReadPointerError(nested, {
    code: "timeout",
    retryable: true,
    action: "retry",
    next: childrenIncludeNext(telegramRef),
  });

  const readablePart = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: telegramRef,
      include: ["children"],
      pointer: "/spaces",
    },
  });
  assert.equal(readablePart.isError, undefined, readablePart.content[0]?.text);
  assert.equal(readablePart.structuredContent.selection.status, "found");
  assert.equal(readablePart.structuredContent.identity.enabled, true);
  assert.equal(readablePart.structuredContent.identity.state, "FAILED");

  const missingPath = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: telegramRef,
      include: ["children"],
      pointer: "/not_a_child_catalog",
    },
  });
  assert.equal(missingPath.isError, true);
  assert.equal(
    missingPath.structuredContent.error.code,
    "entity_pointer_not_found",
  );

  hub.behavior.childListHangKey = null;
  hub.behavior.childListErrorKey = telegramKey;
  const rejected = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: telegramRef,
      include: ["children"],
      pointer: "/children",
    },
  });
  assertIncludeReadPointerError(rejected, {
    code: "request_rejected",
    retryable: false,
    next: childrenIncludeNext(telegramRef),
  });

  hub.behavior.childListErrorKey = null;
  hub.behavior.childListUnsupportedKey = telegramKey;
  const unsupported = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: telegramRef,
      include: ["children"],
      pointer: "/children",
    },
  });
  assertIncludeReadPointerError(unsupported, {
    code: "unsupported",
    retryable: false,
    action: "inspect_home",
    next: { tool: "inspect_home", arguments: { home_ref: homeRef } },
  });
  assert.notDeepEqual(
    unsupported.structuredContent.next,
    childrenIncludeNext(telegramRef),
  );

  const unsupportedEntity = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: telegramRef, include: ["children"] },
  });
  const unsupportedOutcome =
    unsupportedEntity.structuredContent.entity.include_resolution.not_applied.find(
      ({ include }) => include === "children",
    );
  assert.equal(unsupportedOutcome.error_code, "unsupported");
  assert.equal(Object.hasOwn(unsupportedOutcome, "next"), false);

  hub.behavior.childListUnsupportedKey = null;
  hub.behavior.childListForm.set(telegramKey, "wrong_type");
  const incompatible = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: telegramRef,
      include: ["children"],
      pointer: "/children/0/ref",
    },
  });
  assertIncludeReadPointerError(incompatible, {
    code: "incompatible_response",
    retryable: false,
  });

  hub.behavior.childListForm.set(telegramKey, "omitted_children");
  const empty = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: telegramRef,
      include: ["children"],
      pointer: "/children",
    },
  });
  assert.equal(empty.isError, undefined, empty.content[0]?.text);
  assert.deepEqual(empty.structuredContent.selection.value, []);

  const emptyMissing = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: telegramRef,
      include: ["children"],
      pointer: "/children/0",
    },
  });
  assert.equal(emptyMissing.isError, true);
  assert.equal(
    emptyMissing.structuredContent.error.code,
    "entity_pointer_not_found",
  );

  const page = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: bridgeRef,
      include: ["children"],
      pointer: "/children",
      max_bytes: 2_048,
    },
  });
  assert.equal(page.isError, undefined, page.content[0]?.text);
  const continuation = page.structuredContent.representation.next;
  assert.equal(continuation?.tool, "get_entity");
  assert.equal(continuation.arguments.pointer, "/children");
  assert.ok(continuation.arguments.offset > 0);
  assert.equal(typeof continuation.arguments.version, "string");

  hub.behavior.childListHangKey = bridgeKey;
  const continued = await client.callTool({
    name: continuation.tool,
    arguments: continuation.arguments,
  });
  assertIncludeReadPointerError(continued, {
    code: "timeout",
    retryable: true,
    action: "retry",
    next: childrenIncludeNext(bridgeRef),
  });

  hub.behavior.childListHangKey = null;
  const recovered = await client.callTool({
    name: continued.structuredContent.next.tool,
    arguments: continued.structuredContent.next.arguments,
  });
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  if (recovered.structuredContent.entity) {
    assert.ok(Array.isArray(recovered.structuredContent.entity.children));
    assert.ok(
      recovered.structuredContent.entity.include_resolution.applied.includes(
        "children",
      ),
    );
  } else {
    assert.ok(
      recovered.structuredContent.representation.available_parts.some(
        ({ pointer }) => pointer === "/children" || pointer.startsWith("/0"),
      ) || recovered.structuredContent.selection?.pointer === "/children",
    );
  }
});

test("ACCESSORY_LIST claims links only for a confirmed read-only form", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);

  const writable = await readAccessoryList(client, writableListWindowKey);
  assert.equal(writable.read, true);
  assert.equal(writable.write, true);
  assert.equal(Object.hasOwn(writable, "linked_accessories"), false);
  assert.deepEqual(
    writable.valid_values.map(({ value }) => value),
    [49, 50],
  );

  const unread = await readAccessoryList(client, unreadListWindowKey);
  assert.equal(unread.read, false);
  assert.equal(unread.write, false);
  assert.equal(Object.hasOwn(unread, "linked_accessories"), false);
  assert.deepEqual(
    unread.valid_values.map(({ value }) => value),
    [49, 50],
  );

  const mixed = await readAccessoryList(client, mixedListWindowKey);
  assert.equal(mixed.read, true);
  assert.equal(mixed.write, false);
  assert.equal(mixed.linked_accessories.status, "unreliable_form");
  assert.equal(Object.hasOwn(mixed.linked_accessories, "accessories"), false);
  assert.deepEqual(
    mixed.valid_values.map(({ value }) => value),
    [49, "50", -3],
  );

  const empty = await readAccessoryList(client, emptyListWindowKey);
  assert.deepEqual(empty.linked_accessories, {
    status: "confirmed",
    accessories: [],
  });

  const malformed = await readAccessoryList(client, malformedListWindowKey);
  assert.equal(malformed.linked_accessories.status, "unreliable_form");
  assert.equal(
    Object.hasOwn(malformed.linked_accessories, "accessories"),
    false,
  );

  const confirmed = await readAccessoryList(client, xiaomiChildWindowKey);
  assert.deepEqual(confirmed.linked_accessories, {
    status: "confirmed",
    accessories: [
      { ref: linkedAccessoryRef, name: "Станция качества воздуха" },
    ],
  });
  assert.equal(
    hub.requests.some((request) => isMutation(paramsOf(request))),
    false,
  );
});
