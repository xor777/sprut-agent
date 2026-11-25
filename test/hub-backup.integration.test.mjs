import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { hubStateFingerprint } from "../src/automation-store.mjs";
import {
  createMinimalZipBuffer,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const HOME_REF = "spruthub://hub/sim-apartment-01";
const SECRET_PREPARE_PREFIX = "/tmp/spruthub-secret-prepare-dir/backup-";
const SECRET_RESTORE_PATH_1 =
  "/var/lib/spruthub/backups/internal-secret-2026-10-11.zip";
const SECRET_RESTORE_PATH_2 =
  "/var/lib/spruthub/backups/internal-secret-2026-10-09.zip";
const RESTORE_BACKUPS = [
  {
    label: "11.10.2026 10:50:34 · 0 МБ",
    path: SECRET_RESTORE_PATH_1,
  },
  {
    label: "09.10.2026 08:12:00 · 3 МБ",
    path: SECRET_RESTORE_PATH_2,
  },
];

async function setup(
  t,
  {
    backup = {},
    hubBackups = RESTORE_BACKUPS,
    serial,
    stateDirectory: existingStateDirectory,
    timeoutMs = 2_000,
  } = {},
) {
  const fixture = await loadHomeFixture("apartment");
  if (serial !== undefined) fixture.hub.serial = serial;
  if (hubBackups !== null) fixture.hub.backups = hubBackups;
  const hub = await startSimulatedHub(fixture, {
    backup: {
      pathPrefix: SECRET_PREPARE_PREFIX,
      ...backup,
    },
  });
  const ownStateDir = existingStateDirectory === undefined;
  const stateDirectory =
    existingStateDirectory ??
    (await mkdtemp(path.join(tmpdir(), "sprut-agent-hub-backup-")));
  const { client } = await connectServer(t, {
    env: {
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: String(timeoutMs),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
  });
  t.after(async () => {
    await hub.close().catch(() => {});
    if (ownStateDir) {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
  return { hub, client, stateDirectory };
}

async function connectServer(t, { env }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "hub-backup-integration-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  return { client };
}

async function callOk(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(
    result.isError,
    undefined,
    `${name} unexpectedly failed: ${result.content[0]?.text}`,
  );
  return result.structuredContent;
}

async function callError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
  return result.structuredContent;
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function backupsDirFor(stateDirectory, hubUrl, serial) {
  return path.join(
    stateDirectory,
    "backups",
    hubStateFingerprint(hubUrl, serial),
  );
}

test("hub_backup=create downloads a multi-chunk ZIP with 0600/0700 modes, cleans hub temp archive, hides raw hub paths, and isolates hubs", async (t) => {
  const zipBuffer = createMinimalZipBuffer(290_000);
  assert.ok(
    zipBuffer.length > 2 * 131_072,
    "test fixture must span at least 3 chunks (> 262144 bytes)",
  );
  const expectedSha256 = sha256Hex(zipBuffer);

  const { hub, client, stateDirectory } = await setup(t, {
    backup: { bytes: zipBuffer },
  });

  const created = await callOk(client, "configuration_point", {
    hub_backup: "create",
  });
  assert.equal(created.status, "ok");
  assert.equal(created.home_ref, HOME_REF);
  assert.equal(created.hub_backups_unread, false);
  assert.equal(created.hub_cleanup_failed, false);
  assert.match(
    created.backup.file_name,
    /^Sprut\.Hub_Backup_\d{4}\.\d{2}\.\d{2}-\d{2}_\d{2}_\d{2}(?:-\d+)?\.zip$/,
  );
  const expectedDir = backupsDirFor(stateDirectory, hub.url, hub.serial);
  assert.equal(path.dirname(created.backup.saved_path), expectedDir);
  assert.equal(
    path.basename(created.backup.saved_path),
    created.backup.file_name,
  );
  assert.equal(created.backup.size_bytes, zipBuffer.length);
  assert.equal(created.backup.sha256, expectedSha256);
  assert.equal(typeof created.backup.created_at, "string");
  assert.ok(!Number.isNaN(Date.parse(created.backup.created_at)));

  // Verify bytes, ZIP magic, and POSIX permissions on disk.
  const onDisk = await readFile(created.backup.saved_path);
  assert.equal(onDisk.length, zipBuffer.length);
  assert.deepEqual(
    onDisk.subarray(0, 4),
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  );
  assert.equal(sha256Hex(onDisk), expectedSha256);
  assert.equal(Buffer.compare(onDisk, zipBuffer), 0);
  assert.equal((await stat(created.backup.saved_path)).mode & 0o777, 0o600);
  assert.equal((await stat(expectedDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.dirname(expectedDir))).mode & 0o777, 0o700);

  // Verify hub RPC protocol sequence and cleanup.
  const backupCalls = hub.requests.filter(
    ({ method }) => method === "file.backups",
  );
  const partCalls = hub.requests.filter(
    ({ method }) => method === "file.filePart",
  );
  const completeCalls = hub.requests.filter(
    ({ method }) => method === "file.complete",
  );
  assert.equal(backupCalls.length, 1);
  assert.equal(partCalls.length, 3);
  for (const call of partCalls) {
    assert.ok(call.params.file.filePart.length <= 131_072);
    assert.equal(call.params.file.filePart.loc, "LOC_TMP");
    assert.equal(call.params.file.filePart.scope, "tmp");
  }
  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].params.file.complete.loc, "LOC_TMP");
  assert.equal(completeCalls[0].params.file.complete.scope, "tmp");
  for (const entry of hub.state.backups.values()) {
    assert.equal(entry.completed, true);
  }

  // Verify read-only hub backup labels and strict secret/path hygiene.
  assert.deepEqual(created.hub_backups, [
    { label: "11.10.2026 10:50:34 · 0 МБ" },
    { label: "09.10.2026 08:12:00 · 3 МБ" },
  ]);
  assert.match(created.restore_note, /Upload backup/i);
  assert.match(created.restore_note, /never restores/i);
  assert.ok(
    Array.isArray(created.limitations) && created.limitations.length > 0,
  );
  const serialized = JSON.stringify(created);
  assert.equal(serialized.includes(SECRET_PREPARE_PREFIX), false);
  assert.equal(serialized.includes(SECRET_RESTORE_PATH_1), false);
  assert.equal(serialized.includes(SECRET_RESTORE_PATH_2), false);

  const workLog = await readFile(
    path.join(stateDirectory, "work-log.jsonl"),
    "utf8",
  );
  assert.equal(workLog.includes(SECRET_PREPARE_PREFIX), false);
  assert.equal(workLog.includes(SECRET_RESTORE_PATH_1), false);
  assert.equal(workLog.includes(SECRET_RESTORE_PATH_2), false);

  // Back-to-back second backup never overwrites the first (even in same second).
  const second = await callOk(client, "configuration_point", {
    hub_backup: "create",
  });
  assert.notEqual(second.backup.saved_path, created.backup.saved_path);
  const files = await readdir(expectedDir);
  assert.equal(files.filter((name) => name.endsWith(".zip")).length, 2);
  assert.equal(files.filter((name) => name.includes(".tmp")).length, 0);

  // Second hub sharing the same state directory gets its own fingerprint dir.
  const other = await setup(t, {
    serial: "sim-other-hub-02",
    stateDirectory,
    backup: { bytes: createMinimalZipBuffer(2_048) },
  });
  const otherCreated = await callOk(other.client, "configuration_point", {
    hub_backup: "create",
  });
  assert.equal(otherCreated.home_ref, "spruthub://hub/sim-other-hub-02");
  assert.notEqual(path.dirname(otherCreated.backup.saved_path), expectedDir);
});

test("hub_backup=create buffers a fast event.file pushed before file.backups resolves and ignores unrelated file events", async (t) => {
  const zipBuffer = createMinimalZipBuffer(24_000);
  const { hub, client } = await setup(t, {
    backup: {
      bytes: zipBuffer,
      eventBeforeReply: true,
      unrelatedFileEvents: [
        {
          file: {
            success: false,
            loc: "LOC_TMP",
            path: "/tmp/unrelated-logs-download.zip",
            length: 0,
            scope: "tmp",
          },
        },
      ],
    },
  });

  // First tool call on a fresh connection exercises early event buffering.
  const created = await callOk(client, "configuration_point", {
    hub_backup: "create",
  });
  assert.equal(created.status, "ok");
  assert.equal(created.backup.size_bytes, zipBuffer.length);
  assert.equal(created.backup.sha256, sha256Hex(zipBuffer));
  assert.equal(
    Buffer.compare(await readFile(created.backup.saved_path), zipBuffer),
    0,
  );
  const completeCalls = hub.requests.filter(
    ({ method }) => method === "file.complete",
  );
  assert.equal(completeCalls.length, 1);
  assert.notEqual(
    completeCalls[0].params.file.complete.path,
    "/tmp/unrelated-logs-download.zip",
  );
});

test("hub_backup=create retries transient file.filePart failures up to 3 times and succeeds cleanly", async (t) => {
  const zipBuffer = createMinimalZipBuffer(180_000);
  const { hub, client } = await setup(t, {
    backup: { bytes: zipBuffer },
  });

  hub.refuseNext("file.filePart", {
    code: -32000,
    message: "temporary hub read busy 1",
  });
  hub.refuseNext("file.filePart", {
    code: -32000,
    message: "temporary hub read busy 2",
  });

  const created = await callOk(client, "configuration_point", {
    hub_backup: "create",
  });
  assert.equal(created.status, "ok");
  assert.equal(created.backup.size_bytes, zipBuffer.length);
  assert.equal(created.backup.sha256, sha256Hex(zipBuffer));
  assert.equal(
    Buffer.compare(await readFile(created.backup.saved_path), zipBuffer),
    0,
  );
  const partCalls = hub.requests.filter(
    ({ method }) => method === "file.filePart",
  );
  assert.equal(partCalls.length, 4, "2 failed retries + 2 chunks succeeded");
});

test("hub_backup=create removes partial temp files and calls file.complete on every download/validation failure", async (t) => {
  const zipBuffer = createMinimalZipBuffer(180_000);

  // 1. event.file success: false
  {
    const { hub, client, stateDirectory } = await setup(t, {
      backup: { bytes: zipBuffer, eventSuccess: false },
    });
    const failed = await callError(client, "configuration_point", {
      hub_backup: "create",
    });
    assert.equal(failed.error.code, "backup_failed");
    assert.equal(JSON.stringify(failed).includes(SECRET_PREPARE_PREFIX), false);
    const dir = backupsDirFor(stateDirectory, hub.url, hub.serial);
    const entries = await readdir(dir).catch(() => []);
    assert.deepEqual(entries, []);
    assert.equal(
      hub.requests.filter(({ method }) => method === "file.complete").length,
      1,
    );
  }

  // 2. Corrupt non-ZIP magic
  {
    const notAZip = Buffer.from(
      "<html><body>not a zip archive at all</body></html>",
      "utf8",
    );
    const { hub, client, stateDirectory } = await setup(t, {
      backup: { bytes: notAZip },
    });
    const failed = await callError(client, "configuration_point", {
      hub_backup: "create",
    });
    assert.equal(failed.error.code, "backup_corrupted");
    const dir = backupsDirFor(stateDirectory, hub.url, hub.serial);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(
      hub.requests.filter(({ method }) => method === "file.complete").length,
      1,
    );
  }

  // 3. Truncated chunk (shorter than requested)
  {
    const { hub, client, stateDirectory } = await setup(t, {
      backup: {
        bytes: zipBuffer,
        partHandler: ({ start, buffer }) => ({
          data: buffer.subarray(start, start + 512).toString("base64"),
        }),
      },
    });
    const failed = await callError(client, "configuration_point", {
      hub_backup: "create",
    });
    assert.equal(failed.error.code, "backup_corrupted");
    const dir = backupsDirFor(stateDirectory, hub.url, hub.serial);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(
      hub.requests.filter(({ method }) => method === "file.complete").length,
      1,
    );
  }

  // 4. Empty base64 chunk (must fail cleanly, never infinite-loop)
  {
    const { hub, client, stateDirectory } = await setup(t, {
      backup: {
        bytes: zipBuffer,
        partHandler: () => ({ data: "" }),
      },
    });
    const failed = await callError(client, "configuration_point", {
      hub_backup: "create",
    });
    assert.equal(failed.error.code, "backup_corrupted");
    const dir = backupsDirFor(stateDirectory, hub.url, hub.serial);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(
      hub.requests.filter(({ method }) => method === "file.complete").length,
      1,
    );
  }

  // 5. Fatal mid-transfer failure (chunk 1 succeeds, chunk 2 fails 4 times)
  {
    const { hub, client, stateDirectory } = await setup(t, {
      backup: { bytes: zipBuffer },
    });
    let seenParts = 0;
    const originalRequests = hub.requests;
    hub.state.backupConfig.partHandler = ({ start, length, buffer }) => {
      seenParts += 1;
      if (seenParts === 1) {
        for (let i = 0; i < 4; i += 1) {
          hub.refuseNext("file.filePart", {
            code: -32000,
            message: "persistent chunk 2 failure",
          });
        }
      }
      return {
        data: buffer.subarray(start, start + length).toString("base64"),
      };
    };
    const failed = await callError(client, "configuration_point", {
      hub_backup: "create",
    });
    assert.equal(failed.error.code, "request_rejected");
    const dir = backupsDirFor(stateDirectory, hub.url, hub.serial);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(
      originalRequests.filter(({ method }) => method === "file.filePart")
        .length,
      5,
      "1 successful chunk + 1 initial attempt + 3 retries on chunk 2",
    );
    assert.equal(
      originalRequests.filter(({ method }) => method === "file.complete")
        .length,
      1,
    );
  }

  // 6. Zero length and oversized (> 256 MiB) ready event fail before filePart
  for (const [reportedLength, expectedCode] of [
    [0, "incompatible_response"],
    [300 * 1024 * 1024, "backup_too_large"],
  ]) {
    const { hub, client, stateDirectory } = await setup(t, {
      backup: { bytes: zipBuffer, reportedLength },
    });
    const failed = await callError(client, "configuration_point", {
      hub_backup: "create",
    });
    assert.equal(failed.error.code, expectedCode);
    assert.equal(
      hub.requests.filter(({ method }) => method === "file.filePart").length,
      0,
    );
    assert.equal(
      hub.requests.filter(({ method }) => method === "file.complete").length,
      1,
    );
    const dir = backupsDirFor(stateDirectory, hub.url, hub.serial);
    assert.deepEqual(await readdir(dir), []);
  }
});

test("hub_backup=create keeps saved .zip when file.complete fails and reports hub_cleanup_failed and hub_backups_unread honestly", async (t) => {
  const zipBuffer = createMinimalZipBuffer(16_384);
  const { hub, client } = await setup(t, {
    backup: { bytes: zipBuffer },
  });

  hub.refuseNext("file.complete", {
    code: -32000,
    message: "temp cleanup rejected",
  });
  hub.refuseNext("window.get", {
    code: -32000,
    message: "settings window temporarily unavailable",
  });

  const created = await callOk(client, "configuration_point", {
    hub_backup: "create",
  });
  assert.equal(created.status, "ok");
  assert.equal(created.hub_cleanup_failed, true);
  assert.equal(created.hub_backups_unread, true);
  assert.deepEqual(created.hub_backups, []);
  assert.ok(
    created.limitations.some((line) => /file\.complete|temporary/i.test(line)),
  );
  assert.ok(
    created.limitations.some((line) => /Restore|hub_backups/i.test(line)),
  );

  // Local archive must still exist intact with 0600 mode.
  const onDisk = await readFile(created.backup.saved_path);
  assert.equal(Buffer.compare(onDisk, zipBuffer), 0);
  assert.equal((await stat(created.backup.saved_path)).mode & 0o777, 0o600);
});

test("hub_backup=list returns local backups newest first (ignoring symlinks/tmp/non-zip) and hub Restore labels without calling file.backups", async (t) => {
  const zipBuffer = createMinimalZipBuffer(8_192);
  const { hub, client, stateDirectory } = await setup(t, {
    backup: { bytes: zipBuffer },
  });

  // 1. Works cleanly before any local backup exists.
  const emptyList = await callOk(client, "configuration_point", {
    hub_backup: "list",
  });
  assert.equal(emptyList.status, "ok");
  assert.equal(emptyList.home_ref, HOME_REF);
  assert.deepEqual(emptyList.local_backups, []);
  assert.deepEqual(emptyList.hub_backups, [
    { label: "11.10.2026 10:50:34 · 0 МБ" },
    { label: "09.10.2026 08:12:00 · 3 МБ" },
  ]);
  assert.equal(emptyList.hub_backups_unread, false);
  assert.equal(
    JSON.stringify(emptyList).includes(SECRET_RESTORE_PATH_1),
    false,
  );
  assert.equal(
    JSON.stringify(emptyList).includes(SECRET_RESTORE_PATH_2),
    false,
  );
  assert.equal(
    hub.requests.filter(({ method }) => method === "file.backups").length,
    0,
  );

  // 2. Create two real backups and plant an older backup, symlink, temp files,
  //    subdirectory, and non-zip file inside the backups directory.
  const first = await callOk(client, "configuration_point", {
    hub_backup: "create",
  });
  const second = await callOk(client, "configuration_point", {
    hub_backup: "create",
  });
  const backupsDir = backupsDirFor(stateDirectory, hub.url, hub.serial);
  const olderPath = path.join(
    backupsDir,
    "Sprut.Hub_Backup_2025.01.01-00_00_00.zip",
  );
  await writeFile(olderPath, zipBuffer, { mode: 0o600 });
  const oldDate = new Date("2025-01-01T00:00:00.000Z");
  await utimes(olderPath, oldDate, oldDate);

  // Make first slightly older than second so ordering is unambiguous.
  const midDate = new Date("2026-06-01T12:00:00.000Z");
  await utimes(first.backup.saved_path, midDate, midDate);
  const newDate = new Date("2026-11-25T15:00:00.000Z");
  await utimes(second.backup.saved_path, newDate, newDate);

  const outsideTarget = path.join(stateDirectory, "outside-secret.txt");
  await writeFile(outsideTarget, "do-not-follow", { mode: 0o600 });
  await symlink(outsideTarget, path.join(backupsDir, "evil-symlink.zip"));
  await writeFile(
    path.join(backupsDir, "Sprut.Hub_Backup_2026.11.25-15_00_01.zip.tmp-abcd"),
    "partial",
  );
  await writeFile(path.join(backupsDir, "partial.tmp-1234.zip"), "partial");
  await writeFile(path.join(backupsDir, "notes.txt"), "not a zip");
  await mkdir(path.join(backupsDir, "folder.zip"));
  assert.equal(
    (await lstat(path.join(backupsDir, "evil-symlink.zip"))).isSymbolicLink(),
    true,
  );

  const backupsBeforeList = hub.requests.filter(
    ({ method }) => method === "file.backups",
  ).length;
  const listed = await callOk(client, "configuration_point", {
    hub_backup: "list",
    limit: 2,
  });
  assert.equal(
    hub.requests.filter(({ method }) => method === "file.backups").length,
    backupsBeforeList,
    "hub_backup=list must never call file.backups",
  );
  assert.equal(listed.local_backups.length, 2);
  assert.equal(listed.local_backups_total, 3);
  assert.deepEqual(
    listed.local_backups.map(({ file_name }) => file_name),
    [second.backup.file_name, first.backup.file_name],
  );

  const fullList = await callOk(client, "configuration_point", {
    hub_backup: "list",
    limit: 10,
  });
  assert.deepEqual(
    fullList.local_backups.map(({ file_name }) => file_name),
    [
      second.backup.file_name,
      first.backup.file_name,
      "Sprut.Hub_Backup_2025.01.01-00_00_00.zip",
    ],
  );

  // 3. window.get("") failure still returns local backups with hub_backups_unread: true.
  hub.refuseNext("window.get", {
    code: -32000,
    message: "settings read failed",
  });
  const unread = await callOk(client, "configuration_point", {
    hub_backup: "list",
  });
  assert.equal(unread.status, "ok");
  assert.equal(unread.hub_backups_unread, true);
  assert.deepEqual(unread.hub_backups, []);
  assert.equal(unread.local_backups.length, 3);

  // 4. Hub completely unreachable on a fresh server still lists local backups.
  const closedEnv = hub.connectionEnv();
  await hub.close();
  const offline = await connectServer(t, {
    env: {
      ...closedEnv,
      SPRUTHUB_TIMEOUT_MS: "500",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
  });
  const offlineList = await callOk(offline.client, "configuration_point", {
    hub_backup: "list",
  });
  assert.equal(offlineList.status, "ok");
  assert.equal(offlineList.hub_backups_unread, true);
  assert.deepEqual(offlineList.hub_backups, []);
  assert.equal(offlineList.local_backups.length, 3);
});

test("configuration_point rejects invalid hub_backup combinations before contacting the hub and keeps MCP surface budgets", async (t) => {
  const { hub, client } = await setup(t);

  const invalidCalls = [
    { hub_backup: "create", entity_refs: [`${HOME_REF}/scenario/5`] },
    {
      hub_backup: "create",
      point_ref:
        "spruthub-point://hub/sim-apartment-01/configuration/0123456789abcdef01234567",
    },
    { hub_backup: "create", compare: true },
    { hub_backup: "list", entity_refs: [`${HOME_REF}/scenario/5`] },
    {
      hub_backup: "list",
      point_ref:
        "spruthub-point://hub/sim-apartment-01/configuration/0123456789abcdef01234567",
    },
    { hub_backup: "list", compare: true },
    { hub_backup: "list", entity_ref: `${HOME_REF}/scenario/5` },
    { hub_backup: "list", cursor: "abc" },
  ];
  for (const args of invalidCalls) {
    const failed = await callError(client, "configuration_point", args);
    assert.equal(failed.error.code, "invalid_point_call", JSON.stringify(args));
    assert.equal(failed.error.action, "configuration_point");
  }

  // Wrong home_ref fails before contacting the hub.
  const wrongHome = await callError(client, "configuration_point", {
    hub_backup: "list",
    home_ref: "spruthub://hub/another-home",
  });
  assert.equal(wrongHome.error.code, "wrong_home");

  assert.deepEqual(hub.writes(), []);
  assert.equal(
    hub.requests.filter(({ method }) => method.startsWith("file.")).length,
    0,
  );

  // Surface budgets: exactly 13 tools, instructions <= 2048, every description <= 1000.
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13, "must keep exactly 13 MCP tools");
  const configPoint = tools.find(({ name }) => name === "configuration_point");
  assert.ok(configPoint);
  assert.deepEqual(configPoint.inputSchema.properties.hub_backup.enum, [
    "create",
    "list",
  ]);
  const oversized = tools
    .filter(({ description }) => description.length > 1_000)
    .map(({ name, description }) => `${name}: ${description.length}`);
  assert.deepEqual(oversized, []);
  const instructions = client.getInstructions();
  assert.ok(
    instructions.length <= 2_048,
    `instructions exceeded 2048 chars: ${instructions.length}`,
  );
});

test("multi-chunk hub_backup=create does not trigger home_changing on concurrent find_devices(refresh) or invalidate warm HomeState", async (t) => {
  const zipBuffer = createMinimalZipBuffer(1_200_000);
  const { hub, client } = await setup(t, {
    backup: { bytes: zipBuffer },
    timeoutMs: 5_000,
  });

  // 1. Overlap 10 file.filePart chunks with an in-flight find_devices(refresh: true).
  await callOk(client, "find_devices", {});
  hub.restEvent();
  hub.delayReplies("file.filePart", 40);
  hub.delayReplies("accessory.list", 75);
  const [created, refreshed] = await Promise.all([
    callOk(client, "configuration_point", { hub_backup: "create" }),
    callOk(client, "find_devices", { refresh: true }),
  ]);
  assert.equal(created.status, "ok");
  assert.equal(created.backup.size_bytes, zipBuffer.length);
  assert.equal(refreshed.status, "ok");

  // 2. Sequential hub_backup=create on a warm HomeState must not bust warm cache.
  hub.delayReplies("file.filePart", 0);
  hub.delayReplies("accessory.list", 0);
  hub.restEvent();
  const readsBeforeBackup = hub.requests.filter(
    ({ method }) => method === "accessory.list",
  ).length;
  const sequential = await callOk(client, "configuration_point", {
    hub_backup: "create",
  });
  assert.equal(sequential.status, "ok");
  assert.equal(sequential.backup.size_bytes, zipBuffer.length);
  const followUp = await callOk(client, "find_devices", {});
  assert.equal(followUp.status, "ok");
  assert.equal(
    hub.requests.filter(({ method }) => method === "accessory.list").length,
    readsBeforeBackup,
    "hub_backup=create must not invalidate warm HomeState",
  );
});

test("hub_backup=create refuses read-only backup directories without chmod-enabling writes and sends 0 file.backups requests", async (t) => {
  const zipBuffer = createMinimalZipBuffer(8_192);

  // 1. Read-only <stateDir>/backups (0o500)
  {
    const { hub, client, stateDirectory } = await setup(t, {
      backup: { bytes: zipBuffer },
    });
    const backupsRoot = path.join(stateDirectory, "backups");
    await mkdir(backupsRoot, { mode: 0o700 });
    await chmod(backupsRoot, 0o500);
    t.after(async () => {
      await chmod(backupsRoot, 0o700).catch(() => {});
    });

    const failed = await callError(client, "configuration_point", {
      hub_backup: "create",
    });
    assert.equal(failed.error.code, "state_storage_unavailable");
    assert.equal(
      (await stat(backupsRoot)).mode & 0o777,
      0o500,
      "must never re-enable write bit on read-only backups root",
    );
    assert.equal(
      hub.requests.filter(({ method }) => method === "file.backups").length,
      0,
    );
  }

  // 2. Read-only <stateDir>/backups/<fp> (0o500) and 0o555
  for (const mode of [0o500, 0o555]) {
    const { hub, client, stateDirectory } = await setup(t, {
      backup: { bytes: zipBuffer },
    });
    const hubDir = backupsDirFor(stateDirectory, hub.url, hub.serial);
    await mkdir(hubDir, { recursive: true, mode: 0o700 });
    await chmod(hubDir, mode);
    t.after(async () => {
      await chmod(hubDir, 0o700).catch(() => {});
    });

    const failed = await callError(client, "configuration_point", {
      hub_backup: "create",
    });
    assert.equal(failed.error.code, "state_storage_unavailable");
    assert.equal(
      (await stat(hubDir)).mode & 0o777,
      mode,
      `must never modify read-only ${mode.toString(8)} hub backup directory`,
    );
    assert.equal(
      hub.requests.filter(({ method }) => method === "file.backups").length,
      0,
    );
  }

  // 3. Existing writable 0o755 backup dir is tightened to 0o700 and succeeds.
  {
    const { hub, client, stateDirectory } = await setup(t, {
      backup: { bytes: zipBuffer },
    });
    const hubDir = backupsDirFor(stateDirectory, hub.url, hub.serial);
    await mkdir(hubDir, { recursive: true, mode: 0o755 });
    await chmod(path.dirname(hubDir), 0o755);
    await chmod(hubDir, 0o755);

    const created = await callOk(client, "configuration_point", {
      hub_backup: "create",
    });
    assert.equal(created.status, "ok");
    assert.equal((await stat(path.dirname(hubDir))).mode & 0o777, 0o700);
    assert.equal((await stat(hubDir)).mode & 0o777, 0o700);
  }
});

test("configuration_point rejects hub_backup combined with pointer, offset, or version before contacting the hub", async (t) => {
  const { hub, client } = await setup(t);
  const pagingCombos = [
    { hub_backup: "create", pointer: "/backup" },
    { hub_backup: "create", offset: 0 },
    { hub_backup: "create", version: "v1" },
    { hub_backup: "list", pointer: "/local_backups" },
    { hub_backup: "list", offset: 0 },
    { hub_backup: "list", version: "v1" },
  ];
  for (const args of pagingCombos) {
    const failed = await callError(client, "configuration_point", args);
    assert.equal(failed.error.code, "invalid_point_call", JSON.stringify(args));
    assert.equal(failed.error.action, "configuration_point");
  }
  assert.equal(hub.requests.length, 0);
});

test("hub_backup=list works without hub credentials, surfaces unreadable connection.env, and rejects foreign/malformed home_ref before login", async (t) => {
  const zipBuffer = createMinimalZipBuffer(8_192);
  const { hub, client, stateDirectory } = await setup(t, {
    backup: { bytes: zipBuffer },
  });
  const created = await callOk(client, "configuration_point", {
    hub_backup: "create",
  });

  // 1. Fresh server with SPRUTHUB_URL + SPRUTHUB_SERIAL and NO credentials lists local backups.
  const emptyConfigRoot = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-empty-config-"),
  );
  t.after(async () => {
    await rm(emptyConfigRoot, { recursive: true, force: true });
  });
  const noCreds = await connectServer(t, {
    env: {
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_SERIAL: hub.serial,
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_CONFIG_HOME: emptyConfigRoot,
    },
  });
  const listedNoCreds = await callOk(noCreds.client, "configuration_point", {
    hub_backup: "list",
  });
  assert.equal(listedNoCreds.status, "ok");
  assert.equal(listedNoCreds.hub_backups_unread, true);
  assert.deepEqual(listedNoCreds.hub_backups, []);
  assert.equal(listedNoCreds.local_backups.length, 1);
  assert.equal(
    listedNoCreds.local_backups[0].file_name,
    created.backup.file_name,
  );

  // 2. Unreadable / wrong-mode connection.env (0o644) still surfaces credential_file_unavailable.
  const badConfigRoot = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-bad-config-"),
  );
  t.after(async () => {
    await rm(badConfigRoot, { recursive: true, force: true });
  });
  const badEnvDir = path.join(badConfigRoot, "sprut-agent");
  await mkdir(badEnvDir, { recursive: true });
  const badEnvFile = path.join(badEnvDir, "connection.env");
  await writeFile(badEnvFile, "SPRUTHUB_LOGIN=owner@example.invalid\n", {
    mode: 0o644,
  });
  await chmod(badEnvFile, 0o644);
  const badConfigServer = await connectServer(t, {
    env: {
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_SERIAL: hub.serial,
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_CONFIG_HOME: badConfigRoot,
    },
  });
  const badConfigError = await callError(
    badConfigServer.client,
    "configuration_point",
    { hub_backup: "list" },
  );
  assert.equal(badConfigError.error.code, "credential_file_unavailable");

  // 3. Foreign or malformed home_ref under SPRUTHUB_LOGIN/SPRUTHUB_PASSWORD
  //    rejects locally with ZERO hub requests (no account.auth / hub.list).
  const loginFixture = await loadHomeFixture("apartment");
  const loginHub = await startSimulatedHub(loginFixture, {
    account: {
      login: "owner@example.invalid",
      password: "correct-password-123",
    },
  });
  t.after(async () => {
    await loginHub.close().catch(() => {});
  });
  const loginServer = await connectServer(t, {
    env: {
      SPRUTHUB_URL: loginHub.url,
      SPRUTHUB_SERIAL: loginHub.serial,
      SPRUTHUB_LOGIN: "owner@example.invalid",
      SPRUTHUB_PASSWORD: "correct-password-123",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_CONFIG_HOME: emptyConfigRoot,
    },
  });

  for (const [args, expectedCode] of [
    [
      { hub_backup: "create", home_ref: "spruthub://hub/foreign-home" },
      "wrong_home",
    ],
    [
      { hub_backup: "list", home_ref: "spruthub://hub/foreign-home" },
      "wrong_home",
    ],
    [{ hub_backup: "create", home_ref: "not-a-home-ref" }, "invalid_home_ref"],
    [
      { hub_backup: "list", home_ref: `${HOME_REF}/room/1` },
      "invalid_home_ref",
    ],
  ]) {
    const failed = await callError(
      loginServer.client,
      "configuration_point",
      args,
    );
    assert.equal(failed.error.code, expectedCode, JSON.stringify(args));
  }
  assert.equal(
    loginHub.requests.length,
    0,
    "foreign/malformed home_ref must reject locally before any hub login/RPC",
  );
});
