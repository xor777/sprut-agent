#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://beta.spruthub.ru/";
const DEFAULT_OUTPUT_DIR = "research/snapshots";
const EXTRACTOR_VERSION = 1;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function snapshotFingerprint(manifest) {
  return sha256(
    JSON.stringify({
      extractorVersion: manifest.extractorVersion,
      webClient: manifest.webClient,
      assets: manifest.assets,
      protobuf: manifest.protobuf,
      scenarioSchemas: manifest.scenarioSchemas,
    }),
  );
}

export function decodeJsString(raw) {
  let result = "";

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character !== "\\") {
      result += character;
      continue;
    }

    index += 1;
    const escaped = raw[index];
    if (escaped === undefined) {
      throw new Error("Invalid trailing escape in JavaScript string");
    }

    const simpleEscapes = {
      "0": "\0",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      "'": "'",
      '"': '"',
    };

    if (Object.hasOwn(simpleEscapes, escaped)) {
      result += simpleEscapes[escaped];
      continue;
    }

    if (escaped === "x") {
      const value = raw.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/i.test(value)) {
        throw new Error(`Invalid hexadecimal escape: \\x${value}`);
      }
      result += String.fromCharCode(Number.parseInt(value, 16));
      index += 2;
      continue;
    }

    if (escaped === "u") {
      if (raw[index + 1] === "{") {
        const end = raw.indexOf("}", index + 2);
        if (end === -1) {
          throw new Error("Invalid Unicode code point escape");
        }
        const value = raw.slice(index + 2, end);
        if (!/^[0-9a-f]+$/i.test(value)) {
          throw new Error(`Invalid Unicode code point: ${value}`);
        }
        result += String.fromCodePoint(Number.parseInt(value, 16));
        index = end;
        continue;
      }

      const value = raw.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/i.test(value)) {
        throw new Error(`Invalid Unicode escape: \\u${value}`);
      }
      result += String.fromCharCode(Number.parseInt(value, 16));
      index += 4;
      continue;
    }

    if (escaped === "\n") {
      continue;
    }
    if (escaped === "\r" && raw[index + 1] === "\n") {
      index += 1;
      continue;
    }

    result += escaped;
  }

  return result;
}

function extractBalancedBlock(source, openingBraceIndex) {
  if (source[openingBraceIndex] !== "{") {
    throw new Error("Balanced block must start with an opening brace");
  }

  let depth = 0;
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) {
      return source.slice(openingBraceIndex + 1, index);
    }
  }

  throw new Error("Unterminated protobuf block");
}

function extractJsObjectLiteral(source, openingBraceIndex) {
  if (source[openingBraceIndex] !== "{") {
    throw new Error("JavaScript object must start with an opening brace");
  }

  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openingBraceIndex; index < source.length; index += 1) {
    const character = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) {
      return source.slice(openingBraceIndex, index + 1);
    }
  }

  throw new Error("Unterminated JavaScript object literal");
}

function jsLiteralToJson(literal) {
  let result = "";
  let quote = null;
  let escaped = false;

  for (let index = 0; index < literal.length; index += 1) {
    const character = literal[index];

    if (quote) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      continue;
    }

    if (character === "!" && (literal[index + 1] === "0" ||
      literal[index + 1] === "1")) {
      result += literal[index + 1] === "0" ? "true" : "false";
      index += 1;
      continue;
    }

    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;
      while (end < literal.length && /[A-Za-z0-9_$]/.test(literal[end])) {
        end += 1;
      }
      const identifier = literal.slice(index, end);
      let cursor = end;
      while (/\s/.test(literal[cursor] ?? "")) cursor += 1;

      if (literal[cursor] === ":") {
        result += `${JSON.stringify(identifier)}${literal.slice(end, cursor)}:`;
        index = cursor;
      } else {
        result += identifier;
        index = end - 1;
      }
      continue;
    }

    result += character;
  }

  return result;
}

export function extractJsonSchemas(bundleSource) {
  const schemas = [];
  const pattern =
    /\{\$id:"(http:\/\/makesimple\.org\/schema\/[^"]+)"/g;

  for (const match of bundleSource.matchAll(pattern)) {
    const literal = extractJsObjectLiteral(bundleSource, match.index);
    const schema = JSON.parse(jsLiteralToJson(literal));
    const name = new URL(schema.$id).pathname.split("/").filter(Boolean).at(-1);
    schemas.push({
      id: schema.$id,
      filename: `${name}.schema.json`,
      schema,
      sha256: sha256(`${JSON.stringify(schema, null, 2)}\n`),
    });
  }

  const unique = new Map();
  for (const schema of schemas) {
    const previous = unique.get(schema.id);
    if (previous && previous.sha256 !== schema.sha256) {
      throw new Error(`Conflicting JSON schemas: ${schema.id}`);
    }
    unique.set(schema.id, schema);
  }

  return [...unique.values()].sort((left, right) =>
    left.id.localeCompare(right.id));
}

