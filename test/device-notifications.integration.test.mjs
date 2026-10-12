import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  diffHomeSnapshots,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// «Сообщай мне, если датчик протечки на кухне уйдёт из сети», «уведомляй,
// когда открывается входная дверь»: SprutHub's own per-characteristic
// notification setting, the one the web client's Notifications screen
// writes with characteristic.update {aId, sId, cId, notify}
// (research/protocol/2026-09-24-web-client-action-map.md, B8). For the
// device going offline it is the C_Online characteristic of the device's
// information service. No scenario is created and nothing else changes.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const kitchen = `${homeRef}/room/4`;
// «Датчик протечки под мойкой» in «Кухня».
const kitchenLeak = `${homeRef}/accessory/23`;
const kitchenLeakOnline = `${kitchenLeak}/service/1/characteristic/8`;
const kitchenLeakName = `${kitchenLeak}/service/1/characteristic/5`;
const kitchenLeakDetected = `${kitchenLeak}/service/13/characteristic/14`;
// «Датчик двери», service «Входная дверь» in «Прихожая».
const frontDoor = `${homeRef}/accessory/11/service/13/characteristic/14`;

async function startHub(t) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-notifications-"),
  );
  t.after(async () => {
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, stateDirectory };
}

async function startClient(
  t,
  { hub, stateDirectory },
  { timeoutMs = 2000 } = {},
) {
  const client = new Client({ name: "notifications-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/server.mjs"],
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        ...hub.connectionEnv(),
        SPRUTHUB_TIMEOUT_MS: String(timeoutMs),
        SPRUT_AGENT_STATE_DIR: stateDirectory,
      },
      stderr: "pipe",
    }),
  );
  t.after(() => client.close());
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

async function refused(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, result.content[0]?.text);
  return result.structuredContent.error;
}

function prepareNotify(client, targetRef, value) {
  return call(client, "prepare_native_change", {
    operation: "characteristic_notify",
    target_ref: targetRef,
    value,
    reason: "Хозяин попросил присылать уведомление",
  });
}

async function notifyOf(client, ref) {
  return (await call(client, "get_entity", { entity_ref: ref })).entity.notify;
}

// «Какие уведомления включены?»: find_devices notify=true with the given
// filters, as the refs it lists and its count of offline notifications by
// room ref (null when it counts none).
async function notificationsOn(client, args = {}) {
  const page = await call(client, "find_devices", { notify: true, ...args });
  assert.equal(page.next, null);
  return {
    listed: page.notifications.map(({ ref }) => ref),
    offline: page.device_online
      ? Object.fromEntries(
          page.device_online.rooms.map(({ ref, notifying }) => [
            ref,
            notifying,
          ]),
        )
      : null,
  };
}

// The offline notifications that answer counts, as its next call lists
// them.
async function offlineListed(client, args = {}) {
  const page = await call(client, "find_devices", { notify: true, ...args });
  const { tool, arguments: next } = page.device_online.next;
  const listing = await call(client, tool, next);
  assert.equal(listing.next, null);
  assert.equal(listing.device_online, undefined);
  return listing.notifications;
}

function notifyWrites(hub, from = 0) {
  return hub
    .writes()
    .slice(from)
    .map(({ method, params }) => [method, params]);
}

