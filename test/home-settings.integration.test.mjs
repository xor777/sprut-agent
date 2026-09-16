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

const selectedSerial = "home/A";
const otherSerial = "home B";
const selectedHomeRef = "spruthub://hub/home%2FA";
const otherHomeRef = "spruthub://hub/home%20B";
const selectedRootWindowRef = `${selectedHomeRef}/window/`;
const otherRootWindowRef = `${otherHomeRef}/window/`;
const deviceWindowKey = "Controller/zigbee_demo/Child/DEVICE_A/";
const deviceWindowRef = `${selectedHomeRef}/window/${encodeURIComponent(deviceWindowKey)}`;
const hubClock = "2026-09-16 - 23:59:58 (GMT+03:00)";
const hubTimeZone = "Europe/Moscow";
const wifiSecret = "root-wifi-secret-must-not-leak";
const userSecret = "root-user-secret-must-not-leak";
const networkSecret = "root-network-secret-must-not-leak";
const paddingSecret = "root-padding-secret-must-not-leak";
const startupOptionKey = "/11/0006_OnOff/4003_StartUpOnOff/255";

function selectedHome() {
  return {
    serial: selectedSerial,
    name: "Moscow Office",
    online: true,
    owner: "owner-a@example.invalid",
    model: "Sprut.hub 2",
    optionsWindow: "",
    version: { current: { version: "3.0.0", revision: "20131" } },
  };
}

function otherHome() {
  return {
    serial: otherSerial,
    name: "Other house",
    online: true,
    owner: "owner-b@example.invalid",
    model: "Sprut.hub 2",
    version: { current: { version: "3.0.0", revision: "20131" } },
  };
}

function clockOption(key, inputType, value, extra = {}) {
  return {
    key,
    name: key,
    type: "GenericString",
    inputType,
    parent: "clock",
    read: true,
    events: false,
    value: { stringValue: value },
    ...extra,
  };
}

function rootWindow() {
  return {
    windowKey: "",
    label: { text: "Hub settings" },
    options: [
      {
        key: "main",
        name: "Main",
        type: "GenericInteger",
        inputType: "GROUP",
        parent: "",
        read: true,
        write: false,
        value: { intValue: 0 },
      },
      {
        key: "datetime",
        name: "Date and time",
        type: "GenericInteger",
        inputType: "FOLDER",
        parent: "main",
        read: true,
        write: false,
        value: { intValue: 0 },
      },
      {
        key: "clock",
        name: "Clock",
        type: "GenericInteger",
        inputType: "GROUP",
        parent: "datetime",
        read: true,
        write: false,
        value: { intValue: 0 },
      },
      {
        key: "TimeZone",
        name: "Time zone",
        type: "GenericString",
        inputType: "LIST",
        parent: "clock",
        read: true,
        write: true,
        events: false,
        value: { stringValue: hubTimeZone },
        validValues: [
          { name: "Moscow", value: { stringValue: hubTimeZone } },
          { name: "UTC", value: { stringValue: "UTC" } },
        ],
      },
      clockOption("Time", "STATUS", hubClock, { write: false }),
      clockOption("Sunrise", "STATUS", "06:12", { write: false }),
      clockOption("Sunset", "STATUS", "18:44", { write: false }),
      {
        key: "DateAndTimeInfo",
        name: "Clock info",
        type: "GenericString",
        inputType: "INFO",
        parent: "clock",
        read: true,
        write: false,
        value: { stringValue: "hub wall clock" },
      },
      {
        key: "ntp",
        name: "NTP",
        type: "GenericInteger",
        inputType: "GROUP",
        parent: "main",
        read: true,
        write: false,
        value: { intValue: 0 },
      },
      {
        key: "NTP1",
        name: "NTP server 1",
        type: "GenericString",
        inputType: "TEXT",
        parent: "ntp",
        read: true,
        write: true,
        value: { stringValue: "pool.ntp.org" },
      },
      {
        key: "WiFiPassword",
        name: "Wi-Fi password",
        type: "GenericString",
        inputType: "PASSWORD",
        parent: "main",
        read: true,
        write: true,
        value: { stringValue: wifiSecret },
      },
      {
        key: "Users",
        name: "Users",
        type: "GenericString",
        inputType: "TEXT",
        parent: "main",
        read: true,
        write: true,
        sensitive: true,
        value: { stringValue: userSecret },
      },
      {
        key: "Network",
        name: "Network",
        type: "GenericString",
        inputType: "TEXT",
        parent: "main",
        read: true,
        write: true,
        value: {
          stringValue: `Authorization: Bearer ${networkSecret}`,
        },
      },
    ],
  };
}