function findNamedBlock(source, keyword, name) {
  const pattern = new RegExp(`\\b${keyword}\\s+${name}\\s*\\{`, "m");
  const match = pattern.exec(source);
  if (!match) return null;

  const openingBraceIndex = source.indexOf("{", match.index);
  return extractBalancedBlock(source, openingBraceIndex);
}

function parseOneofFields(messageBlock) {
  const match = /\boneof\s+kind\s*\{/m.exec(messageBlock);
  if (!match) return [];

  const openingBraceIndex = messageBlock.indexOf("{", match.index);
  const oneofBlock = extractBalancedBlock(messageBlock, openingBraceIndex);

  return [...oneofBlock.matchAll(
    /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)(?:\s*\[[^\]]+\])?\s*;/gm,
  )].map((field) => ({
    type: field[1],
    name: field[2],
    number: Number(field[3]),
  }));
}

function normalizeProtoBody(body) {
  return `${body.replace(/\r\n?/g, "\n").trimEnd()}\n`;
}

function inferProtoFilename(body, moduleId) {
  const outerClass = body.match(/java_outer_classname\s*=\s*"([^"]+)"/)?.[1];
  const specialOuterClasses = new Set([
    "APIProto",
    "ExtensionChildProto",
    "UtilsProto",
  ]);

  if (outerClass && specialOuterClasses.has(outerClass)) {
    return `${outerClass.replace(/Proto$/, "")}.proto`;
  }

  const requestMessages = [...body.matchAll(
    /\bmessage\s+([A-Z][A-Za-z0-9_]*)Request\s*\{/g,
  )];

  for (const requestMessage of requestMessages) {
    const domain = requestMessage[1];
    const block = findNamedBlock(body, "message", `${domain}Request`);
    if (block && parseOneofFields(block).length > 0 && domain !== "Endpoint") {
      return `${domain}.proto`;
    }
  }

  if (outerClass) {
    return `${outerClass.replace(/Proto$/, "")}.proto`;
  }

  return `module-${moduleId}.proto`;
}

export function extractProtoModules(bundleSource) {
  const modules = [];
  const modulePattern =
    /(\d+):([A-Za-z_$][A-Za-z0-9_$]*)=>\{\2\.exports='((?:\\.|[^'\\])*)'\}/g;

  for (const match of bundleSource.matchAll(modulePattern)) {
    const body = normalizeProtoBody(decodeJsString(match[3]));
    if (!body.includes('syntax = "proto3"')) continue;

    modules.push({
      moduleId: match[1],
      filename: inferProtoFilename(body, match[1]),
      body,
      sha256: sha256(body),
    });
  }

  return modules.sort((left, right) =>
    left.filename.localeCompare(right.filename));
}

