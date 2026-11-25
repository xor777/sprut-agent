import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  hubStateFingerprint,
  OTHER_STATE_DIRECTORY,
  stateDirectory,
  stateFailureReason,
} from "./automation-store.mjs";
import {
  isHubReadFailure,
  SprutHubError,
  sanitizeNativeData,
} from "./spruthub-client.mjs";

export const FILE_PART_CHUNK_BYTES = 131_072;
export const FILE_PART_MAX_RETRIES = 3;
export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

const MAX_BUFFERED_FILE_EVENTS = 64;
const MAX_FILENAME_COLLISIONS = 1_000;
const ZIP_LOCAL_HEADER_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BACKUP_NAME_PATTERN =
  /^Sprut\.Hub_Backup_(\d{4}\.\d{2}\.\d{2}-\d{2}_\d{2}_\d{2})(?:-(\d+))?\.zip$/;
const NO_HARD_LINKS = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"]);

const RESTORE_NOTE_CREATE =
  "To restore a backup, upload this .zip file manually in the SprutHub app (Settings -> Backup -> Upload backup) and confirm the hub reboot. sprut-agent never restores backups and never reads archive contents.";
const RESTORE_NOTE_LIST =
  "To restore a backup, upload a .zip file manually in the SprutHub app (Settings -> Backup -> Upload backup) and confirm the hub reboot. sprut-agent never restores backups and never reads archive contents.";

export function hubBackupsDirectory({
  stateDirectory: configured,
  hubUrl,
  hubSerial,
}) {
  const root = stateDirectory(configured);
  const fingerprint = hubStateFingerprint(hubUrl, hubSerial);
  const backupsRoot = path.join(root, "backups");
  return {
    backupsRoot,
    hubDir: path.join(backupsRoot, fingerprint),
  };
}