test("«сообщай, если датчик протечки на кухне уйдёт из сети» turns on that sensor's online notification only and restore turns it off after a restart", async (t) => {
  const home = await startHub(t);
  const { hub } = home;
  const first = await startClient(t, home);

  // The device read shows which characteristics can notify and that none
  // does yet; a name cannot.
  const accessory = (
    await call(first, "get_entity", { entity_ref: kitchenLeak })
  ).entity;
  const notifyByRef = Object.fromEntries(
    accessory.services
      .flatMap(({ characteristics }) => characteristics)
      .map(({ ref, notify }) => [ref, notify]),
  );
  assert.equal(notifyByRef[kitchenLeakOnline], false);
  assert.equal(notifyByRef[kitchenLeakDetected], false);
  assert.equal(notifyByRef[kitchenLeakName], undefined);
  assert.deepEqual(await notificationsOn(first), {
    listed: [],
    offline: null,
  });

  const contract = await call(first, "get_native_change_contract", {
    operation: "characteristic_notify",
    target_ref: kitchenLeakOnline,
  });
  assert.equal(contract.contract.kind, "boolValue");
  assert.equal(contract.restore_supported, true);

  const prepared = await prepareNotify(first, kitchenLeakOnline, true);
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(prepared.diff, {
    value: { from: false, to: true, kind: "boolValue" },
  });
  assert.deepEqual(notifyWrites(hub), []);

  const applied = await call(first, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.observed_value, { value: true, kind: "boolValue" });
  assert.deepEqual(notifyWrites(hub), [
    [
      "characteristic.update",
      { characteristic: { update: { aId: 23, sId: 1, cId: 8, notify: true } } },
    ],
  ]);
  assert.deepEqual(diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()), [
    { key: "characteristic/23.1.8/notify", before: undefined, after: true },
  ]);
  assert.equal(await notifyOf(first, kitchenLeakOnline), true);
  assert.equal(await notifyOf(first, kitchenLeakDetected), false);
  // «Какие уведомления включены?»: an offline notification is counted in
  // its room, and the answer's call lists it.
  assert.deepEqual(await notificationsOn(first), {
    listed: [],
    offline: { [kitchen]: 1 },
  });
  assert.deepEqual(await offlineListed(first), [
    {
      ref: kitchenLeakOnline,
      type: "C_Online",
      name: "В сети",
      service: "Информация об аксессуаре",
      device: "Датчик протечки под мойкой",
      room: "Кухня",
    },
  ]);

  await first.close();
  const second = await startClient(t, home);
  const restored = await call(second, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored");
  assert.deepEqual(notifyWrites(hub, 1), [
    [
      "characteristic.update",
      {
        characteristic: { update: { aId: 23, sId: 1, cId: 8, notify: false } },
      },
    ],
  ]);
  assert.equal(await notifyOf(second, kitchenLeakOnline), false);
  assert.deepEqual(await notificationsOn(second), {
    listed: [],
    offline: null,
  });
  // The setting the sensor never had is now written off; nothing else.
  assert.deepEqual(diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()), [
    { key: "characteristic/23.1.8/notify", before: undefined, after: false },
  ]);
  const touched = Object.fromEntries(
    hub.touchedMethods().map(({ method, level }) => [method, level]),
  );
  assert.equal(touched["characteristic.update {notify}"], "observed");
  assert.equal(touched["characteristic.update"], undefined);
});

// The owner turned the sensor's offline notification on in the SprutHub
// app. Only accessory.get reports notify; accessory.list and
// characteristic.get leave it out whatever it is, as on the owner's hub
// (2026-10-12-notifications-live), so a read from them would take it for
// off and a restore would leave it off.
test("«выключи уведомление о пропаже датчика протечки», set on in the app, is off until restore turns it back on", async (t) => {
  const home = await startHub(t);
  const { hub } = home;
  const online = hub.state.accessories
    .find(({ id }) => id === 23)
    .services.find(({ sId }) => sId === 1)
    .characteristics.find(({ cId }) => cId === 8);
  online.notify = true;
  const client = await startClient(t, home);
  const kitchenNotifying = async () =>
    (await offlineListed(client, { room_ref: kitchen })).map(({ ref }) => ref);

  // «Какие уведомления включены?», for the home and for the kitchen.
  assert.equal(await notifyOf(client, kitchenLeakOnline), true);
  assert.deepEqual(await notificationsOn(client), {
    listed: [],
    offline: { [kitchen]: 1 },
  });
  assert.deepEqual(await kitchenNotifying(), [kitchenLeakOnline]);

  const prepared = await prepareNotify(client, kitchenLeakOnline, false);
  assert.deepEqual(prepared.diff, {
    value: { from: true, to: false, kind: "boolValue" },
  });
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  assert.equal(online.notify, false);
  assert.equal(await notifyOf(client, kitchenLeakOnline), false);
  assert.deepEqual(await notificationsOn(client), {
    listed: [],
    offline: null,
  });

  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored");
  assert.deepEqual(
    notifyWrites(hub).map(([, params]) => params.characteristic.update),
    [
      { aId: 23, sId: 1, cId: 8, notify: false },
      { aId: 23, sId: 1, cId: 8, notify: true },
    ],
  );
  assert.equal(online.notify, true);
  assert.equal(await notifyOf(client, kitchenLeakOnline), true);
  assert.deepEqual(await kitchenNotifying(), [kitchenLeakOnline]);
});

