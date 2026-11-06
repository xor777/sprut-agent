import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SprutHubError } from "./spruthub-client.mjs";
import { acquireStateLock } from "./state-lock.mjs";

// How often a record the journal could not take is tried again.
const UNSAVED_RETRY_MS = 5_000;

export class AutomationStore {
  #writes = Promise.resolve();
  // Changes saved while a write is under way, written together by the next
  // one: every write rewrites the whole file, and a command call to many
  // devices saves its changes at once.
  #batch = null;
  // Records the hub is already ahead of, whose save failed (keepUnsaved).
  #unsaved = new Map();
  #unsavedRetry = null;

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
    const unsaved = this.#unsaved.get(id);
    if (unsaved) return structuredClone(unsaved);
    return (await this.#readFile()).changes[id] ?? null;
  }

  async list() {
    await this.#writes.catch(() => {});
    const { changes } = await this.#readFile();
    return Object.values({
      ...changes,
      ...structuredClone(Object.fromEntries(this.#unsaved)),
    });
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

  // A record that holds what the hub already did and could not be saved. It
  // is what this process reads from now on, it goes with the next write, and
  // it is tried again by itself so other dialogs see it once the journal is
  // free. Only a restart before that loses it: the journal then still says
  // the write went, with its outcome unknown.
  keepUnsaved(change) {
    this.#unsaved.set(change.id, structuredClone(change));
    this.#retryUnsaved();
  }

  #retryUnsaved() {
    if (this.#unsavedRetry) return;
    this.#unsavedRetry = setTimeout(async () => {
      await this.#write(new Map()).catch(() => {});
      this.#unsavedRetry = null;
      if (this.#unsaved.size > 0) this.#retryUnsaved();
    }, UNSAVED_RETRY_MS);
    this.#unsavedRetry.unref();
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
    const unsaved = new Map(this.#unsaved);
    if (batch.size === 0 && unsaved.size === 0) return;
    const release = await acquireStateLock(this.journalLock);
    const temporaryFile = `${this.file}.${process.pid}.tmp`;
    try {
      const state = await this.#readFile();
      for (const [id, change] of unsaved) {
        // An undo another dialog finished meanwhile is not brought back.
        if (state.changes[id]?.status !== "restored") {
          state.changes[id] = change;
        }
      }
      for (const [id, change] of batch) state.changes[id] = change;
      await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporaryFile, this.file);
      for (const [id, change] of unsaved) {
        if (this.#unsaved.get(id) === change) this.#unsaved.delete(id);
      }
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
