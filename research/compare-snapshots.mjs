#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CATEGORY_ORDER = [
  "breaking",
  "review",
  "additive",
  "behavioralUnknown",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function assetRole(url) {
  const parsed = new URL(url);
  return parsed.pathname
    .split("/")
    .at(-1)
    .replace(/\.[a-f0-9]{8,}(?=\.)/iu, "");
}

function byName(values, key = "name") {
  return new Map(values.map((value) => [value[key], value]));
}

function add(result, category, kind, target, details = {}) {
  result[category].push({
    kind,
    target,
    ...details,
  });
}

function compareOperations(result, fromOperations, toOperations) {
  const before = byName(fromOperations, "endpoint");
  const after = byName(toOperations, "endpoint");

  for (const [endpoint, operation] of before) {
    const current = after.get(endpoint);
    if (!current) {
      add(result, "breaking", "operation-removed", endpoint, {
        before: operation,
      });
      continue;
    }

    const contractFields = [
      "domain",
      "operation",
      "requestType",
      "responseType",
      "requestFieldNumber",
      "responseFieldNumber",
    ];
    const changes = contractFields
      .filter((field) => !same(operation[field], current[field]))
      .map((field) => ({
        field,
        before: operation[field],
        after: current[field],
      }));
    if (changes.length > 0) {
      add(result, "breaking", "operation-contract-changed", endpoint, {
        changes,
      });
    }

    if (operation.risk !== current.risk) {
      add(result, "review", "operation-risk-changed", endpoint, {
        before: operation.risk,
        after: current.risk,
      });
    }
  }

  for (const [endpoint, operation] of after) {
    if (!before.has(endpoint)) {
      add(result, "additive", "operation-added", endpoint, {
        after: operation,
      });
    }
  }
}

function compareFields(result, messageName, beforeFields, afterFields) {
  const before = byName(beforeFields);
  const after = byName(afterFields);
  const beforeNumbers = new Map(
    beforeFields.map((field) => [field.number, field.name]),
  );

  for (const [fieldName, field] of before) {
    const target = `${messageName}.${fieldName}`;
    const current = after.get(fieldName);
    if (!current) {
      add(result, "breaking", "field-removed", target, { before: field });
      continue;
    }

    const wireFields = ["number", "type", "label", "oneof"];
    const changes = wireFields
      .filter((key) => !same(field[key], current[key]))
      .map((key) => ({
        field: key,
        before: field[key],
        after: current[key],
      }));
    if (changes.length > 0) {
      add(result, "breaking", "field-wire-contract-changed", target, {
        changes,
      });
    }

    if (
      field.deprecated !== current.deprecated ||
      field.options !== current.options
    ) {
      add(result, "review", "field-options-changed", target, {
        before: {
          deprecated: field.deprecated,
          options: field.options,
        },
        after: {
          deprecated: current.deprecated,
          options: current.options,
        },
      });
    }
  }

  for (const [fieldName, field] of after) {
    if (before.has(fieldName)) {
      continue;
    }
    const target = `${messageName}.${fieldName}`;
    const previousName = beforeNumbers.get(field.number);
    if (previousName) {
      add(result, "breaking", "field-number-reused", target, {
        number: field.number,
        previousField: previousName,
        after: field,
      });
      continue;
    }
    if (field.label === "required") {
      add(result, "breaking", "required-field-added", target, {
        after: field,
      });
      continue;
    }
    add(result, "additive", "field-added", target, { after: field });
  }
}

function compareMessages(result, fromMessages, toMessages) {
  const before = byName(fromMessages);
  const after = byName(toMessages);

  for (const [messageName, message] of before) {
    const current = after.get(messageName);
    if (!current) {
      add(result, "breaking", "message-removed", messageName, {
        before: message,
      });
      continue;
    }
    compareFields(result, messageName, message.fields, current.fields);
  }

  for (const [messageName, message] of after) {
    if (!before.has(messageName)) {
      add(result, "additive", "message-added", messageName, {
        after: message,
      });
    }
  }
}

function compareEnums(result, fromEnums, toEnums) {
  const before = byName(fromEnums);
  const after = byName(toEnums);

  for (const [enumName, enumeration] of before) {
    const current = after.get(enumName);
    if (!current) {
      add(result, "breaking", "enum-removed", enumName, {
        before: enumeration,
      });
      continue;
    }

    const beforeValues = byName(enumeration.values);
    const afterValues = byName(current.values);
    const beforeNumbers = new Map(
      enumeration.values.map((value) => [value.number, value.name]),
    );

    for (const [valueName, value] of beforeValues) {
      const target = `${enumName}.${valueName}`;
      const currentValue = afterValues.get(valueName);
      if (!currentValue) {
        add(result, "breaking", "enum-value-removed", target, {
          before: value,
        });
        continue;
      }
      if (value.number !== currentValue.number) {
        add(result, "breaking", "enum-value-renumbered", target, {
          before: value.number,
          after: currentValue.number,
        });
      }
      if (
        value.deprecated !== currentValue.deprecated ||
        value.options !== currentValue.options
      ) {
        add(result, "review", "enum-value-options-changed", target, {
          before: {
            deprecated: value.deprecated,
            options: value.options,
          },
          after: {
            deprecated: currentValue.deprecated,
            options: currentValue.options,
          },
        });
      }
    }

    for (const [valueName, value] of afterValues) {
      if (beforeValues.has(valueName)) {
        continue;
      }
      const target = `${enumName}.${valueName}`;
      const previousName = beforeNumbers.get(value.number);
      if (previousName) {
        add(result, "breaking", "enum-number-reused", target, {
          number: value.number,
          previousValue: previousName,
          after: value,
        });
      } else {
        add(result, "review", "enum-value-added", target, {
          after: value,
          reason: "Wire-compatible, but exhaustive consumers may reject it.",
        });
      }
    }
  }

  for (const [enumName, enumeration] of after) {
    if (!before.has(enumName)) {
      add(result, "additive", "enum-added", enumName, {
        after: enumeration,
      });
    }
  }
}