test("«уведомляй, когда открывается входная дверь» turns on the door sensor's notification, and a second request finds it already on", async (t) => {
  const home = await startHub(t);
  const { hub } = home;
  const client = await startClient(t, home);

  const prepared = await prepareNotify(client, frontDoor, true);
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  assert.deepEqual(notifyWrites(hub), [
    [
      "characteristic.update",
      {
        characteristic: {
          update: { aId: 11, sId: 13, cId: 14, notify: true },
        },
      },
    ],
  ]);
  assert.deepEqual(diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()), [
    { key: "characteristic/11.13.14/notify", before: undefined, after: true },
  ]);

  const again = await prepareNotify(client, frontDoor, true);
  assert.equal(again.status, "already_desired");
  assert.equal(again.native_write_sent, false);
  assert.deepEqual(again.observed_value, { value: true, kind: "boolValue" });
  assert.equal(notifyWrites(hub).length, 1);

  const history = await call(client, "list_native_changes", {
    home_ref: homeRef,
    entity_ref: frontDoor,
  });
  assert.deepEqual(
    history.changes.map(({ change_ref, operation, recorded_status }) => ({
      change_ref,
      operation,
      recorded_status,
    })),
    [
      {
        change_ref: prepared.change_ref,
        operation: "characteristic_notify",
        recorded_status: "applied",
      },
    ],
  );
});

test("a notification the owner switches back by hand after apply is neither restored over nor reclaimed", async (t) => {
  const home = await startHub(t);
  const { hub } = home;
  const client = await startClient(t, home);
  const online = hub.state.accessories
    .find(({ id }) => id === 23)
    .services.find(({ sId }) => sId === 1)
    .characteristics.find(({ cId }) => cId === 8);

  // Turned on in the SprutHub app between prepare and apply.
  const stale = await prepareNotify(client, kitchenLeakOnline, true);
  online.notify = true;
  const conflict = await call(client, "apply_native_change", {
    change_ref: stale.change_ref,
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.conflict_reason, "baseline_changed");
  assert.deepEqual(notifyWrites(hub), []);

  online.notify = false;
  const prepared = await prepareNotify(client, kitchenLeakOnline, true);
  await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  // The owner turns it off again in the SprutHub app.
  online.notify = false;
  const observed = await call(client, "get_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(observed.status, "conflict");
  assert.equal(observed.manual_change_observed, true);
  online.notify = true;
  const restore = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restore.status, "conflict");
  assert.equal(restore.conflict_reason, "manual_change");
  assert.equal(notifyWrites(hub).length, 1);
  assert.equal(online.notify, true);
});

test("a notification is refused before any write where the web client offers none, for another home, or for a value other than true or false", async (t) => {
  const home = await startHub(t);
  const { hub } = home;
  const client = await startClient(t, home);
  const prepare = (targetRef, value) =>
    refused(client, "prepare_native_change", {
      operation: "characteristic_notify",
      target_ref: targetRef,
      value,
      reason: "Уведомление",
    });

  const name = await prepare(kitchenLeakName, true);
  assert.equal(name.code, "notification_not_offered");
  const nameContract = await refused(client, "get_native_change_contract", {
    operation: "characteristic_notify",
    target_ref: kitchenLeakName,
  });
  assert.equal(nameContract.code, "notification_not_offered");
  assert.equal(
    (
      await prepare(
        "spruthub://hub/other-home/accessory/23/service/1/characteristic/8",
        true,
      )
    ).code,
    "unsupported_home_write",
  );
  assert.equal(
    (await prepare(kitchenLeakOnline, "да")).code,
    "invalid_native_value",
  );
  assert.deepEqual(notifyWrites(hub), []);
  const history = await call(client, "list_native_changes", {
    home_ref: homeRef,
  });
  assert.deepEqual(history.changes, []);
});

// «Какие датчики пришлют уведомление?» A device's offline notification sits
// in its information service, which is of no household kind; with a kind
// it belongs to the device.
test("find_devices with a kind keeps the offline notification of a device of that kind", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);
  const prepared = await prepareNotify(client, kitchenLeakOnline, true);
  await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });

  assert.deepEqual(await notificationsOn(client, { kind: "sensor" }), {
    listed: [],
    offline: { [kitchen]: 1 },
  });
  assert.deepEqual(
    (await offlineListed(client, { kind: "sensor" })).map(({ ref }) => ref),
    [kitchenLeakOnline],
  );
  assert.deepEqual(await notificationsOn(client, { kind: "light" }), {
    listed: [],
    offline: null,
  });
});

