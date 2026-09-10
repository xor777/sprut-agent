import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export class AutomationStore {
  #writes = Promise.resolve();

  constructor({ directory, hubUrl, hubSerial }) {
    this.directory = directory ?? defaultStateDirectory();
    this.hubFingerprint = createHash("sha256")
      .update(`${hubUrl}\0${hubSerial}`)
      .digest("hex");
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

function defaultStateDirectory() {
  if (process.platform === "darwin") {
    return path.join(
      homedir(),
      "Library",
      "Application Support",
      "sprut-agent",
    );
  }
  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"),
    "sprut-agent",
  );
}
