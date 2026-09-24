import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export class AutomationStore {
  #writes = Promise.resolve();

  constructor({ directory, hubUrl, hubSerial }) {
    this.directory = stateDirectory(directory);
    this.hubFingerprint = hubStateFingerprint(hubUrl, hubSerial);
    this.file = path.join(
      this.directory,
      `automation-changes-${this.hubFingerprint.slice(0, 24)}.json`,
    );
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

  async save(change) {
    const write = this.#writes
      .catch(() => {})
      .then(async () => {
        const state = await this.#readFile();
        state.changes[change.id] = change;
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temporaryFile = `${this.file}.${process.pid}.tmp`;
        await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, {
          mode: 0o600,
        });
        await rename(temporaryFile, this.file);
      });
    this.#writes = write;
    await write;
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