function deviceWindow() {
  return {
    windowKey: deviceWindowKey,
    label: { text: "Lamp settings" },
    options: [
      {
        key: startupOptionKey,
        name: "After power restore",
        type: "GenericInteger",
        inputType: "LIST",
        read: true,
        write: true,
        disabled: false,
        value: { intValue: 255 },
        validValues: [
          { name: "Off", value: { intValue: 0 } },
          { name: "On", value: { intValue: 1 } },
          { name: "Last", value: { intValue: 255 } },
        ],
      },
    ],
  };
}

function paddedRootWindow() {
  const window = rootWindow();
  const padding = Array.from({ length: 80 }, (_, index) => ({
    key: `padding-${index}`,
    name: `Padding ${index}`,
    type: "GenericString",
    inputType: "TEXT",
    parent: "main",
    read: true,
    write: true,
    value: { stringValue: `${paddingSecret}-${index}-${"x".repeat(180)}` },
  }));
  window.options.push(...padding);
  return window;
}

async function startHub(t, { root = rootWindow() } = {}) {
  const homes = [selectedHome(), otherHome()];
  const windows = new Map([
    [selectedSerial, new Map([["", structuredClone(root)]])],
    [otherSerial, new Map()],
  ]);
  windows.get(selectedSerial).set(deviceWindowKey, deviceWindow());
  const requests = [];
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      const params = request.params ?? {};
      if (params.hub?.list) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { hub: { list: { hubs: homes } } },
          }),
        );
        return;
      }
      const serial = request.serial;
      if (params.room?.list) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { room: { list: { rooms: [] } } },
          }),
        );
        return;
      }
      if (params.scenario?.list) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { scenario: { list: { scenarios: [] } } },
          }),
        );
        return;
      }
      if (params.extension?.list) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { extension: { list: { extensions: [] } } },
          }),
        );
        return;
      }
      if (params.window?.get) {
        const windowKey = params.window.get.windowKey;
        const window = windows.get(serial)?.get(windowKey) ?? null;
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { window: { get: window } },
          }),
        );
        return;
      }
      if (params.window?.update) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { window: { update: {} } },
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          id: request.id,
          error: {
            code: -32601,
            message: `unsupported test request: ${JSON.stringify(params)}`,
          },
        }),
      );
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    requests,
    windows,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

async function startClient(t, hub) {
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-home-settings-"),
  );
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "home-settings-test-token",
      SPRUTHUB_SERIAL: selectedSerial,
      SPRUTHUB_CID: "home-settings-test",
      SPRUTHUB_TIMEOUT_MS: "1000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "home-settings-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

function windowGets(hub) {
  return hub.requests
    .filter((request) => request.params?.window?.get)
    .map((request) => ({
      serial: request.serial,
      windowKey: request.params.window.get.windowKey,
    }));
}

function windowUpdates(hub) {
  return hub.requests.filter((request) => request.params?.window?.update);
}

function optionByKey(options, key) {
  return options.find((option) => option.key === key);
}

async function readWindowOption(client, entityRef, key) {
  const first = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: entityRef },
  });
  assert.equal(first.isError, undefined, first.content[0]?.text);
  const complete = first.structuredContent.entity;
  if (complete?.kind === "window" && Array.isArray(complete.options)) {
    return optionByKey(complete.options, key);
  }
  const optionsPart =
    first.structuredContent.representation?.available_parts?.find(
      ({ pointer }) => pointer === "/options",
    );
  assert.ok(optionsPart?.next, first.content[0]?.text);
  let page = await client.callTool({
    name: optionsPart.next.tool,
    arguments: optionsPart.next.arguments,
  });
  assert.equal(page.isError, undefined, page.content[0]?.text);
  if (page.structuredContent.selection?.value?.[key]) {
    return page.structuredContent.selection.value[key];
  }
  while (true) {
    const representation = page.structuredContent.representation;
    const match = representation?.available_parts?.find(
      ({ identity }) => identity?.key === key,
    );
    if (match?.next) {
      const selected = await client.callTool({
        name: match.next.tool,
        arguments: match.next.arguments,
      });
      assert.equal(selected.isError, undefined, selected.content[0]?.text);
      return selected.structuredContent.selection.value;
    }
    if (!representation?.next) return undefined;
    page = await client.callTool({
      name: representation.next.tool,
      arguments: representation.next.arguments,
    });
    assert.equal(page.isError, undefined, page.content[0]?.text);
  }
}

