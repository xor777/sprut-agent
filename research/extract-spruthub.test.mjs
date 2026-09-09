import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyRisk,
  decodeJsString,
  extractJsonSchemas,
  extractProtoModules,
  parseDomainContracts,
  parseProtoTypes,
  selectSnapshotDirectory,
  snapshotFingerprint,
} from "./extract-spruthub.mjs";

test("decodeJsString decodes common escapes without evaluating code", () => {
  assert.equal(
    decodeJsString(String.raw`line\nquote\'\u0021`),
    "line\nquote'!",
  );
});

test("extractProtoModules restores a protobuf module and infers its filename", () => {
  const bundle = String.raw`
    42:e=>{e.exports='syntax = "proto3";\noption java_outer_classname = "StoreProto";\nmessage BundleRequest {\n  oneof kind {\n    BundleListRequest list = 1;\n  }\n}\nmessage BundleResponse {\n  oneof kind {\n    BundleListResponse list = 1;\n  }\n}\n'}
  `;

  const modules = extractProtoModules(bundle);
  assert.equal(modules.length, 1);
  assert.equal(modules[0].filename, "Bundle.proto");
});

test("parseDomainContracts maps request and response oneof fields", () => {
  const body = `
    syntax = "proto3";
    message RoomRequest {
      oneof kind {
        RoomListRequest list = 1;
        RoomUpdateRequest update = 5;
      }
    }
    message RoomResponse {
      oneof kind {
        RoomsMessage list = 2;
        EmptyResponse update = 10;
      }
    }
  `;

  const operations = parseDomainContracts([{ filename: "Room.proto", body }]);

  assert.deepEqual(
    operations.map((operation) => ({
      endpoint: operation.endpoint,
      requestType: operation.requestType,
      responseType: operation.responseType,
    })),
    [
      {
        endpoint: "room.list",
        requestType: "RoomListRequest",
        responseType: "RoomsMessage",
      },
      {
        endpoint: "room.update",
        requestType: "RoomUpdateRequest",
        responseType: "EmptyResponse",
      },
    ],
  );
});

test("risk classification is conservative for writes", () => {
  assert.equal(classifyRisk("room", "list"), "R0-read");
  assert.equal(classifyRisk("characteristic", "update"), "R2-reversible");
  assert.equal(classifyRisk("scenario", "run"), "R4-impact");
  assert.equal(classifyRisk("room", "update"), "R3-configuration");
});

test("parseProtoTypes records fields, oneof, maps and deprecations", () => {
  const body = `
    syntax = "proto3";
    message Example {
      optional string name = 1;
      repeated uint32 ids = 2;
      map<string, string> params = 3;
      oneof value {
        bool boolValue = 4;
        string oldValue = 5 [deprecated = true];
      }
    }
    enum State {
      UNKNOWN = 0;
      ACTIVE = 1;
    }
  `;

  const types = parseProtoTypes([{ filename: "Example.proto", body }]);
  assert.deepEqual(types.messages[0].fields, [
    {
      name: "name",
      number: 1,
      type: "string",
      label: "optional",
      oneof: null,
      deprecated: false,
      options: null,
    },
    {
      name: "ids",
      number: 2,
      type: "uint32",
      label: "repeated",
      oneof: null,
      deprecated: false,
      options: null,
    },
    {
      name: "params",
      number: 3,
      type: "map<string,string>",
      label: null,
      oneof: null,
      deprecated: false,
      options: null,
    },
    {
      name: "boolValue",
      number: 4,
      type: "bool",
      label: null,
      oneof: "value",
      deprecated: false,
      options: null,
    },
    {
      name: "oldValue",
      number: 5,
      type: "string",
      label: null,
      oneof: "value",
      deprecated: true,
      options: "deprecated = true",
    },
  ]);
  assert.deepEqual(
    types.enums[0].values.map(({ name, number }) => ({ name, number })),
    [
      { name: "UNKNOWN", number: 0 },
      { name: "ACTIVE", number: 1 },
    ],
  );
});

test("extractJsonSchemas parses embedded scenario schemas without eval", () => {
  const bundle = `
    const schemas=[
      {$id:"http://makesimple.org/schema/example",type:"object",
       properties:{enabled:{type:"boolean"},mode:{enum:["A","B"]}},
       required:["enabled"],additionalProperties:!1}
    ];
  `;

  const schemas = extractJsonSchemas(bundle);
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0].filename, "example.schema.json");
  assert.deepEqual(schemas[0].schema, {
    $id: "http://makesimple.org/schema/example",
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      mode: { enum: ["A", "B"] },
    },
    required: ["enabled"],
    additionalProperties: false,
  });
});

test("snapshot selection preserves an existing version across hotfix builds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sprut-snapshot-test-"));
  const manifest = {
    extractorVersion: 1,
    webClient: { version: "1.2.3", build: "build-a" },
    assets: [{ url: "https://example.test/app.js", sha256: "asset-a" }],
    protobuf: { sha256: "proto-a" },
    scenarioSchemas: { sha256: "schema-a" },
  };

  try {
    const initial = await selectSnapshotDirectory(root, "1.2.3", manifest);
    assert.equal(initial.directory, path.join(root, "1.2.3"));
    assert.equal(initial.reused, false);

    await mkdir(path.join(initial.directory, "proto"), { recursive: true });
    await mkdir(path.join(initial.directory, "scenario-schemas"), {
      recursive: true,
    });
    await Promise.all([
      writeFile(
        path.join(initial.directory, "manifest.json"),
        JSON.stringify(manifest),
      ),
      writeFile(path.join(initial.directory, "methods.generated.json"), "{}"),
      writeFile(path.join(initial.directory, "types.generated.json"), "{}"),
      writeFile(path.join(initial.directory, "hashes.txt"), ""),
    ]);

    const unchanged = await selectSnapshotDirectory(root, "1.2.3", manifest);
    assert.equal(unchanged.directory, initial.directory);
    assert.equal(unchanged.reused, true);

    const hotfixManifest = {
      ...manifest,
      webClient: { version: "1.2.3", build: "build-b" },
      assets: [{ url: "https://example.test/app.js", sha256: "asset-b" }],
    };
    const hotfix = await selectSnapshotDirectory(root, "1.2.3", hotfixManifest);
    assert.equal(
      hotfix.directory,
      path.join(
        root,
        `1.2.3+${snapshotFingerprint(hotfixManifest).slice(0, 12)}`,
      ),
    );
    assert.equal(hotfix.reused, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
