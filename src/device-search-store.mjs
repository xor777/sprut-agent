import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { hubStateFingerprint, stateDirectory } from "./automation-store.mjs";

// Device search watches, one file each, beside the change journal: a
// client may start the MCP server anew for each turn, and the owner's reply
// to the pairing step comes in a later turn.
const FORMAT_VERSION = 1;
// A watch not written for this long is removed when a search starts.
const KEEP_MS = 3 * 24 * 60 * 60_000;
const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class DeviceSearchStore {
  #writes = Promise.resolve();

  constructor({ directory, hubUrl, hubSerial }) {
    this.hubFingerprint = hubStateFingerprint(hubUrl, hubSerial);
    this.directory = path.join(
      stateDirectory(directory),
      `device-searches-${this.hubFingerprint.slice(0, 24)}`,
    );
  }

  // The stored watch with this id, or null when there is none or its file
  // cannot be read as one.
  async get(id) {
    if (!ID_PATTERN.test(id)) return null;
    await this.#writes.catch(() => {});
    let text;
    try {
      text = await readFile(this.#file(id), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    return this.#parse(text);
  }

  async list() {
    await this.#writes.catch(() => {});
    let names;
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const watches = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const watch = await this.get(name.slice(0, -".json".length));
      if (watch) watches.push(watch);
    }
    return watches;
  }

  async save(id, watch) {
    await this.#write(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = this.#file(id);
      const temporaryFile = `${file}.${process.pid}.tmp`;
      try {
        await writeFile(
          temporaryFile,
          `${JSON.stringify({
            version: FORMAT_VERSION,
            hub_fingerprint: this.hubFingerprint,
            ...watch,
          })}\n`,
          { mode: 0o600 },
        );
        await rename(temporaryFile, file);
      } catch (error) {
        await unlink(temporaryFile).catch(() => {});
        throw error;
      }
    });
  }

  async delete(id) {
    await this.#write(() => unlink(this.#file(id)).catch(ignoreMissing));
  }

  // Removes watches not written for KEEP_MS.
  async prune() {
    await this.#write(async () => {
      let names;
      try {
        names = await readdir(this.directory);
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      const before = Date.now() - KEEP_MS;
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(this.directory, name);
        const written = await stat(file).catch(() => null);
        if (written && written.mtimeMs < before) {
          await unlink(file).catch(ignoreMissing);
        }
      }
    });
  }

  #file(id) {
    return path.join(this.directory, `${id}.json`);
  }

  #parse(text) {
    let watch;
    try {
      watch = JSON.parse(text);
    } catch {
      return null;
    }
    if (
      watch?.version !== FORMAT_VERSION ||
      watch.hub_fingerprint !== this.hubFingerprint ||
      typeof watch.ref !== "string" ||
      !Array.isArray(watch.baseline)
    ) {
      return null;
    }
    return watch;
  }

  #write(run) {
    const write = this.#writes.catch(() => {}).then(run);
    this.#writes = write;
    return write;
  }
}

function ignoreMissing(error) {
  if (error.code !== "ENOENT") throw error;
}
