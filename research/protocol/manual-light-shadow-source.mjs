import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM_COMMIT = "99a852fd12567720730c05e11032f3cafc1a020d";
export const UPSTREAM_SHA256 =
  "4737a6b455ae5c86e795c2b5f59057872736293dbf64f295eef78cc9184d1244";
export const UPSTREAM_SOURCE_URL = `https://github.com/KirillAshikhmin/Sprut.Hub_Tools/blob/${UPSTREAM_COMMIT}/MotionLightAutomation/source/MotionLightAutomation.js`;

const upstreamPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "manual-light-shadow-upstream.txt",
);

export function readUpstreamSource() {
  const text = readFileSync(upstreamPath, "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  if (sha256 !== UPSTREAM_SHA256) {
    throw new Error(
      `Vendored MotionLightAutomation does not match fixed ${UPSTREAM_COMMIT}`,
    );
  }
  return text;
}

function requirePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer copied after create`);
  }
}

export function fillManualLightShadowSource({
  accessoryId,
  serviceId,
  onCharacteristicId,
  expiresAt,
}) {
  requirePositiveInteger("accessoryId", accessoryId);
  requirePositiveInteger("serviceId", serviceId);
  requirePositiveInteger("onCharacteristicId", onCharacteristicId);
  requirePositiveInteger("expiresAt", expiresAt);
  return readUpstreamSource();
}