function parseDomainNames(protoSource) {
  const domains = [];

  for (const match of protoSource.matchAll(
    /\bmessage\s+([A-Z][A-Za-z0-9_]*)Request\s*\{/g,
  )) {
    const domain = match[1];
    if (domain === "Endpoint") continue;

    const requestBlock = findNamedBlock(
      protoSource,
      "message",
      `${domain}Request`,
    );
    if (requestBlock && parseOneofFields(requestBlock).length > 0) {
      domains.push(domain);
    }
  }

  return domains;
}

const RISK_OVERRIDES = new Map([
  ["accessory.stream", "R3-sensitive"],
  ["account.auth", "R0-auth"],
  ["account.answer", "R0-auth"],
  ["characteristic.update", "R2-reversible"],
  ["cloud.test", "R4-impact"],
  ["device.identify", "R2-reversible"],
  ["file.filePart", "R1-transfer"],
  ["history.list", "R0-sensitive-read"],
  ["hub.supportInfo", "R0-sensitive-read"],
  ["scenario.run", "R4-impact"],
  ["server.clientDisconnect", "R4-impact"],
  ["server.clientInfo", "R0-read"],
]);

const READ_OPERATION_NAMES = new Set([
  "backups",
  "devInfo",
  "get",
  "getAccessories",
  "getInfo",
  "getMesh",
  "getOptions",
  "getScanResult",
  "list",
  "logs",
  "pool",
  "scheme",
  "sdk",
  "supportInfo",
  "types",
  "version",
]);

const OBSERVE_OPERATION_NAMES = new Set(["subscribe", "unsubscribe"]);
const IMPACT_OPERATION_NAMES = new Set([
  "add",
  "complete",
  "delete",
  "deleteAccessories",
  "discovery",
  "exclusion",
  "heal",
  "healMesh",
  "join",
  "ready",
  "reset",
  "restart",
  "run",
  "scan",
  "updateFirmware",
  "updateMesh",
  "upgrade",
]);

export function classifyRisk(domain, operation) {
  const endpoint = `${domain}.${operation}`;
  if (RISK_OVERRIDES.has(endpoint)) return RISK_OVERRIDES.get(endpoint);
  if (READ_OPERATION_NAMES.has(operation)) return "R0-read";
  if (OBSERVE_OPERATION_NAMES.has(operation)) return "R1-observe";
  if (IMPACT_OPERATION_NAMES.has(operation)) return "R4-impact";
  return "R3-configuration";
}

export function parseDomainContracts(protoModules) {
  const operations = [];

  for (const proto of protoModules) {
    for (const domainType of parseDomainNames(proto.body)) {
      const requestFields = parseOneofFields(
        findNamedBlock(proto.body, "message", `${domainType}Request`),
      );
      const responseFields = new Map(
        parseOneofFields(
          findNamedBlock(proto.body, "message", `${domainType}Response`) ?? "",
        ).map((field) => [field.name, field]),
      );

      const domain = `${domainType[0].toLowerCase()}${domainType.slice(1)}`;
      for (const request of requestFields) {
        const response = responseFields.get(request.name);
        operations.push({
          endpoint: `${domain}.${request.name}`,
          domain,
          operation: request.name,
          requestType: request.type,
          responseType: response?.type ?? null,
          requestFieldNumber: request.number,
          responseFieldNumber: response?.number ?? null,
          proto: proto.filename,
          risk: classifyRisk(domain, request.name),
          riskStatus: "provisional",
          evidence: {
            schema: true,
            observed: false,
            replayed: false,
          },
        });
      }
    }
  }

  return operations.sort((left, right) =>
    left.endpoint.localeCompare(right.endpoint));
}

function findOneofRanges(messageBlock) {
  const ranges = [];
  const pattern = /\boneof\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;

  for (const match of messageBlock.matchAll(pattern)) {
    const openingBraceIndex = messageBlock.indexOf("{", match.index);
    const body = extractBalancedBlock(messageBlock, openingBraceIndex);
    const closingBraceIndex = openingBraceIndex + body.length + 1;
    ranges.push({
      name: match[1],
      start: openingBraceIndex,
      end: closingBraceIndex,
    });
  }

  return ranges;
}

function parseMessageFields(messageBlock) {
  const oneofRanges = findOneofRanges(messageBlock);
  const fieldPattern =
    /^\s*(?:(optional|required|repeated)\s+)?(map\s*<[^>]+>|[A-Za-z_][A-Za-z0-9_.]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)(?:\s*\[([^\]]+)\])?\s*;/gm;

  return [...messageBlock.matchAll(fieldPattern)].map((field) => {
    const options = field[5]?.trim() ?? null;
    const oneof = oneofRanges.find(
      (range) => field.index >= range.start && field.index <= range.end,
    )?.name ?? null;

    return {
      name: field[3],
      number: Number(field[4]),
      type: field[2].replace(/\s+/g, ""),
      label: field[1] ?? null,
      oneof,
      deprecated: options?.includes("deprecated = true") ?? false,
      options,
    };
  });
}

function parseEnumValues(enumBlock) {
  const valuePattern =
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+)(?:\s*\[([^\]]+)\])?\s*;/gm;

  return [...enumBlock.matchAll(valuePattern)].map((value) => {
    const options = value[3]?.trim() ?? null;
    return {
      name: value[1],
      number: Number(value[2]),
      deprecated: options?.includes("deprecated = true") ?? false,
      options,
    };
  });
}