function compareNamedHashes(result, kind, before, after) {
  for (const [name, hash] of Object.entries(before)) {
    if (!(name in after)) {
      add(result, "review", `${kind}-removed`, name, { before: hash });
    } else if (hash !== after[name]) {
      add(result, "review", `${kind}-changed`, name, {
        before: hash,
        after: after[name],
      });
    }
  }

  for (const [name, hash] of Object.entries(after)) {
    if (!(name in before)) {
      add(result, "additive", `${kind}-added`, name, { after: hash });
    }
  }
}

function compareAssets(result, fromAssets, toAssets) {
  const before = new Map(
    fromAssets.map((asset) => [assetRole(asset.url), asset]),
  );
  const after = new Map(toAssets.map((asset) => [assetRole(asset.url), asset]));

  for (const [role, asset] of before) {
    const current = after.get(role);
    if (!current) {
      add(result, "behavioralUnknown", "client-asset-removed", role, {
        before: asset.sha256,
      });
    } else if (asset.sha256 !== current.sha256) {
      add(result, "behavioralUnknown", "client-asset-changed", role, {
        before: asset.sha256,
        after: current.sha256,
        reason:
          "Static schemas cannot prove that request sequencing or semantics stayed unchanged.",
      });
    }
  }

  for (const [role, asset] of after) {
    if (!before.has(role)) {
      add(result, "behavioralUnknown", "client-asset-added", role, {
        after: asset.sha256,
      });
    }
  }
}

function versionOf(snapshot) {
  return {
    version: snapshot.manifest.webClient?.version ?? null,
    build: snapshot.manifest.webClient?.build ?? null,
    protobufSha256: snapshot.manifest.protobuf?.sha256 ?? null,
    scenarioSchemasSha256:
      snapshot.manifest.scenarioSchemas?.sha256 ?? null,
  };
}

export function compareContracts(fromSnapshot, toSnapshot) {
  const result = {
    formatVersion: 1,
    from: versionOf(fromSnapshot),
    to: versionOf(toSnapshot),
    verdict: "unchanged",
    summary: {},
    breaking: [],
    review: [],
    additive: [],
    behavioralUnknown: [],
  };

  compareOperations(
    result,
    fromSnapshot.methods.operations,
    toSnapshot.methods.operations,
  );
  compareMessages(
    result,
    fromSnapshot.types.messages,
    toSnapshot.types.messages,
  );
  compareEnums(result, fromSnapshot.types.enums, toSnapshot.types.enums);
  compareNamedHashes(
    result,
    "proto-file",
    fromSnapshot.protoFiles,
    toSnapshot.protoFiles,
  );
  compareNamedHashes(
    result,
    "scenario-schema",
    fromSnapshot.scenarioSchemas,
    toSnapshot.scenarioSchemas,
  );
  compareAssets(
    result,
    fromSnapshot.manifest.assets ?? [],
    toSnapshot.manifest.assets ?? [],
  );

  for (const category of CATEGORY_ORDER) {
    result[category].sort((left, right) =>
      `${left.kind}:${left.target}`.localeCompare(
        `${right.kind}:${right.target}`,
      ),
    );
    result.summary[category] = result[category].length;
  }

  if (result.breaking.length > 0) {
    result.verdict = "blocked";
  } else if (
    result.review.length > 0 ||
    result.behavioralUnknown.length > 0
  ) {
    result.verdict = "review";
  } else if (result.additive.length > 0) {
    result.verdict = "compatible-additive";
  }

  return result;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function hashDirectory(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(suffix)) {
      continue;
    }
    result[entry.name] = sha256(await readFile(path.join(directory, entry.name)));
  }
  return result;
}

export async function loadSnapshot(directory) {
  const root = path.resolve(directory);
  return {
    manifest: await readJson(path.join(root, "manifest.json")),
    methods: await readJson(path.join(root, "methods.generated.json")),
    types: await readJson(path.join(root, "types.generated.json")),
    protoFiles: await hashDirectory(path.join(root, "proto"), ".proto"),
    scenarioSchemas: await hashDirectory(
      path.join(root, "scenario-schemas"),
      ".schema.json",
    ),
  };
}

function usage() {
  return [
    "Usage:",
    "  node research/compare-snapshots.mjs --from <dir> --to <dir> [options]",
    "",
    "Options:",
    "  --json                 print the complete JSON report",
    "  --output <file>        write the complete JSON report",
    "  --fail-on-breaking     exit with status 2 when verdict is blocked",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {
    json: false,
    failOnBreaking: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from" || arg === "--to" || arg === "--output") {
      result[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "--fail-on-breaking") {
      result.failOnBreaking = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function printSummary(report) {
  const from = report.from.version ?? "unknown";
  const to = report.to.version ?? "unknown";
  process.stdout.write(
    [
      `Sprut.hub contract diff: ${from} -> ${to}`,
      `Verdict: ${report.verdict}`,
      ...CATEGORY_ORDER.map(
        (category) => `${category}: ${report.summary[category]}`,
      ),
      "",
    ].join("\n"),
  );
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.from || !args.to) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  const report = compareContracts(
    await loadSnapshot(args.from),
    await loadSnapshot(args.to),
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  if (args.output) {
    const output = path.resolve(args.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, serialized, { mode: 0o600 });
  }
  if (args.json) {
    process.stdout.write(serialized);
  } else {
    printSummary(report);
  }

  if (args.failOnBreaking && report.verdict === "blocked") {
    process.exitCode = 2;
  }
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  await main();
}