export async function createHubBackup({
  client,
  serial,
  homeRef,
  stateDirectory: configuredStateDirectory,
  hubUrl,
  readyTimeoutMs,
  retryDelayMs,
  maxBackupBytes = MAX_BACKUP_BYTES,
}) {
  const { hubDir } = await ensureBackupsDirectory({
    stateDirectory: configuredStateDirectory,
    hubUrl,
    hubSerial: serial,
  });

  const effectiveReadyTimeoutMs =
    readyTimeoutMs ?? Math.max(client.timeoutMs, 6 * client.timeoutMs);
  const effectiveRetryDelayMs =
    retryDelayMs ??
    Math.min(1_000, Math.max(50, Math.floor(client.timeoutMs / 10)));

  const bufferedFileEvents = [];
  let targetPrepare = null;
  let resolveReadyWaiter = null;

  // Subscribe before file.backups so a fast event.file arriving ahead of the
  // RPC reply is buffered and never missed.
  const stopListening = client.onNativeEvent((event) => {
    if (!isPlainObject(event?.file)) return;
    const fileEvent = event.file;
    if (targetPrepare !== null) {
      if (!matchesPrepare(fileEvent, targetPrepare)) return;
      if (resolveReadyWaiter) {
        const resolve = resolveReadyWaiter;
        resolveReadyWaiter = null;
        resolve(fileEvent);
      } else if (bufferedFileEvents.length < MAX_BUFFERED_FILE_EVENTS) {
        bufferedFileEvents.push(fileEvent);
      }
      return;
    }
    if (bufferedFileEvents.length < MAX_BUFFERED_FILE_EVENTS) {
      bufferedFileEvents.push(fileEvent);
    }
  });

  let transfer = null;
  let handle = null;
  let tempPath = null;
  let tempCreated = false;
  let committed = false;
  let savedBackup = null;
  let hubCleanupFailed = false;
  let unexpectedCleanupError = null;

  try {
    const prepare = await client.nativeFileBackups(
      serial,
      Date.now() + client.timeoutMs,
    );
    targetPrepare = prepare;
    transfer = {
      path: prepare.path,
      ...(prepare.loc !== undefined ? { loc: prepare.loc } : {}),
      ...(prepare.scope !== undefined ? { scope: prepare.scope } : {}),
    };

    const ready = await waitForReadyEvent({
      bufferedFileEvents,
      prepare,
      timeoutMs: effectiveReadyTimeoutMs,
      setWaiter: (fn) => {
        resolveReadyWaiter = fn;
      },
    });
    stopListening();

    if (transfer.loc === undefined && typeof ready.loc === "string") {
      transfer.loc = ready.loc;
    }
    if (transfer.scope === undefined && typeof ready.scope === "string") {
      transfer.scope = ready.scope;
    }

    if (ready.success !== true) {
      throw new SprutHubError(
        "backup_failed",
        "SprutHub reported that creating the backup archive failed.",
        "configuration_point",
      );
    }

    const expectedLength = parseExpectedLength(ready.length, maxBackupBytes);
    const createdDate = new Date();
    const baseStem = formatBackupStem(createdDate);
    tempPath = path.join(
      hubDir,
      `${baseStem}.zip.tmp-${randomBytes(8).toString("hex")}`,
    );

    try {
      handle = await open(
        tempPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      tempCreated = true;
      await handle.chmod(0o600);
    } catch (error) {
      throw backupsUnavailable("save", hubDir, error);
    }

    const hash = createHash("sha256");
    const magic = Buffer.alloc(4);
    let magicBytes = 0;
    let offset = 0;

    while (offset < expectedLength) {
      const requested = Math.min(
        FILE_PART_CHUNK_BYTES,
        expectedLength - offset,
      );
      const { data } = await readFilePartWithRetry(
        client,
        serial,
        { ...transfer, start: offset, length: requested },
        {
          maxRetries: FILE_PART_MAX_RETRIES,
          retryDelayMs: effectiveRetryDelayMs,
        },
      );
      const chunk = decodeBase64Strict(data);
      if (chunk.length === 0 || chunk.length !== requested) {
        throw new SprutHubError(
          "backup_corrupted",
          "SprutHub returned an unexpected backup chunk size.",
          "configuration_point",
        );
      }
      if (magicBytes < 4) {
        const take = Math.min(4 - magicBytes, chunk.length);
        chunk.copy(magic, magicBytes, 0, take);
        magicBytes += take;
        if (magicBytes === 4 && !magic.equals(ZIP_LOCAL_HEADER_MAGIC)) {
          throw new SprutHubError(
            "backup_corrupted",
            "Downloaded backup archive does not have a valid ZIP header.",
            "configuration_point",
          );
        }
      }
      hash.update(chunk);
      try {
        await writeAll(handle, chunk);
      } catch (error) {
        throw backupsUnavailable("save", hubDir, error);
      }
      offset += chunk.length;
    }

    if (
      offset !== expectedLength ||
      magicBytes < 4 ||
      !magic.equals(ZIP_LOCAL_HEADER_MAGIC)
    ) {
      throw new SprutHubError(
        "backup_corrupted",
        "Downloaded backup archive failed integrity verification.",
        "configuration_point",
      );
    }

    try {
      await handle.sync();
      await handle.close();
      handle = null;
    } catch (error) {
      throw backupsUnavailable("save", hubDir, error);
    }

    const { fileName, finalPath } = await commitTempFile(
      hubDir,
      tempPath,
      baseStem,
    );
    committed = true;
    savedBackup = {
      file_name: fileName,
      saved_path: finalPath,
      size_bytes: expectedLength,
      sha256: hash.digest("hex"),
      created_at: createdDate.toISOString(),
    };
  } finally {
    stopListening();
    if (handle !== null) {
      await handle.close().catch(() => {});
    }
    if (tempCreated && tempPath !== null && !committed) {
      await unlink(tempPath).catch(() => {});
    }
    if (transfer !== null) {
      try {
        await client.nativeFileComplete(
          serial,
          transfer,
          Date.now() + client.timeoutMs,
        );
      } catch (cleanupError) {
        if (savedBackup !== null) {
          if (cleanupError instanceof SprutHubError) {
            hubCleanupFailed = true;
          } else {
            unexpectedCleanupError = cleanupError;
          }
        }
      }
    }
  }
  if (unexpectedCleanupError !== null) throw unexpectedCleanupError;

  const { hubBackups, hubBackupsUnread } = await readHubBackupLabels(
    client,
    serial,
  );

  return {
    status: "ok",
    home_ref: homeRef,
    backup: savedBackup,
    hub_backups: hubBackups,
    hub_backups_unread: hubBackupsUnread,
    hub_cleanup_failed: hubCleanupFailed,
    restore_note: RESTORE_NOTE_CREATE,
    limitations: [
      "Backup .zip archives contain sensitive hub credentials (ZigBee keys, tokens, passwords) and are stored locally with owner-only permissions (0600); sprut-agent never unzips or inspects their contents.",
      "This backup was downloaded from the hub's temporary area (file.backups), which works without an external SD card and does not add an entry to the hub's on-device Restore list.",
      ...(hubCleanupFailed
        ? [
            "The local .zip backup was saved and verified, but SprutHub did not confirm removing its temporary archive (file.complete failed).",
          ]
        : []),
      ...(hubBackupsUnread
        ? [
            "Could not read the hub's on-device Restore backup list from hub settings; hub_backups may be incomplete.",
          ]
        : []),
    ],
  };
}

export async function listHubBackups({
  client = null,
  serial,
  homeRef,
  stateDirectory: configuredStateDirectory,
  hubUrl,
  limit = 10,
}) {
  const localAll = await readLocalBackups({
    stateDirectory: configuredStateDirectory,
    hubUrl,
    hubSerial: serial,
  });
  const localBackups = localAll.slice(0, limit);
  const { hubBackups, hubBackupsUnread } = client
    ? await readHubBackupLabels(client, serial)
    : { hubBackups: [], hubBackupsUnread: true };

  return {
    status: "ok",
    home_ref: homeRef,
    local_backups: localBackups,
    local_backups_total: localAll.length,
    hub_backups: hubBackups,
    hub_backups_unread: hubBackupsUnread,
    restore_note: RESTORE_NOTE_LIST,
    limitations: [
      "Local backup .zip files contain sensitive hub credentials and are stored with 0600 permissions; sprut-agent never unzips or inspects archive contents.",
      "hub_backups shows read-only labels from the hub's Restore setting without exposing on-hub file paths; creating a backup via file.backups saves locally and does not change the hub's Restore list.",
      ...(hubBackupsUnread
        ? [
            "Could not read the hub's on-device Restore backup list right now; hub_backups may be incomplete while local_backups shows the files saved on this machine.",
          ]
        : []),
    ],
  };
}

async function readHubBackupLabels(client, serial) {
  try {
    const window = await client.nativeWindow(
      serial,
      "",
      Date.now() + client.timeoutMs,
    );
    if (!window || !Array.isArray(window.options)) {
      return { hubBackups: [], hubBackupsUnread: true };
    }
    const restore = window.options.find((option) => option?.key === "Restore");
    if (!restore || !Array.isArray(restore.validValues)) {
      return { hubBackups: [], hubBackupsUnread: false };
    }
    const hubBackups = [];
    for (const item of restore.validValues) {
      const rawName = typeof item?.name === "string" ? item.name.trim() : "";
      if (rawName.length === 0) continue;
      const sanitized = sanitizeNativeData(rawName);
      hubBackups.push({
        label: typeof sanitized === "string" ? sanitized : "[REDACTED]",
      });
    }
    return { hubBackups, hubBackupsUnread: false };
  } catch (error) {
    if (!(error instanceof SprutHubError)) throw error;
    return { hubBackups: [], hubBackupsUnread: true };
  }
}

async function readLocalBackups({
  stateDirectory: configured,
  hubUrl,
  hubSerial,
}) {
  const { backupsRoot, hubDir } = hubBackupsDirectory({
    stateDirectory: configured,
    hubUrl,
    hubSerial,
  });

  for (const directory of [backupsRoot, hubDir]) {
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw backupsUnavailable("read", directory, error);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw backupsUnavailable(
        "read",
        directory,
        Object.assign(new Error("Not a regular directory"), {
          code: "ENOTDIR",
        }),
      );
    }
  }

  let names;
  try {
    names = await readdir(hubDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw backupsUnavailable("read", hubDir, error);
  }

  const found = [];
  for (const name of names) {
    if (!isSafeBackupFileName(name)) continue;
    const fullPath = path.join(hubDir, name);
    let stats;
    try {
      stats = await lstat(fullPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw backupsUnavailable("read", hubDir, error);
    }
    if (stats.isSymbolicLink() || !stats.isFile()) continue;
    found.push({
      file_name: name,
      saved_path: fullPath,
      size_bytes: stats.size,
      created_at: new Date(stats.mtimeMs).toISOString(),
      mtimeMs: stats.mtimeMs,
    });
  }

  found.sort(compareLocalBackups);
  return found.map(({ mtimeMs: _mtimeMs, ...entry }) => entry);
}

async function ensureBackupsDirectory({
  stateDirectory: configured,
  hubUrl,
  hubSerial,
}) {
  const { backupsRoot, hubDir } = hubBackupsDirectory({
    stateDirectory: configured,
    hubUrl,
    hubSerial,
  });
  try {
    await mkdir(backupsRoot, { recursive: true, mode: 0o700 });
    await assertRealDirectory(backupsRoot);
    await chmod(backupsRoot, 0o700);
    await mkdir(hubDir, { recursive: true, mode: 0o700 });
    await assertRealDirectory(hubDir);
    await chmod(hubDir, 0o700);
  } catch (error) {
    throw backupsUnavailable("save", hubDir, error);
  }
  return { backupsRoot, hubDir };
}

async function assertRealDirectory(directory) {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw Object.assign(new Error("Backup path is not a regular directory"), {
      code: "ENOTDIR",
    });
  }
}

async function commitTempFile(directory, tempPath, baseStem) {
  for (let index = 1; index <= MAX_FILENAME_COLLISIONS; index += 1) {
    const fileName =
      index === 1 ? `${baseStem}.zip` : `${baseStem}-${index}.zip`;
    const finalPath = path.join(directory, fileName);
    try {
      await link(tempPath, finalPath);
      await unlink(tempPath).catch(() => {});
      return { fileName, finalPath };
    } catch (error) {
      if (error.code === "EEXIST") continue;
      if (NO_HARD_LINKS.has(error.code)) {
        const exists = await lstat(finalPath).then(
          () => true,
          (statError) => {
            if (statError.code === "ENOENT") return false;
            throw statError;
          },
        );
        if (exists) continue;
        try {
          await rename(tempPath, finalPath);
          return { fileName, finalPath };
        } catch (renameError) {
          throw backupsUnavailable("save", directory, renameError);
        }
      }
      throw backupsUnavailable("save", directory, error);
    }
  }
  throw new SprutHubError(
    "state_storage_unavailable",
    `Could not allocate a unique backup file name in ${directory}.`,
    "restore_state_storage_then_retry",
  );
}

async function waitForReadyEvent({
  bufferedFileEvents,
  prepare,
  timeoutMs,
  setWaiter,
}) {
  const early = bufferedFileEvents.find((event) =>
    matchesPrepare(event, prepare),
  );
  if (early) return early;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      setWaiter(null);
      reject(
        new SprutHubError(
          "timeout",
          "SprutHub did not finish preparing the backup archive in time.",
          "retry",
        ),
      );
    }, timeoutMs);
    setWaiter((event) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}

