import packageMetadata from "../package.json" with { type: "json" };

// The firmware the tool was last verified on with a live conformance run.
// DEVELOPMENT.md says when and how to update it.
const VERIFIED_FIRMWARE = { version: "3.0.0b", revision: "20131" };

export const VERIFIED_HUB_VERSION = `${VERIFIED_FIRMWARE.version} (${VERIFIED_FIRMWARE.revision})`;

// The tool's own state for the home overview. Only the revision decides:
// a difference in either direction is unverified, never a refusal.
export function toolState(firmware) {
  const tool = {
    version: packageMetadata.version,
    verified_revision: VERIFIED_FIRMWARE.revision,
  };
  const { revision } = firmware;
  if (!["string", "number"].includes(typeof revision) || revision === "") {
    return {
      ...tool,
      firmware_check: "unknown",
      note: `The hub did not report a firmware revision, so whether it is the verified ${VERIFIED_HUB_VERSION} is not known.`,
    };
  }
  if (String(revision) === VERIFIED_FIRMWARE.revision) {
    return { ...tool, firmware_check: "matches" };
  }
  return {
    ...tool,
    firmware_check: "differs",
    // The note is the tool's voice: what the hub reports stays in home.firmware.
    note: `The hub's firmware (home.firmware) is not ${VERIFIED_HUB_VERSION}, the one this tool was last verified on: reads and writes may behave differently. This is not a fault; keep working. Mention it to the owner if they ask about the tool's state or something did not work.`,
  };
}
