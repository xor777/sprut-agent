import { createHash, randomBytes } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SprutHubError } from "./spruthub-client.mjs";

// A lock across the processes of one state directory: each open dialog runs
// its own MCP server. Node has no file locks of the operating system, and a
// hard link to a file already holding the owner's text is the atomic step:
// the lock never exists half-written.
const WAIT_MS = 15_000;
// A holder refreshes its lock while it runs, so only a holder that stopped
// running goes this long without. The age is for a stopped process and for a
// dead holder's pid taken by another program; a dead pid needs no waiting.
export const STATE_LOCK_STALE_MS = 120_000;
const REFRESH_MS = 20_000;
const LONGEST_PAUSE_MS = 50;

// Resolves to the function that releases the lock. Rejects with
// state_storage_busy after the wait, or with the file system's error when
// the directory cannot be written.
export async function acquireStateLock(lockFile) {
  await mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const holder = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
  const prepared = `${lockFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(prepared, holder, { mode: 0o600 });
  try {
    await takeLock(prepared, lockFile);
  } finally {
    await unlink(prepared).catch(() => {});
  }
  const refresh = setInterval(() => {
    const now = new Date();
    utimes(lockFile, now, now).catch(() => {});
  }, REFRESH_MS);
  refresh.unref();
  return async () => {
    clearInterval(refresh);
    // Never fails what the lock protected: a directory gone meanwhile has no
    // lock to release, and an abandoned lock gives way to the next process.
    // A lock taken over from this process is the new holder's.
    if ((await readText(lockFile).catch(() => null)) === holder) {
      await unlink(lockFile).catch(() => {});
    }
  };
}

async function takeLock(prepared, lockFile) {
  const deadline = Date.now() + WAIT_MS;
  let pause = 1;
  while (true) {
    try {
      return await link(prepared, lockFile);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const held = await readText(lockFile);
    if (held !== null && (await isAbandoned(lockFile, held))) {
      await removeAbandoned(lockFile, held);
    }
    if (Date.now() >= deadline) throw lockBusy();
    await sleep(pause * (0.5 + Math.random()));
    pause = Math.min(pause * 2, LONGEST_PAUSE_MS);
  }
}

async function isAbandoned(lockFile, held) {
  const pid = /^(\d+) /.exec(held)?.[1];
  if (pid !== undefined && isDead(Number(pid))) return true;
  const written = await stat(lockFile).catch(() => null);
  return written !== null && Date.now() - written.mtimeMs > STATE_LOCK_STALE_MS;
}

function isDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// Several waiters see one abandoned lock. Removing it after the check would
// let a late one remove the lock a faster one has just taken, so one holder's
// lock is removed under a claim named after that holder, and only while the
// lock still holds its text.
async function removeAbandoned(lockFile, held) {
  const claim = `${lockFile}.${createHash("sha256").update(held).digest("hex").slice(0, 16)}.claim`;
  let handle;
  try {
    handle = await open(claim, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // A process died in the few steps below.
    const written = await stat(claim).catch(() => null);
    if (written && Date.now() - written.mtimeMs > STATE_LOCK_STALE_MS) {
      await unlink(claim).catch(() => {});
    }
    return;
  }
  try {
    await handle.close();
    if ((await readText(lockFile)) === held) {
      await unlink(lockFile).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  } finally {
    await unlink(claim).catch(() => {});
  }
}

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function lockBusy() {
  return new SprutHubError(
    "state_storage_busy",
    `Another open dialog's sprut-agent process holds this home's change journal; this call waited ${WAIT_MS / 1_000} s. No write that needed the journal was sent to the hub. Repeat the call in a few seconds. If this lasts more than ${STATE_LOCK_STALE_MS / 60_000} minutes, restart the MCP client of the other dialog.`,
    "retry_in_a_few_seconds",
  );
}
