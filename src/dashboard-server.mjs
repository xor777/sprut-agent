import { createServer } from "node:http";
import { validateReadSelection } from "./read-selection.mjs";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const CONNECTION_ERROR_CODES = new Set([
  "connection_closed",
  "connection_failed",
  "timeout",
]);

export async function createDashboardServer({
  reader,
  config,
  host = "127.0.0.1",
  port = 4173,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  now = Date.now,
  instanceId = null,
}) {
  validateConfig(config);
  validateDuration(pollIntervalMs, "pollIntervalMs");
  validateDuration(staleAfterMs, "staleAfterMs");
  const startedAt = now();
  let closed = false;
  let timer;
  let url;
  let snapshot = {
    title: config.title,
    status: "pending",
    poll_interval_ms: pollIntervalMs,
    stale_after_ms: staleAfterMs,
    readings: config.readings.map(({ ref, label }) => ({
      ref,
      label,
      status: "pending",
      last_success_at: null,
    })),
  };

  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    if (request.url === "/api/readings") {
      sendJson(
        response,
        currentSnapshot(snapshot, now(), startedAt, staleAfterMs),
      );
      return;
    }
    if (request.url === "/health") {
      sendJson(response, {
        product: "sprut-agent-dashboard",
        status: "ok",
        instance_id: instanceId,
      });
      return;
    }
    if (request.url === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(PAGE);
      return;
    }
    response.writeHead(404).end();
  });

  async function poll() {
    if (closed) return;
    try {
      const result = await reader.read({
        homeRef: config.home_ref,
        readings: config.readings,
      });
      snapshot = mergeSnapshot(snapshot, result);
    } catch {
      snapshot = mergeSnapshot(snapshot, {
        status: "error",
        readings: config.readings.map(({ ref, label }) => ({
          ref,
          label,
          status: "error",
          error: {
            code: "reader_failed",
            message: "Could not read SprutHub.",
            retryable: false,
          },
        })),
      });
    } finally {
      if (!closed) timer = setTimeout(poll, pollIntervalMs);
    }
  }

  return {
    get url() {
      return url;
    },
    async start() {
      if (url) return url;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      url = `http://${host}:${address.port}`;
      void poll();
      return url;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      await Promise.all([
        reader.close(),
        server.listening
          ? new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            )
          : undefined,
      ]);
    },
  };
}

function mergeSnapshot(previous, result) {
  const priorByRef = new Map(
    previous.readings.map((reading) => [reading.ref, reading]),
  );
  return {
    ...previous,
    status: result.status,
    readings: result.readings.map((reading) => {
      const prior = priorByRef.get(reading.ref) ?? {};
      if (reading.status === "ok" || reading.status === "unavailable") {
        return { ...reading, last_success_at: reading.observed_at };
      }
      return {
        ...prior,
        ref: reading.ref,
        label: reading.label,
        status: reading.status,
        error: reading.error,
      };
    }),
  };
}

function currentSnapshot(snapshot, currentTime, startedAt, staleAfterMs) {
  const readings = snapshot.readings.map((reading) => ({
    ...reading,
    stale:
      currentTime -
        (reading.last_success_at
          ? Date.parse(reading.last_success_at)
          : startedAt) >
      staleAfterMs,
  }));
  const connectionLost =
    snapshot.status === "error" &&
    readings.length > 0 &&
    readings.every(
      (reading) =>
        reading.status === "error" &&
        CONNECTION_ERROR_CODES.has(reading.error?.code),
    );
  const hasUnavailableReadings = readings.some(
    (reading) => reading.status !== "ok",
  );
  return {
    ...snapshot,
    served_at: new Date(currentTime).toISOString(),
    connection_lost: connectionLost,
    message:
      snapshot.status === "pending"
        ? "Подключение…"
        : connectionLost
          ? "Связь с домом потеряна"
          : snapshot.status === "ok" && !hasUnavailableReadings
            ? "Данные обновляются"
            : "Есть недоступные данные",
    readings: readings.map((reading) => ({
      ...reading,
      display_value: displayValue(reading),
      display_unit: displayUnit(reading.unit),
      display_status:
        reading.status === "unavailable"
          ? "Источник недоступен"
          : reading.status === "error" && !connectionLost
            ? "Не удалось прочитать источник"
            : null,
    })),
  };
}