// «Какие уведомления включены у включённых розеток?», «…у кнопки?» A
// notification answer lists the characteristic whose notification is on,
// whatever else filters its service: a state filter, a characteristic that
// cannot be read (a button's press) or a page too small for values.
test("a notification answer lists the notifying characteristic under a state filter, unreadable or on a small page", async (t) => {
  const home = await startHub(t);
  const { hub } = home;
  const characteristic = (aId, sId, cId) =>
    hub.state.accessories
      .find(({ id }) => id === aId)
      .services.find((service) => service.sId === sId)
      .characteristics.find((item) => item.cId === cId);
  // Load notifications of the TV socket (on) and the kettle socket (off).
  const tvLoad = `${homeRef}/accessory/20/service/13/characteristic/15`;
  const kettleLoad = `${homeRef}/accessory/24/service/13/characteristic/15`;
  characteristic(20, 13, 15).notify = true;
  characteristic(24, 13, 15).notify = true;
  // The bedside button's press, which cannot be read.
  const press = characteristic(39, 13, 14);
  press.control.read = false;
  press.notify = true;
  const pressRef = `${homeRef}/accessory/39/service/13/characteristic/14`;
  const client = await startClient(t, home);

  const on = await call(client, "find_devices", { notify: true, state: "on" });
  assert.deepEqual(on.notifications, [
    {
      ref: tvLoad,
      type: "OutletInUse",
      service: "Розетка",
      device: "Розетка телевизора",
      room: "Гостиная",
    },
  ]);

  const listed = [];
  let args = { notify: true, limit: 1, max_bytes: 2048 };
  for (let pages = 0; args; pages++) {
    assert(pages < 10, "the pages never end");
    const page = await call(client, "find_devices", args);
    assert.equal(page.max_bytes_exceeded, undefined);
    listed.push(...page.notifications.map(({ ref }) => ref));
    args = page.next?.arguments;
  }
  assert.deepEqual(listed.sort(), [kettleLoad, tvLoad, pressRef].sort());
});

// The owner renamed the kitchen leak sensor in the SprutHub app after this
// process read the home, and the hub answers slowly: the owner's 81
// accessory.get took about 9 s against a 10 s request timeout
// (2026-10-12-notifications-live). The device reads already carry the new
// name; a whole-home re-read on the time they left would run out of it.
test("«какие уведомления включены» after a rename in the app answers with the new name when the device reads take most of the timeout", async (t) => {
  const home = await startHub(t);
  const { hub } = home;
  const client = await startClient(t, home, { timeoutMs: 600 });
  await call(client, "home_overview", {});
  const sensor = hub.state.accessories.find(({ id }) => id === 23);
  sensor.name = "Протечка у мойки";
  sensor.services
    .find(({ sId }) => sId === 13)
    .characteristics.find(({ cId }) => cId === 14).notify = true;
  // 29 accessories read 8 at a time: four rounds of 200 ms, past 600 ms,
  // each read well within it.
  hub.delayReplies("accessory.get", 200);

  const question = client.callTool({
    name: "find_devices",
    arguments: { notify: true },
  });
  await delay(250);
  // Another question asked while the notifications are being read.
  const meanwhile = client.callTool({
    name: "get_entity",
    arguments: { entity_ref: frontDoor },
  });
  const [answer, other] = await Promise.all([question, meanwhile]);
  assert.equal(answer.isError, undefined, answer.content[0]?.text);
  assert.equal(other.isError, undefined, other.content[0]?.text);
  assert.deepEqual(answer.structuredContent.notifications, [
    {
      ref: kitchenLeakDetected,
      type: "LeakDetected",
      service: "Протечка",
      device: "Протечка у мойки",
      room: "Кухня",
    },
  ]);
});

// A notification sends the characteristic's value: one that holds a secret
// is not offered, as get_entity does not show it.
test("a characteristic that holds a secret gets no notification", async (t) => {
  const home = await startHub(t);
  const { hub } = home;
  hub.state.accessories
    .find(({ id }) => id === 23)
    .services.push({
      aId: 23,
      sId: 50,
      name: "Облако",
      type: "Switch",
      visible: true,
      characteristics: [
        {
          aId: 23,
          sId: 50,
          cId: 51,
          hasOptions: false,
          control: {
            type: "C_AccessToken",
            name: "Access token",
            read: true,
            write: true,
            events: false,
            value: { stringValue: "token-value" },
          },
        },
      ],
    });
  const client = await startClient(t, home);
  const error = await refused(client, "prepare_native_change", {
    operation: "characteristic_notify",
    target_ref: `${kitchenLeak}/service/50/characteristic/51`,
    value: true,
    reason: "Уведомление",
  });
  assert.equal(error.code, "sensitive_native_data");
  assert.deepEqual(notifyWrites(hub), []);
});