async function readFilePartWithRetry(
  client,
  serial,
  partRequest,
  { maxRetries, retryDelayMs },
) {
  let attempt = 0;
  for (;;) {
    try {
      return await client.nativeFilePart(
        serial,
        partRequest,
        Date.now() + client.timeoutMs,
      );
    } catch (error) {
      if (!isRetryableFilePartError(error) || attempt >= maxRetries) {
        throw error;
      }
      attempt += 1;
      if (retryDelayMs > 0) await delay(retryDelayMs);
    }
  }
}

function isRetryableFilePartError(error) {
  if (!isHubReadFailure(error)) return false;
  return error.code !== "authentication_failed" && error.code !== "unsupported";
}

function matchesPrepare(fileEvent, prepare) {
  if (!isPlainObject(fileEvent)) return false;
  if (fileEvent.path !== prepare.path) return false;
  if (
    prepare.loc !== undefined &&
    fileEvent.loc !== undefined &&
    fileEvent.loc !== prepare.loc
  ) {
    return false;
  }
  if (
    prepare.scope !== undefined &&
    fileEvent.scope !== undefined &&
    fileEvent.scope !== prepare.scope
  ) {
    return false;
  }
  return true;
}

function parseExpectedLength(rawLength, maxBackupBytes) {
  let length;
  if (typeof rawLength === "number") {
    length = rawLength;
  } else if (typeof rawLength === "string" && /^\d+$/.test(rawLength)) {
    length = Number(rawLength);
  } else {
    length = Number.NaN;
  }
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub reported an invalid backup archive size.",
      "configuration_point",
    );
  }
  if (length > maxBackupBytes) {
    throw new SprutHubError(
      "backup_too_large",
      `SprutHub backup archive exceeds the maximum supported size of ${maxBackupBytes} bytes.`,
      "configuration_point",
    );
  }
  return length;
}

