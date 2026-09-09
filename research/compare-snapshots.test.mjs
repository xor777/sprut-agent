import assert from "node:assert/strict";
import test from "node:test";

import { compareContracts } from "./compare-snapshots.mjs";

function snapshot({
  version = "1.0.0",
  assetHash = "asset-a",
  operations = [],
  messages = [],
  enums = [],
  protoFiles = {},
  scenarioSchemas = {},
} = {}) {
  return {
    manifest: {
      webClient: { version, build: `${version}-build` },
      protobuf: { sha256: `proto-${version}` },
      scenarioSchemas: { sha256: `scenario-${version}` },
      assets: [
        {
          url: `https://example.test/js/app.12345678.js`,
          sha256: assetHash,
        },
      ],
    },
    methods: { operations },
    types: { messages, enums },
    protoFiles,
    scenarioSchemas,
  };
}

const listOperation = {
  endpoint: "room.list",
  domain: "room",
  operation: "list",
  requestType: "RoomListRequest",
  responseType: "RoomsMessage",
  requestFieldNumber: 1,
  responseFieldNumber: 1,
  risk: "R0-read",
};

const roomMessage = {
  name: "RoomMessage",
  fields: [
    {
      name: "id",
      number: 1,
      type: "uint32",
      label: "optional",
      oneof: null,
      deprecated: false,
      options: null,
    },
  ],
};

test("identical snapshots are unchanged", () => {
  const value = snapshot({
    operations: [listOperation],
    messages: [roomMessage],
    protoFiles: { "Room.proto": "same" },
  });
  const report = compareContracts(value, structuredClone(value));

  assert.equal(report.verdict, "unchanged");
  assert.deepEqual(report.summary, {
    breaking: 0,
    review: 0,
    additive: 0,
    behavioralUnknown: 0,
  });
});

test("wire contract removals and field changes block promotion", () => {
  const before = snapshot({
    operations: [listOperation],
    messages: [roomMessage],
  });
  const after = snapshot({
    version: "1.1.0",
    operations: [],
    messages: [
      {
        name: "RoomMessage",
        fields: [
          {
            ...roomMessage.fields[0],
            type: "string",
          },
        ],
      },
    ],
  });
  const report = compareContracts(before, after);

  assert.equal(report.verdict, "blocked");
  assert.ok(
    report.breaking.some(
      ({ kind, target }) =>
        kind === "operation-removed" && target === "room.list",
    ),
  );
  assert.ok(
    report.breaking.some(
      ({ kind, target }) =>
        kind === "field-wire-contract-changed" &&
        target === "RoomMessage.id",
    ),
  );
});

test("optional fields and operations are additive", () => {
  const before = snapshot({ assetHash: "same" });
  const after = snapshot({
    assetHash: "same",
    operations: [listOperation],
    messages: [roomMessage],
  });
  const report = compareContracts(before, after);

  assert.equal(report.verdict, "compatible-additive");
  assert.equal(report.summary.additive, 2);
});

test("new enum values require review and reused numbers are breaking", () => {
  const base = {
    name: "State",
    values: [
      {
        name: "UNKNOWN",
        number: 0,
        deprecated: false,
        options: null,
      },
    ],
  };
  const review = compareContracts(
    snapshot({ enums: [base], assetHash: "same" }),
    snapshot({
      enums: [
        {
          ...base,
          values: [
            ...base.values,
            {
              name: "ACTIVE",
              number: 1,
              deprecated: false,
              options: null,
            },
          ],
        },
      ],
      assetHash: "same",
    }),
  );
  assert.equal(review.verdict, "review");
  assert.equal(review.review[0].kind, "enum-value-added");

  const blocked = compareContracts(
    snapshot({ enums: [base], assetHash: "same" }),
    snapshot({
      enums: [
        {
          ...base,
          values: [
            {
              name: "OTHER",
              number: 0,
              deprecated: false,
              options: null,
            },
          ],
        },
      ],
      assetHash: "same",
    }),
  );
  assert.equal(blocked.verdict, "blocked");
  assert.ok(
    blocked.breaking.some(({ kind }) => kind === "enum-number-reused"),
  );
});

test("client code changes stay visible when schemas do not change", () => {
  const report = compareContracts(
    snapshot({ assetHash: "old" }),
    snapshot({ version: "1.0.1", assetHash: "new" }),
  );

  assert.equal(report.verdict, "review");
  assert.equal(report.behavioralUnknown[0].kind, "client-asset-changed");
});

test("scenario schema edits are quarantined for semantic review", () => {
  const report = compareContracts(
    snapshot({
      assetHash: "same",
      scenarioSchemas: { "condition.schema.json": "old" },
    }),
    snapshot({
      assetHash: "same",
      scenarioSchemas: { "condition.schema.json": "new" },
    }),
  );

  assert.equal(report.verdict, "review");
  assert.equal(report.review[0].kind, "scenario-schema-changed");
});
