export const BRIGHTNESS_IMMEDIATE = 11;
export const BRIGHTNESS_ARM = 22;
export const BRIGHTNESS_DISPOSE = 33;
export const LIFECYCLE_TIMER_MS = 5_000;
export const LIFECYCLE_MAX_MS = 5 * 60 * 1_000;

export function fillLifecycleSource({
  accessoryId,
  serviceId,
  onCharacteristicId,
  brightnessCharacteristicId,
}) {
  for (const [name, value] of Object.entries({
    accessoryId,
    serviceId,
    onCharacteristicId,
    brightnessCharacteristicId,
  })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer copied after create`);
    }
  }

  return `info = {
  name: "lifecycle-probe",
  description: "temporary LOGIC lifecycle probe, not household automation",
  version: "1.0",
  author: "sprut-agent",
  onStart: true,
  sourceServices: [HS.Lightbulb],
  sourceCharacteristics: [HC.On],
  options: [],
  variables: { started: false, startedAt: 0, offTask: undefined }
};

var TARGET_AID = ${accessoryId};
var TARGET_SID = ${serviceId};
var ON_CID = ${onCharacteristicId};
var BRIGHTNESS_CID = ${brightnessCharacteristicId};
var TIMER_MS = ${LIFECYCLE_TIMER_MS};
var MAX_MS = ${LIFECYCLE_MAX_MS};
var BRIGHTNESS_IMMEDIATE = ${BRIGHTNESS_IMMEDIATE};
var BRIGHTNESS_ARM = ${BRIGHTNESS_ARM};
var BRIGHTNESS_DISPOSE = ${BRIGHTNESS_DISPOSE};

function ownOn() {
  return Hub.getCharacteristic(TARGET_AID, TARGET_SID, ON_CID);
}

function ownBrightness() {
  return Hub.getCharacteristic(TARGET_AID, TARGET_SID, BRIGHTNESS_CID);
}

function sameUuid(left, right) {
  return !!(
    left &&
    right &&
    typeof left.getUUID === "function" &&
    typeof right.getUUID === "function" &&
    left.getUUID() === right.getUUID()
  );
}

function withinBound(variables) {
  return Date.now() - variables.startedAt < MAX_MS;
}

function writeOwnOn(value, variables) {
  if (!withinBound(variables)) return;
  var on = ownOn();
  if (!on) return;
  on.setValue(value);
}

function clearOff(variables) {
  var task = variables.offTask;
  if (task && typeof task.clear === "function") {
    try { task.clear(); } catch (e) {}
  }
  variables.offTask = undefined;
}

function handleBrightness(extSource, extValue, variables) {
  if (!sameUuid(extSource, ownBrightness())) return;
  if (!withinBound(variables)) return;
  if (extValue === BRIGHTNESS_DISPOSE) {
    clearOff(variables);
    return;
  }
  if (extValue === BRIGHTNESS_IMMEDIATE) {
    writeOwnOn(true, variables);
    return;
  }
  if (extValue === BRIGHTNESS_ARM) {
    clearOff(variables);
    variables.offTask = setTimeout(function () {
      writeOwnOn(false, variables);
    }, TIMER_MS);
  }
}

function trigger(source, value, variables, options, context) {
  if (variables.started) return;
  if (!sameUuid(source, ownOn())) return;
  variables.started = true;
  variables.startedAt = Date.now();
  Hub.subscribeWithCondition("", "", [HS.Lightbulb], [HC.Brightness], function (extSource, extValue) {
    handleBrightness(extSource, extValue, variables);
  });
}
`;
}
