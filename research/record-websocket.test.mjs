import assert from "node:assert/strict";
import test from "node:test";

import { selectTarget, toFrameRecord } from "./record-websocket.mjs";

test("selectTarget chooses a debuggable page on the requested origin", () => {
  const target = selectTarget(
    [
      {
        type: "page",
        url: "https://example.com/",
        webSocketDebuggerUrl: "ws://127.0.0.1/example",
      },
      {
        type: "page",
        url: "https://beta.spruthub.ru/controllers",
        webSocketDebuggerUrl: "ws://127.0.0.1/sprut",
      },
    ],
    "https://beta.spruthub.ru/",
  );

  assert.equal(target.webSocketDebuggerUrl, "ws://127.0.0.1/sprut");
});

test("toFrameRecord ignores unrelated sockets", () => {
  const record = toFrameRecord(
    {
      method: "Network.webSocketFrameReceived",
      params: {
        requestId: "unknown",
        response: { opcode: 1, payloadData: "{}" },
      },
    },
    new Map(),
  );

  assert.equal(record, null);
});

test("toFrameRecord preserves direction and wire payload", () => {
  const record = toFrameRecord(
    {
      method: "Network.webSocketFrameSent",
      params: {
        requestId: "socket-1",
        response: { opcode: 1, payloadData: '{"id":1}' },
      },
    },
    new Map([
      [
        "socket-1",
        {
          url: "wss://beta.spruthub.ru/spruthub",
          subprotocol: "json-rpc",
        },
      ],
    ]),
    new Date("2026-07-27T12:00:00.000Z"),
  );

  assert.deepEqual(record, {
    capturedAt: "2026-07-27T12:00:00.000Z",
    kind: "frame",
    direction: "sent",
    requestId: "socket-1",
    socketUrl: "wss://beta.spruthub.ru/spruthub",
    subprotocol: "json-rpc",
    opcode: 1,
    payloadData: '{"id":1}',
  });
});
