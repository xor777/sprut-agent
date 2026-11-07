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
    try {
      const state = JSON.parse(await readFile(this.file, "utf8"));
      if (
        state?.version !== 1 ||
        state.hub_fingerprint !== this.hubFingerprint ||
        !state.changes ||
        Array.isArray(state.changes)
      ) {
        throw new Error("incompatible state");
      }
      return state;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return {
        version: 1,
        hub_fingerprint: this.hubFingerprint,
        changes: {},
      };
    }
  }
}

const NO_HARD_LINKS = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"]);

// Why the journal could not be saved and what the owner does about it. A call
// that sent steps before this adds that to it.
function journalUnavailable(directory, error) {
  const reason =
    error.syscall === "link" && NO_HARD_LINKS.has(error.code)
      ? "its file system has no hard links, which the journal's lock needs"
      : `the file system answered ${error.code ?? "with an error"}`;
  return new SprutHubError(
    "state_storage_unavailable",
    `Could not save this home's change journal in ${directory}: ${reason}. Make that directory writable on a local disk, or set SPRUT_AGENT_STATE_DIR to such a directory and restart the MCP server.`,
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
