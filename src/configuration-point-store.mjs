import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { hubStateFingerprint, stateDirectory } from "./automation-store.mjs";
import { SprutHubError } from "./spruthub-client.mjs";

export const CONFIGURATION_POINT_FORMAT_VERSION = 1;

export class ConfigurationPointStore {
  #writes = Promise.resolve();

  constructor({ directory, hubUrl, hubSerial }) {
    this.directory = stateDirectory(directory);
    this.hubSerial = hubSerial;
    this.hubFingerprint = hubStateFingerprint(hubUrl, hubSerial);
    this.pointsDirectory = path.join(
      this.directory,
      `configuration-points-${this.hubFingerprint.slice(0, 24)}`,
    );
  }

  newId() {
    return randomBytes(12).toString("hex");
  }

  fileFor(id) {
    return path.join(this.pointsDirectory, `${id}.json`);
  }

  async save(point) {
    const write = this.#writes
      .catch(() => {})
      .then(async () => {
        await mkdir(this.pointsDirectory, { recursive: true, mode: 0o700 });
        const file = this.fileFor(point.id);
        const temporaryFile = `${file}.${process.pid}.tmp`;
        try {
          await writeFile(
            temporaryFile,
            `${JSON.stringify(point, null, 2)}\n`,
            {
              mode: 0o600,
            },
          );
          await rename(temporaryFile, file);
        } catch (error) {
          await unlink(temporaryFile).catch(() => {});
          throw error;
        }
      });
    this.#writes = write;
    await write;
  }

  async get(id) {
    await this.#writes.catch(() => {});
    let text;
    try {
      text = await readFile(this.fileFor(id), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw corruptConfigurationPoint(id, this.hubSerial);
    }
    return parseStoredPoint(text, id, this.hubFingerprint, this.hubSerial);
  }

  async list() {
    await this.#writes.catch(() => {});
    let names;
    try {
      names = await readdir(this.pointsDirectory);
    } catch (error) {
      if (error.code === "ENOENT") return { points: [], unavailable: [] };
      throw error;
    }
    const points = [];
    const unavailable = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.includes(".tmp")) continue;
      const id = name.slice(0, -".json".length);
      try {
        const point = await this.get(id);
        if (point) points.push(point);
      } catch (error) {
        if (
          !(error instanceof SprutHubError) ||
          error.code !== "corrupt_configuration_point"
        ) {
          throw error;
        }
        unavailable.push({
          reason: "corrupt_configuration_point",
          ...(isPointId(id)
            ? {
                point_ref:
                  error.details?.point_ref ??
                  configurationPointRef(this.hubSerial, id),
              }
            : {}),
        });
      }
    }
    return { points, unavailable };
  }
}

export function parseStoredPoint(text, id, hubFingerprint, hubSerial) {
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    throw corruptConfigurationPoint(id, hubSerial);
  }
  if (
    state?.version !== CONFIGURATION_POINT_FORMAT_VERSION ||
    state.id !== id ||
    state.hub_fingerprint !== hubFingerprint ||
    typeof state.home_ref !== "string" ||
    !Array.isArray(state.captured) ||
    !Array.isArray(state.not_captured) ||
    !Array.isArray(state.selected_entity_refs)
  ) {
    throw corruptConfigurationPoint(id, hubSerial);
  }
  return state;
}

export function configurationPointRef(serial, id) {
  return `spruthub-point://hub/${encodeURIComponent(serial)}/configuration/${id}`;
}

export function parseConfigurationPointRef(ref) {
  const match =
    /^spruthub-point:\/\/hub\/([^/]+)\/configuration\/([a-f0-9]{24})$/.exec(
      ref,
    );
  if (!match) {
    throw new SprutHubError(
      "invalid_point_ref",
      "Use a configuration point reference returned by save_configuration_point or list_configuration_points.",
      "list_configuration_points",
    );
  }
  return {
    serial: decodeURIComponent(match[1]),
    id: match[2],
  };
}

function isPointId(id) {
  return /^[a-f0-9]{24}$/.test(id);
}

function corruptConfigurationPoint(id, hubSerial) {
  return new SprutHubError(
    "corrupt_configuration_point",
    "The saved configuration point file is unreadable. Capture a new point; this file cannot be used as history.",
    "save_configuration_point",
    {
      ...(isPointId(id)
        ? { point_ref: configurationPointRef(hubSerial, id) }
        : {}),
    },
  );
}
