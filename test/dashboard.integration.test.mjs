import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardServer } from "../src/dashboard-server.mjs";
import { createSprutHubReader } from "../src/read-api.mjs";
import { SprutHubError } from "../src/spruthub-client.mjs";

const homeRef = "spruthub://hub/home-1";
const temperatureRef = `${homeRef}/accessory/10/service/20/characteristic/30`;
const lightRef = `${homeRef}/accessory/11/service/21/characteristic/31`;
const motionRef = `${homeRef}/accessory/12/service/22/characteristic/32`;

test("the public reader returns only selected safe readings and isolates a failed source", async () => {
  const secret = "local-only-password";
  const client = new FakeClient(
    new Map([
      [
        temperatureRef,
        characteristic(temperatureRef, "Temperature", 0, "celsius", [
          { key: "zero", name: "Ноль", value: 0 },
        ]),
      ],
      [lightRef, characteristic(lightRef, "On", false, null)],
      [
        motionRef,
        new SprutHubError(
          "connection_closed",
          `Connection failed without exposing ${secret}`,
          "retry",
        ),
      ],
    ]),
  );
  const reader = createSprutHubReader({
    connection: {
      secrets: [secret],
      async getClient() {
        return client;
      },
    },
  });

  const result = await reader.read({
    homeRef,
    readings: [
      { ref: temperatureRef, label: "Офис" },
      { ref: lightRef, label: "Лампа" },
      { ref: motionRef, label: "Движение" },
    ],
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(
    result.readings.map(({ label, status, value, unit }) => ({
      label,
      status,
      value,
      unit,
    })),
    [
      { label: "Офис", status: "ok", value: 0, unit: "celsius" },
      { label: "Лампа", status: "ok", value: false, unit: null },
      {
        label: "Движение",
        status: "error",
        value: undefined,
        unit: undefined,
      },
    ],
  );
  assert.deepEqual(client.requested, [temperatureRef, lightRef, motionRef]);
  assert.deepEqual(result.readings[0].enum, { key: "zero", name: "Ноль" });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.readings[2].error.retryable, true);
  await reader.close();
  assert.equal(client.closed, true);
});

test("the reader rejects a mixed-home selection before contacting SprutHub", async () => {
  const client = new FakeClient(new Map());
  const reader = createSprutHubReader({
    connection: {
      secrets: [],
      async getClient() {
        return client;
      },
    },
  });

  await assert.rejects(
    reader.read({
      homeRef,
      readings: [
        {
          ref: "spruthub://hub/other/accessory/1/service/2/characteristic/3",
          label: "Чужой дом",
        },
      ],
    }),
    (error) => error.code === "invalid_selection",
  );
  assert.deepEqual(client.requested, []);
});

test("the local screen starts while its first SprutHub read is still pending", async (t) => {
  let finishRead;
  const reader = {
    read() {
      return new Promise((resolve) => {
        finishRead = resolve;
      });
    },
    async close() {},
  };
  const app = await createDashboardServer({
    reader,
    config: {
      title: "Дом",
      home_ref: homeRef,
      readings: [{ ref: lightRef, label: "Лампа" }],
    },
    host: "127.0.0.1",
    port: 0,
  });
  t.after(() => app.close());

  const firstStart = app.start();
  const startedBeforeRead = await Promise.race([
    firstStart,
    new Promise((resolve) => setTimeout(() => resolve(null), 100)),
  ]);
  finishRead({
    status: "ok",
    readings: [
      {
        ref: lightRef,
        label: "Лампа",
        status: "ok",
        value: false,
        unit: null,
        enum: null,
        measured_at: null,
        observed_at: new Date().toISOString(),
        available: true,
      },
    ],
  });
  await firstStart;

  assert.notEqual(startedBeforeRead, null);
  const pending = await getJson(`${app.url}/api/readings`);
  assert.equal(["pending", "ok"].includes(pending.status), true);
});

test("the local HTTP screen keeps polling, exposes staleness, and recovers without a login", async (t) => {
  let now = Date.parse("2026-09-11T01:00:00.000Z");
  let light = false;
  let failed = false;
  let readCount = 0;
  const reader = {
    async read({ readings }) {
      readCount += 1;
      if (failed) {
        return {
          status: "degraded",
          readings: readings.map(({ ref, label }) => ({
            ref,
            label,
            status: "error",
            error: {
              code: "connection_closed",
              message: "The connection closed.",
              retryable: true,
              action: "retry",
            },
          })),
        };
      }
      return {
        status: "ok",
        readings: readings.map(({ ref, label }) => ({
          ref,
          label,
          status: "ok",
          value: light,
          unit: null,
          enum: null,
          measured_at: null,
          observed_at: new Date(now).toISOString(),
          available: true,
        })),
      };
    },
    async close() {},
  };
  const app = await createDashboardServer({
    reader,
    config: {
      title: "Дом",
      home_ref: homeRef,
      readings: [{ ref: lightRef, label: "Лампа <script>bad()</script>" }],
    },
    now: () => now,
    pollIntervalMs: 20,
    staleAfterMs: 30_000,
    host: "127.0.0.1",
    port: 0,
  });
  t.after(() => app.close());

  await app.start();
  const first = await waitFor(async () => {
    const state = await getJson(`${app.url}/api/readings`);
    return state.readings[0]?.value === false ? state : null;
  }, "initial false reading");
  assert.equal(first.readings[0].stale, false);
  assert.equal(first.readings[0].last_success_at, "2026-09-11T01:00:00.000Z");

  light = true;
  now += 5_000;
  const changed = await waitFor(async () => {
    const state = await getJson(`${app.url}/api/readings`);
    return state.readings[0]?.value === true ? state : null;
  }, "changed reading");
  assert.equal(changed.readings[0].last_success_at, "2026-09-11T01:00:05.000Z");

  now += 1_000;
  const unchanged = await waitFor(async () => {
    const state = await getJson(`${app.url}/api/readings`);
    return state.readings[0]?.last_success_at === "2026-09-11T01:00:06.000Z"
      ? state
      : null;
  }, "unchanged fresh reading");
  assert.equal(unchanged.readings[0].value, true);

  failed = true;
  const unavailable = await waitFor(async () => {
    const state = await getJson(`${app.url}/api/readings`);
    return state.readings[0]?.status === "error" ? state : null;
  }, "source failure");
  assert.equal(unavailable.readings[0].value, true);
  assert.equal(unavailable.readings[0].stale, false);

  now += 31_000;
  const stale = await getJson(`${app.url}/api/readings`);
  assert.equal(stale.readings[0].stale, true);
  assert.equal(stale.readings[0].last_success_at, "2026-09-11T01:00:06.000Z");

  failed = false;
  now += 1_000;
  const recovered = await waitFor(async () => {
    const state = await getJson(`${app.url}/api/readings`);
    return state.readings[0]?.status === "ok" ? state : null;
  }, "recovered reading");
  assert.equal(recovered.readings[0].stale, false);
  assert.equal(
    recovered.readings[0].last_success_at,
    "2026-09-11T01:00:38.000Z",
  );
  assert.equal(readCount >= 4, true);

  const page = await fetch(app.url).then((response) => response.text());
  assert.equal(page.includes("<script>bad()</script>"), false);
});

test("the local screen presents household values and one shared connection failure", async (t) => {
  let connectionLost = false;
  const reader = {
    async read({ readings }) {
      if (connectionLost) {
        return {
          status: "error",
          readings: readings.map(({ ref, label }) => ({
            ref,
            label,
            status: "error",
            error: {
              code: "connection_closed",
              message:
                "The SprutHub connection closed before the response arrived.",
              retryable: true,
              action: "retry",
            },
          })),
        };
      }
      return {
        status: "ok",
        readings: readings.map(({ ref, label }) => ({
          ref,
          label,
          status: "ok",
          value: ref === temperatureRef ? 0 : false,
          unit: ref === temperatureRef ? "celsius" : null,
          enum: null,
          measured_at: null,
          observed_at: "2026-09-11T01:00:00.000Z",
          available: true,
        })),
      };
    },
    async close() {},
  };
  const app = await createDashboardServer({
    reader,
    config: {
      title: "Дом",
      home_ref: homeRef,
      readings: [
        { ref: temperatureRef, label: "Температура" },
        { ref: lightRef, label: "Лампа" },
      ],
    },
    pollIntervalMs: 20,
    host: "127.0.0.1",
    port: 0,
  });
  t.after(() => app.close());
  await app.start();

  const fresh = await waitFor(async () => {
    const state = await getJson(`${app.url}/api/readings`);
    return state.status === "ok" ? state : null;
  }, "presented readings");
  assert.deepEqual(
    fresh.readings.map(({ display_value, display_unit }) => ({
      display_value,
      display_unit,
    })),
    [
      { display_value: "0", display_unit: "°C" },
      { display_value: "Нет", display_unit: null },
    ],
  );

  connectionLost = true;
  const disconnected = await waitFor(async () => {
    const state = await getJson(`${app.url}/api/readings`);
    return state.connection_lost ? state : null;
  }, "shared connection failure");
  assert.equal(disconnected.message, "Связь с домом потеряна");
  assert.deepEqual(
    disconnected.readings.map(({ display_status }) => display_status),
    [null, null],
  );
  assert.equal(
    JSON.stringify(disconnected).includes(
      "The SprutHub connection closed before the response arrived.",
    ),
    true,
  );
});

function characteristic(ref, name, value, unit, validValues = []) {
  return {
    status: "ok",
    entity: {
      kind: "characteristic",
      ref,
      name,
      available: true,
      current_value: {
        value,
        source: "characteristic",
        source_timestamp: null,
      },
      capabilities: { read: true, unit, valid_values: validValues },
    },
    freshness: {
      hubResponseReceivedAt: "2026-09-11T01:00:00.000Z",
      measurementAt: null,
    },
  };
}

class FakeClient {
  constructor(results) {
    this.results = results;
    this.requested = [];
    this.closed = false;
  }

  async getEntity(ref) {
    this.requested.push(ref);
    const result = this.results.get(ref);
    if (result instanceof Error) throw result;
    return result;
  }

  async close() {
    this.closed = true;
  }
}

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitFor(operation, description) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}.`);
}