test("selected home empty optionsWindow is an executable settings window with hub clock", async (t) => {
  const hub = await startHub(t);
  const client = await startClient(t, hub);

  const catalog = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);
  const selected = catalog.structuredContent.homes.find(
    ({ ref }) => ref === selectedHomeRef,
  );
  const other = catalog.structuredContent.homes.find(
    ({ ref }) => ref === otherHomeRef,
  );
  assert.equal(selected.options_window_ref, selectedRootWindowRef);
  assert.equal(other.options_window_ref, null);
  assert.equal(Object.hasOwn(other, "options_window_ref"), true);
  const catalogText = JSON.stringify(catalog.structuredContent);
  assert.equal(catalogText.includes(hubClock), false);
  assert.equal(catalogText.includes(wifiSecret), false);
  assert.equal(catalogText.includes("padding-"), false);

  const overview = await client.callTool({
    name: "inspect_home",
    arguments: { home_ref: selectedHomeRef },
  });
  assert.equal(overview.isError, undefined, overview.content[0]?.text);
  assert.equal(
    overview.structuredContent.home.options_window_ref,
    selectedRootWindowRef,
  );

  const window = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: selected.options_window_ref },
  });
  assert.equal(window.isError, undefined, window.content[0]?.text);
  const entity = window.structuredContent.entity;
  assert.equal(entity.kind, "window");
  assert.equal(entity.ref, selectedRootWindowRef);
  assert.deepEqual(
    windowGets(hub).filter(({ windowKey }) => windowKey === ""),
    [{ serial: selectedSerial, windowKey: "" }],
  );

  const time = optionByKey(entity.options, "Time");
  const timeZone = optionByKey(entity.options, "TimeZone");
  assert.equal(time.configured_value, hubClock);
  assert.equal(time.type, "GenericString");
  assert.equal(time.input_type, "STATUS");
  assert.equal(time.read, true);
  assert.equal(time.write, false);
  assert.equal(time.parent, "clock");
  assert.equal(timeZone.configured_value, hubTimeZone);
  assert.equal(timeZone.input_type, "LIST");
  assert.equal(timeZone.read, true);
  assert.equal(timeZone.write, true);
  assert.equal(timeZone.native_change.native_write, true);
  assert.equal(timeZone.native_change.supported, false);
  assert.equal(Object.hasOwn(timeZone.native_change, "next"), false);
  assert.deepEqual(
    entity.layout.map(({ key, input_type, parent }) => ({
      key,
      input_type,
      parent,
    })),
    [
      { key: "main", input_type: "GROUP", parent: null },
      { key: "datetime", input_type: "FOLDER", parent: "main" },
      { key: "clock", input_type: "GROUP", parent: "datetime" },
      { key: "ntp", input_type: "GROUP", parent: "main" },
    ],
  );
  const observedAt = entity.freshness.observed_at;
  assert.match(observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.notEqual(observedAt, hubClock);
  assert.notEqual(
    window.structuredContent.freshness.hubResponseReceivedAt,
    hubClock,
  );
  assert.equal(
    optionByKey(entity.options, "NTP1").configured_value,
    "pool.ntp.org",
  );
  assert.equal(Object.hasOwn(entity, "ntp_synchronized"), false);

  const leaked = `${JSON.stringify(window.structuredContent)}${window.content[0].text}`;
  assert.equal(leaked.includes(wifiSecret), false);
  assert.equal(leaked.includes(userSecret), false);
  assert.equal(leaked.includes(networkSecret), false);
});