export function parseProtoTypes(protoModules) {
  const messages = [];
  const enums = [];

  for (const proto of protoModules) {
    const typePattern = /\b(message|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
    for (const match of proto.body.matchAll(typePattern)) {
      const openingBraceIndex = proto.body.indexOf("{", match.index);
      const block = extractBalancedBlock(proto.body, openingBraceIndex);

      if (match[1] === "message") {
        messages.push({
          name: match[2],
          proto: proto.filename,
          fields: parseMessageFields(block),
        });
      } else {
        enums.push({
          name: match[2],
          proto: proto.filename,
          values: parseEnumValues(block),
        });
      }
    }
  }

  messages.sort((left, right) =>
    `${left.proto}:${left.name}`.localeCompare(`${right.proto}:${right.name}`));
  enums.sort((left, right) =>
    `${left.proto}:${left.name}`.localeCompare(`${right.proto}:${right.name}`));

  return { messages, enums };
}

function extractAssetUrls(html, baseUrl) {
  const urls = [];
  const assetPattern = /<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["']/gi;

  for (const match of html.matchAll(assetPattern)) {
    const url = new URL(match[1], baseUrl);
    if (url.origin !== new URL(baseUrl).origin) continue;
    if (!/\.(?:js|css)(?:$|\?)/.test(url.pathname)) continue;
    urls.push(url.href);
  }

  return [...new Set(urls)].sort();
}

function extractBuildInfo(bundleSources) {
  for (const source of bundleSources) {
    const match =
      /\{version:"([^"]+)",build:"([^"]+)",full:"([^"]+)"\}/.exec(source);
    if (match) {
      return {
        version: match[1],
        build: match[2],
        full: match[3],
      };
    }
  }

  throw new Error("Unable to locate Sprut.hub web-client build information");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "sprut-api-research/1",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch ${url}: HTTP ${response.status}`);
  }

  return response.text();
}

function parseArguments(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    outputDir: DEFAULT_OUTPUT_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base-url") {
      options.baseUrl = argv[++index];
    } else if (argument === "--output-dir") {
      options.outputDir = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  options.baseUrl = new URL(options.baseUrl).href;
  return options;
}

async function pathExists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function inspectSnapshot(directory) {
  if (!(await pathExists(directory))) {
    return { exists: false, complete: false, fingerprint: null };
  }

  try {
    const manifest = JSON.parse(
      await readFile(path.join(directory, "manifest.json"), "utf8"),
    );
    await Promise.all([
      access(path.join(directory, "methods.generated.json")),
      access(path.join(directory, "types.generated.json")),
      access(path.join(directory, "hashes.txt")),
      access(path.join(directory, "proto")),
      access(path.join(directory, "scenario-schemas")),
    ]);
    return {
      exists: true,
      complete: true,
      fingerprint: snapshotFingerprint(manifest),
    };
  } catch {
    return { exists: true, complete: false, fingerprint: null };
  }
}

export async function selectSnapshotDirectory(
  outputDir,
  version,
  manifest,
) {
  const root = path.resolve(outputDir);
  const safeVersion = version.replace(/[^a-z0-9._-]/giu, "_");
  const fingerprint = snapshotFingerprint(manifest);
  const candidates = [
    safeVersion,
    `${safeVersion}+${fingerprint.slice(0, 12)}`,
    `${safeVersion}+${fingerprint}`,
  ];

  for (let attempt = 0; ; attempt += 1) {
    const name =
      candidates[attempt] ??
      `${safeVersion}+${fingerprint}-${attempt - candidates.length + 2}`;
    const directory = path.join(root, name);
    const existing = await inspectSnapshot(directory);
    if (!existing.exists) {
      return { directory, fingerprint, reused: false };
    }
    if (existing.complete && existing.fingerprint === fingerprint) {
      return { directory, fingerprint, reused: true };
    }
  }
}

async function writeSnapshot({
  baseUrl,
  outputDir,
  buildInfo,
  assets,
  protoModules,
  operations,
  types,
  scenarioSchemas,
}) {
  const domains = [...new Set(operations.map((operation) => operation.domain))];
  const manifest = {
    extractorVersion: EXTRACTOR_VERSION,
    sourceUrl: baseUrl,
    webClient: buildInfo,
    assets: assets.map((asset) => ({
      url: asset.url,
      bytes: Buffer.byteLength(asset.source),
      sha256: sha256(asset.source),
    })),
    protobuf: {
      files: protoModules.length,
      domains: domains.length,
      operations: operations.length,
      messages: types.messages.length,
      messageFields: types.messages.reduce(
        (count, message) => count + message.fields.length,
        0,
      ),
      enums: types.enums.length,
      enumValues: types.enums.reduce(
        (count, enumeration) => count + enumeration.values.length,
        0,
      ),
      sha256: sha256(
        protoModules
          .map((proto) => `${proto.filename}:${proto.sha256}`)
          .join("\n"),
      ),
    },
    scenarioSchemas: {
      files: scenarioSchemas.length,
      sha256: sha256(
        scenarioSchemas
          .map((schema) => `${schema.filename}:${schema.sha256}`)
          .join("\n"),
      ),
    },
  };

  const selection = await selectSnapshotDirectory(
    path.resolve(outputDir),
    buildInfo.version,
    manifest,
  );
  const snapshotDir = selection.directory;
  const protoDir = path.join(snapshotDir, "proto");
  if (selection.reused) {
    return { manifest, snapshotDir, protoDir, reused: true };
  }

  await mkdir(path.dirname(snapshotDir), { recursive: true });
  const temporaryDir = await mkdtemp(
    path.join(path.dirname(snapshotDir), ".snapshot-tmp-"),
  );

  try {
    await mkdir(path.join(temporaryDir, "proto"), { recursive: true });
    await mkdir(path.join(temporaryDir, "scenario-schemas"), {
      recursive: true,
    });

    for (const proto of protoModules) {
      await writeFile(
        path.join(temporaryDir, "proto", proto.filename),
        proto.body,
        "utf8",
      );
    }
    for (const item of scenarioSchemas) {
      await writeFile(
        path.join(temporaryDir, "scenario-schemas", item.filename),
        `${JSON.stringify(item.schema, null, 2)}\n`,
        "utf8",
      );
    }

    await writeFile(
      path.join(temporaryDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(temporaryDir, "methods.generated.json"),
      `${JSON.stringify({ domains, operations }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(temporaryDir, "types.generated.json"),
      `${JSON.stringify(types, null, 2)}\n`,
      "utf8",
    );
    const hashLines = [
      ...assets.map((asset) =>
        `${sha256(asset.source)}  asset:${asset.url}`),
      ...protoModules.map((proto) =>
        `${proto.sha256}  proto:${proto.filename}`),
      ...scenarioSchemas.map((schema) =>
        `${schema.sha256}  scenario-schema:${schema.filename}`),
    ].sort();
    await writeFile(
      path.join(temporaryDir, "hashes.txt"),
      `${hashLines.join("\n")}\n`,
      "utf8",
    );

    await rename(temporaryDir, snapshotDir);
  } catch (error) {
    await rm(temporaryDir, { force: true, recursive: true });
    throw error;
  }

  return { manifest, snapshotDir, protoDir, reused: false };
}

export async function createSnapshot(options) {
  const html = await fetchText(options.baseUrl);
  const assetUrls = extractAssetUrls(html, options.baseUrl);
  const scriptUrls = assetUrls.filter((url) =>
    new URL(url).pathname.endsWith(".js"));

  if (scriptUrls.length === 0) {
    throw new Error("No JavaScript assets found in Sprut.hub HTML");
  }

  const assets = await Promise.all(
    assetUrls.map(async (url) => ({
      url,
      source: await fetchText(url),
    })),
  );
  const scriptSources = assets
    .filter((asset) => new URL(asset.url).pathname.endsWith(".js"))
    .map((asset) => asset.source);

  const buildInfo = extractBuildInfo(scriptSources);
  const protoByFilename = new Map();
  for (const source of scriptSources) {
    for (const proto of extractProtoModules(source)) {
      const previous = protoByFilename.get(proto.filename);
      if (previous && previous.sha256 !== proto.sha256) {
        throw new Error(`Conflicting protobuf definitions: ${proto.filename}`);
      }
      protoByFilename.set(proto.filename, proto);
    }
  }

  const protoModules = [...protoByFilename.values()].sort((left, right) =>
    left.filename.localeCompare(right.filename));
  if (protoModules.length === 0) {
    throw new Error("No embedded protobuf schemas found");
  }

  const operations = parseDomainContracts(protoModules);
  const types = parseProtoTypes(protoModules);
  const scenarioSchemaById = new Map();
  for (const source of scriptSources) {
    for (const schema of extractJsonSchemas(source)) {
      const previous = scenarioSchemaById.get(schema.id);
      if (previous && previous.sha256 !== schema.sha256) {
        throw new Error(`Conflicting scenario schemas: ${schema.id}`);
      }
      scenarioSchemaById.set(schema.id, schema);
    }
  }
  const scenarioSchemas = [...scenarioSchemaById.values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  );

  return writeSnapshot({
    ...options,
    buildInfo,
    assets,
    protoModules,
    operations,
    types,
    scenarioSchemas,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await createSnapshot(options);
  process.stdout.write(
    `${JSON.stringify({
      snapshot: result.snapshotDir,
      reused: result.reused,
      webClient: result.manifest.webClient,
      protobuf: result.manifest.protobuf,
      scenarioSchemas: result.manifest.scenarioSchemas,
    }, null, 2)}\n`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
