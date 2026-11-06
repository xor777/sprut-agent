import { AsyncLocalStorage } from "node:async_hooks";
import {
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { stateDirectory } from "./automation-store.mjs";

const MAX_LOG_BYTES = 1024 * 1024;
const STALE_LOCK_MS = 60_000;
const currentCall = new AsyncLocalStorage();

// The statuses that prove what a write tool was called for. Every other one is
// logged as an error under its own name: uncertain (the answer was lost),
// conflict (changed meanwhile), not_applied, not_owned, skipped, and restored
// when applying was asked. get_native_change only reads, and is not here.
const CONFIRMED_WRITE = {
  prepare_native_change: new Set(["prepared", "already_desired"]),
  apply_native_change: new Set(["applied", "completed", "superseded"]),
  // A completed pause has run out: nothing is left to undo.
  restore_native_change: new Set(["restored", "ok", "completed"]),
};
const SETTLED_ITEM = new Set(["applied", "already_desired", "restored"]);

// One line per tool call. It watches the MCP messages rather than the tool
// handlers: the SDK refuses invalid arguments before a handler runs, and those
// are the calls where an agent stumbles. Only the closed fields below are ever
// written: never arguments, refs, names, hub text or anything else of a reply.
//
// Call after server.connect(transport), which sets transport.onmessage.
export function logToolCalls(
  transport,
  { directory, version, toolNames, operations },
) {
  const file = () => path.join(stateDirectory(directory), "work-log.jsonl");
  const unfinished = new Map();

  function finish(id, outcome) {
    const call = unfinished.get(id);
    if (!call) return;
    unfinished.delete(id);
    // Nothing of the log may reach a tool's answer: not an error, not a throw.
    try {
      appendLine(
        file(),
        JSON.stringify({
          time: call.time,
          version,
          tool: call.tool,
          operation: call.operation,
          outcome: outcome.error_code ? "error" : "ok",
          error_code: outcome.error_code,
          hub_code: outcome.hub_code ?? call.hubCode,
          duration_ms: Math.round(performance.now() - call.startedAt),
          response_bytes: outcome.response_bytes ?? 0,
        }),
      );
    } catch {}
  }

  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (message.method === "notifications/cancelled") {
      // The SDK drops the reply of a cancelled call, so this is its only end.
      finish(message.params?.requestId, { error_code: "cancelled" });
    }
    if (message.method !== "tools/call") return receive(message, extra);
    const known = toolNames.has(message.params?.name);
    const operation = message.params?.arguments?.operation;
    const call = {
      time: new Date().toISOString(),
      startedAt: performance.now(),
      tool: known ? message.params.name : "unknown",
      operation: operations.includes(operation) ? operation : undefined,
      known,
    };
    unfinished.set(message.id, call);
    return currentCall.run(call, () => receive(message, extra));
  };

  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const call = message.method ? undefined : unfinished.get(message.id);
    if (call) {
      try {
        finish(message.id, callOutcome(message, call));
      } catch {}
    }
    return send(message, options);
  };

  // The client left while these were under way.
  return function finishUnfinished() {
    for (const id of [...unfinished.keys()]) {
      finish(id, { error_code: "interrupted" });
    }
  };
}

// A hub's refusal the answer does not carry, from the running tool call.
export function noteHubRefusal(error) {
  const call = currentCall.getStore();
  if (!call) return;
  call.hubCode = hubCode(error?.hubError?.code ?? error?.protocolErrorCode);
}

function callOutcome(message, call) {
  if (message.error) return { error_code: "protocol_error" };
  const { result } = message;
  const data = result?.structuredContent;
  const response_bytes = (result?.content ?? []).reduce(
    (total, part) =>
      total + (part.type === "text" ? Buffer.byteLength(part.text) : 0),
    0,
  );
  if (!call.known) return { error_code: "unknown_tool", response_bytes };
  if (result?.isError) {
    return {
      // Without our own error shape it is the SDK refusing the arguments.
      error_code: errorCode(data?.error?.code ?? "invalid_arguments"),
      hub_code: hubCode(
        data?.rejection?.protocol_code ?? data?.native_error_code,
      ),
      response_bytes,
    };
  }
  // A batch answers normally and reports what failed in its items.
  if (data?.status === "incomplete") {
    const failed = data.results?.find((item) => item.error);
    const unsettled = data.results?.find(
      (item) => !SETTLED_ITEM.has(item.status),
    );
    return {
      error_code: errorCode(
        failed?.error.code ?? unsettled?.status ?? "incomplete",
      ),
      hub_code: hubCode(failed?.rejection?.protocol_code),
      response_bytes,
    };
  }
  // These answer normally too when the write is not confirmed. An undo that
  // skips a change keeps the change's own status beside restore_outcome.
  const confirmed = CONFIRMED_WRITE[call.tool];
  const status = data?.restore_outcome?.status ?? data?.status;
  if (confirmed && !confirmed.has(status)) {
    return { error_code: errorCode(status), response_bytes };
  }
  return { response_bytes };
}

function errorCode(code) {
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code)
    ? code
    : "other_error";
}

function hubCode(code) {
  return typeof code === "number" ? code : undefined;
}

// Synchronous, so a line is not lost when the process exits right after a
// reply; a local append takes a fraction of a millisecond and a failure is
// immediate. One write of one line to an O_APPEND file: processes sharing the
// file do not mix their lines.
function appendLine(file, line) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // A rotation that fails leaves the line for the file as it is.
  try {
    rotateIfFull(file);
  } catch {}
  const descriptor = openSync(file, "a", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, `${line}\n`);
  } finally {
    closeSync(descriptor);
  }
}

// Without the lock, parallel servers that saw the same full file also rename
// the new one over the previous file: measured on four servers, 1 MB became
// two lines. A lock left by a process that died here must not stop rotation.
function rotateIfFull(file) {
  if (!isFull(file)) return;
  const lock = `${file}.lock`;
  try {
    closeSync(openSync(lock, "wx", 0o600));
  } catch (error) {
    if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
    throw error;
  }
  try {
    if (isFull(file)) renameSync(file, `${file}.1`);
  } finally {
    unlinkSync(lock);
  }
}

function isFull(file) {
  return statSync(file, { throwIfNoEntry: false })?.size >= MAX_LOG_BYTES;
}