function decodeBase64Strict(data) {
  if (typeof data !== "string") {
    throw new SprutHubError(
      "backup_corrupted",
      "SprutHub returned invalid backup chunk data.",
      "configuration_point",
    );
  }
  const compact = data.replace(/[\r\n]/g, "");
  if (compact.length === 0) return Buffer.alloc(0);
  if (compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) {
    throw new SprutHubError(
      "backup_corrupted",
      "SprutHub returned invalid base64 backup data.",
      "configuration_point",
    );
  }
  return Buffer.from(compact, "base64");
}

async function writeAll(handle, buffer) {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written);
    if (result.bytesWritten <= 0) {
      throw new Error("Short write to local backup file");
    }
    written += result.bytesWritten;
  }
}

function formatBackupStem(date) {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `Sprut.Hub_Backup_${year}.${month}.${day}-${hours}_${minutes}_${seconds}`;
}

function isSafeBackupFileName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (path.basename(name) !== name) return false;
  if (!name.endsWith(".zip")) return false;
  if (name.includes(".tmp-") || name.includes(".tmp")) return false;
  return true;
}

function compareLocalBackups(left, right) {
  if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
  const leftParsed = parseBackupNameOrder(left.file_name);
  const rightParsed = parseBackupNameOrder(right.file_name);
  if (leftParsed && rightParsed) {
    if (leftParsed.stamp !== rightParsed.stamp) {
      return leftParsed.stamp < rightParsed.stamp ? 1 : -1;
    }
    if (leftParsed.sequence !== rightParsed.sequence) {
      return rightParsed.sequence - leftParsed.sequence;
    }
  }
  if (left.file_name < right.file_name) return 1;
  if (left.file_name > right.file_name) return -1;
  return 0;
}

function parseBackupNameOrder(fileName) {
  const match = BACKUP_NAME_PATTERN.exec(fileName);
  if (!match) return null;
  return {
    stamp: match[1],
    sequence: match[2] ? Number(match[2]) : 1,
  };
}

function backupsUnavailable(doing, directory, error) {
  return new SprutHubError(
    "state_storage_unavailable",
    `Could not ${doing} hub backups in ${directory}: ${stateFailureReason(error)}. Make that directory readable and writable on a local disk, or ${OTHER_STATE_DIRECTORY}.`,
    "restore_state_storage_then_retry",
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