test("a home without optionsWindow is not given the selected hub root window", async (t) => {
  const hub = await startHub(t);
  const client = await startClient(t, hub);

  const missing = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: otherRootWindowRef },
  });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, "entity_not_found");
  assert.deepEqual(windowGets(hub), [{ serial: otherSerial, windowKey: "" }]);
  assert.equal(JSON.stringify(missing).includes(hubClock), false);
});

test("malformed window refs do not read another hub", async (t) => {
  const hub = await startHub(t);
  const client = await startClient(t, hub);

  const invalid = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: `${selectedHomeRef}/window` },
  });
  const unknownHome = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/missing-home/window/",
    },
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "invalid_entity_ref");
  assert.equal(unknownHome.isError, true);
  assert.equal(unknownHome.structuredContent.error.code, "home_not_found");
  assert.equal(
    hub.requests.some((request) => request.params?.window),
    false,
  );
});

test("missing hub clock is reported as absent instead of a local or received time", async (t) => {
  const window = rootWindow();
  window.options = window.options.filter(({ key }) => key !== "Time");
  const hub = await startHub(t, { root: window });
  const client = await startClient(t, hub);

  const entity = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: selectedRootWindowRef },
  });
  assert.equal(entity.isError, undefined, entity.content[0]?.text);
  assert.equal(
    optionByKey(entity.structuredContent.entity.options, "Time"),
    undefined,
  );
  assert.equal(
    optionByKey(entity.structuredContent.entity.options, "TimeZone")
      .configured_value,
    hubTimeZone,
  );
  const payload = JSON.stringify(entity.structuredContent);
  assert.equal(payload.includes(hubClock), false);
  assert.notEqual(
    entity.structuredContent.entity.freshness.observed_at,
    hubTimeZone,
  );
});

test("a large root window is paged and redacted without leaking secrets", async (t) => {
  const hub = await startHub(t, { root: paddedRootWindow() });
  const client = await startClient(t, hub);

  const overview = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: selectedRootWindowRef },
  });
  assert.equal(overview.isError, undefined, overview.content[0]?.text);
  assert.equal(
    overview.structuredContent.representation.kind,
    "entity_overview",
  );
  const time = await readWindowOption(client, selectedRootWindowRef, "Time");
  const timeZone = await readWindowOption(
    client,
    selectedRootWindowRef,
    "TimeZone",
  );
  assert.equal(time.configured_value, hubClock);
  assert.equal(timeZone.configured_value, hubTimeZone);
  const leaked = `${JSON.stringify(overview.structuredContent)}${JSON.stringify(time)}${JSON.stringify(timeZone)}`;
  assert.equal(leaked.includes(wifiSecret), false);
  assert.equal(leaked.includes(userSecret), false);
  assert.equal(leaked.includes(networkSecret), false);
  assert.equal(leaked.includes(paddingSecret), false);
});

test("root settings writes are rejected before window.update and device windows stay writable", async (t) => {
  const hub = await startHub(t);
  const client = await startClient(t, hub);

  const rootContract = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "window_option",
      target_ref: selectedRootWindowRef,
      option_key: "TimeZone",
    },
  });
  assert.equal(rootContract.isError, true);
  assert.equal(
    rootContract.structuredContent.error.code,
    "unsupported_window_option",
  );
  assert.match(
    rootContract.structuredContent.error.message,
    /home settings|read-only/i,
  );

  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: selectedRootWindowRef,
      option_key: "TimeZone",
      value: "UTC",
      reason: "Change hub timezone",
    },
  });
  assert.equal(prepared.isError, true);
  assert.equal(
    prepared.structuredContent.error.code,
    "unsupported_window_option",
  );

  const otherHomeWrite = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "window_option",
      target_ref: otherRootWindowRef,
      option_key: "TimeZone",
    },
  });
  assert.equal(otherHomeWrite.isError, true);
  assert.equal(
    otherHomeWrite.structuredContent.error.code,
    "unsupported_home_write",
  );

  const deviceContract = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
    },
  });
  assert.equal(
    deviceContract.isError,
    undefined,
    deviceContract.content[0]?.text,
  );
  assert.equal(deviceContract.structuredContent.contract.input_type, "LIST");

  assert.deepEqual(windowUpdates(hub), []);
  assert.equal(JSON.stringify(rootContract).includes(wifiSecret), false);
});