function displayValue(reading) {
  if (reading.enum?.name) return reading.enum.name;
  if (reading.value === null || reading.value === undefined) return "—";
  if (typeof reading.value === "boolean") {
    if (reading.type === "On") {
      return reading.value ? "Включено" : "Выключено";
    }
    if (reading.type === "MotionDetected") {
      return reading.value ? "Есть движение" : "Движения нет";
    }
    return reading.value ? "Да" : "Нет";
  }
  return String(reading.value);
}

function displayUnit(unit) {
  return unit?.toLowerCase() === "celsius" ? "°C" : (unit ?? null);
}

function validateConfig(config) {
  if (
    !config ||
    typeof config.title !== "string" ||
    config.title.length === 0 ||
    typeof config.home_ref !== "string" ||
    !Array.isArray(config.readings) ||
    config.readings.length === 0
  ) {
    throw new TypeError(
      "Dashboard config needs title, home_ref, and readings.",
    );
  }
  validateReadSelection({
    homeRef: config.home_ref,
    readings: config.readings,
  });
}

function validateDuration(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
}

function sendJson(response, value) {
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

const PAGE = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SprutHub</title>
  <style>
    :root { color-scheme: light dark; font: 16px system-ui, sans-serif; }
    body { max-width: 56rem; margin: 3rem auto; padding: 0 1rem; }
    header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
    #status { color: #687076; }
    main { display: grid; grid-template-columns: repeat(auto-fit,minmax(14rem,1fr)); gap: 1rem; }
    article { border: 1px solid #8886; border-radius: .75rem; padding: 1rem; }
    .value { font-size: 2rem; margin: .5rem 0; }
    .error, .stale { color: #c33; }
  </style>
</head>
<body>
  <header><h1 id="title">Дом</h1><p id="status">Подключение…</p></header>
  <main id="readings"></main>
  <script>
    const title = document.querySelector('#title');
    const status = document.querySelector('#status');
    const readings = document.querySelector('#readings');
    let lastPayload;
    function text(parent, tag, value, className) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = value;
      parent.append(node);
    }
    function render(payload) {
      lastPayload = payload;
      title.textContent = payload.title;
      status.className = '';
      status.textContent = payload.message;
      readings.replaceChildren();
      for (const reading of payload.readings) {
        const card = document.createElement('article');
        text(card, 'h2', reading.label);
        text(card, 'p', reading.display_value + (reading.display_unit ? ' ' + reading.display_unit : ''), 'value');
        if (reading.display_status) text(card, 'p', reading.display_status, 'error');
        if (reading.stale) text(card, 'p', 'Данные устарели', 'stale');
        text(card, 'p', reading.last_success_at ? 'Успешно прочитано: ' + new Date(reading.last_success_at).toLocaleString() : 'Успешных чтений ещё нет');
        readings.append(card);
      }
    }
    async function refresh() {
      try {
        const response = await fetch('/api/readings', { cache: 'no-store' });
        if (!response.ok) throw new Error('http');
        render(await response.json());
      } catch {
        status.textContent = 'Локальный процесс недоступен';
        status.className = 'error';
        if (lastPayload) {
          const failed = structuredClone(lastPayload);
          failed.status = 'error';
          failed.readings = failed.readings.map((reading) => ({ ...reading, stale: true, status: 'error', error: { message: 'Локальный процесс недоступен' } }));
          render(failed);
          status.textContent = 'Локальный процесс недоступен';
          status.className = 'error';
        }
      }
    }
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
