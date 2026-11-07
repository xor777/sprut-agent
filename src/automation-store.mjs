import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SprutHubError } from "./spruthub-client.mjs";
import { acquireStateLock } from "./state-lock.mjs";

export class AutomationStore {
  #writes = Promise.resolve();
  // Changes saved while a write is under way, written together by the next
  // one: every write rewrites the whole file, and a command call to many
  // devices saves its changes at once.
  #batch = null;

  constructor({ directory, hubUrl, hubSerial }) {
    this.directory = stateDirectory(directory);
    this.hubFingerprint = hubStateFingerprint(hubUrl, hubSerial);
    this.file = path.join(
      this.directory,
      `automation-changes-${this.hubFingerprint.slice(0, 24)}.json`,
    );
    this.journalLock = `${this.file}.lock`;
    this.operationLock = `${this.file}.operation.lock`;
  }

  newId() {
    return randomBytes(12).toString("hex");
  }

  async get(id) {
    await this.#writes.catch(() => {});
    return (await this.#readFile()).changes[id] ?? null;
  }

  async list() {
    await this.#writes.catch(() => {});
    return Object.values((await this.#readFile()).changes);
  }

  // Resolves once a write that holds the change is done.
  async save(change) {
    if (!this.#batch) {
      const batch = new Map();
      this.#batch = batch;
      this.#writes = this.#writes
        .catch(() => {})
        .then(() => {
          this.#batch = null;
          return this.#write(batch);
        });
    }
    this.#batch.set(change.id, change);
    await this.#writes;
  }

  // Runs operation while no other process of this state directory runs one:
  // what it read from the journal stays current until it saves. Held across
  // hub requests, unlike the lock of a write. A directory that cannot be
  // written gives no lock, and the operation still runs: its reads are
  // useful, and a write to the hub needs a journal save first, which fails.
  async exclusive(operation) {
    let release = async () => {};
    try {
      release = await acquireStateLock(this.operationLock);
    } catch (error) {
      if (error instanceof SprutHubError) throw error;
    }
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  // The journal is read and replaced as a whole, so the read and the replace
  // of one process must not overlap another's.
  async #write(batch) {
    try {
      await this.#writeUnderLock(batch);
    } catch (error) {
      throw error instanceof SprutHubError
        ? error
        : journalUnavailable(this.directory, error);
    }
  }

  async #writeUnderLock(batch) {
    const release = await acquireStateLock(this.journalLock);
    const temporaryFile = `${this.file}.${process.pid}.tmp`;
    try {
      const state = await this.#readFile();
      for (const [id, change] of batch) state.changes[id] = change;
      await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporaryFile, this.file);
    } catch (error) {
      await unlink(temporaryFile).catch(() => {});
      throw error;
    } finally {
      await release();
    }
  }

  async #readFile() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          version: 1,
          hub_fingerprint: this.hubFingerprint,
          changes: {},
        };
      }
      throw journalUnreadable(this.file, error);
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch {
      throw journalUnusable(this.file, "it is not valid JSON");
    }
    if (state?.version !== 1) {
      throw journalUnusable(
        this.file,
        "its format is not version 1, the one this sprut-agent reads",
      );
    }
    if (
      state.hub_fingerprint !== this.hubFingerprint ||
      !state.changes ||
      Array.isArray(state.changes)
    ) {
      throw journalUnusable(
        this.file,
        "it does not hold the change list of this hub",
      );
    }
    return state;
  }
}

const NO_HARD_LINKS = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"]);

// connection.env is read for the hub's connection only: the server takes this
// variable from its own environment.
export const OTHER_STATE_DIRECTORY =
  "set SPRUT_AGENT_STATE_DIR in the environment of the MCP server process (the MCP client's server settings, not connection.env) to a writable directory on a local disk and restart the MCP server";

// What the file system said of the state directory, for the owner.
export function stateFailureReason(error) {
  if (error.syscall === "link" && NO_HARD_LINKS.has(error.code)) {
    return "its file system has no hard links, which the journal's lock needs";
  }
  if (error.code === "ENOTDIR" || error.code === "EEXIST") {
    return "a part of that path is a file, not a directory";
  }
  return `the file system answered ${error.code ?? "with an error"}`;
}

// Why the journal could not be saved and what the owner does about it. A call
// that sent steps before this adds that to it.
function journalUnavailable(directory, error) {
  return new SprutHubError(
    "state_storage_unavailable",
    `Could not save this home's change journal in ${directory}: ${stateFailureReason(error)}. Make that directory writable on a local disk, or ${OTHER_STATE_DIRECTORY}.`,
    "restore_state_storage_then_retry",
  );
}

// The file system stands between the agent and the journal. Another directory
// would hold a new journal, without the undo of what this one records.
function journalUnreadable(file, error) {
  return new SprutHubError(
    "state_storage_unavailable",
    `Could not read this home's change journal at ${file}: ${stateFailureReason(error)}. That path must be a file this process can read, in a directory it can write. To keep state elsewhere, ${OTHER_STATE_DIRECTORY}; undoing earlier changes still needs this journal back.`,
    "restore_state_storage_then_retry",
  );
}

// The file reads, and what it holds is not a journal this version can use.
// The disk is fine; the file is the only record of what can be undone.
function journalUnusable(file, reason) {
  return new SprutHubError(
    "state_storage_unavailable",
    `This home's change journal at ${file} cannot be used: ${reason}. The file was left as it is. It holds what undoes earlier changes: until it is restored from a copy they cannot be undone, and nothing new can be recorded. Moving it aside starts a new journal, and the changes in the old one stay without undo.`,
    "restore_state_storage_then_retry",
  );
}

export function hubStateFingerprint(hubUrl, hubSerial) {
  return createHash("sha256").update(`${hubUrl}\0${hubSerial}`).digest("hex");
}

// MCP clients often pass an unfilled SPRUT_AGENT_STATE_DIR as an empty
// string. A blank value counts as unset, so history stays in the per-user
// directory instead of failing or following the process working directory.
export function stateDirectory(configured) {
  return isBlank(configured) ? defaultStateDirectory() : configured;
}

function defaultStateDirectory() {
  if (process.platform === "darwin") {
    return path.join(
      homedir(),
      "Library",
      "Application Support",
      "sprut-agent",
    );
  }
  // The XDG rule treats an empty XDG_STATE_HOME as unset.
  const stateHome = process.env.XDG_STATE_HOME;
  return path.join(
    isBlank(stateHome) ? path.join(homedir(), ".local", "state") : stateHome,
    "sprut-agent",
  );
}

function isBlank(value) {
  return value === undefined || value === null || value.trim() === "";
}
