export const BRIGHTNESS_IMMEDIATE_MIN = 10;
export const BRIGHTNESS_IMMEDIATE_MAX = 19;
export const BRIGHTNESS_ARM_MIN = 20;
export const BRIGHTNESS_ARM_MAX = 29;
export const BRIGHTNESS_DISPOSE_MIN = 30;
export const BRIGHTNESS_DISPOSE_MAX = 39;
export const LIFECYCLE_TIMER_MS = 40_000;
export const LIFECYCLE_MAX_MS = 5 * 60 * 1_000;

export function fillLifecycleSource({
  accessoryId,
  serviceId,
  onCharacteristicId,
  brightnessCharacteristicId,
  expiresAt,
}) {
  for (const [name, value] of Object.entries({
    accessoryId,
    serviceId,
    onCharacteristicId,
    brightnessCharacteristicId,
    expiresAt,
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
  variables: { started: false }
};

var TARGET_AID = ${accessoryId};
var TARGET_SID = ${serviceId};
var ON_CID = ${onCharacteristicId};
var BRIGHTNESS_CID = ${brightnessCharacteristicId};
var TIMER_MS = ${LIFECYCLE_TIMER_MS};
var EXPIRES_AT = ${expiresAt};
var BRIGHTNESS_IMMEDIATE_MIN = ${BRIGHTNESS_IMMEDIATE_MIN};
var BRIGHTNESS_IMMEDIATE_MAX = ${BRIGHTNESS_IMMEDIATE_MAX};
var BRIGHTNESS_ARM_MIN = ${BRIGHTNESS_ARM_MIN};
var BRIGHTNESS_ARM_MAX = ${BRIGHTNESS_ARM_MAX};
var BRIGHTNESS_DISPOSE_MIN = ${BRIGHTNESS_DISPOSE_MIN};
var BRIGHTNESS_DISPOSE_MAX = ${BRIGHTNESS_DISPOSE_MAX};

var subscribeTask;
var offTask;

function ownCharacteristic(cid) {
  var accessory = Hub.getAccessory(TARGET_AID);
  if (!accessory || typeof accessory.getService !== "function") return undefined;
  var service = accessory.getService(TARGET_SID);
  if (!service || typeof service.getCharacteristic !== "function") return undefined;
  return service.getCharacteristic(cid);
}

function ownOn() {
  return ownCharacteristic(ON_CID);
}

function ownBrightness() {
  return ownCharacteristic(BRIGHTNESS_CID);
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

function withinBound() {
  return Date.now() < EXPIRES_AT;
}

function writeOwnOn(value) {
  if (!withinBound()) return;
  var on = ownOn();
  if (!on || typeof on.setValue !== "function") return;
  on.setValue(value);
}

function clearTask(task) {
  if (task && typeof task.clear === "function") {
    try { task.clear(); } catch (e) {}
  }
}

function clearOff() {
  clearTask(offTask);
  offTask = undefined;
}

function clearSubscribe() {
  clearTask(subscribeTask);
  subscribeTask = undefined;
}

function dispose() {
  clearOff();
  clearSubscribe();
}

function inRange(value, min, max) {
  return value >= min && value <= max;
}

function handleBrightness(extSource, extValue) {
  if (!sameUuid(extSource, ownBrightness())) return;
  if (!withinBound()) return;
  if (inRange(extValue, BRIGHTNESS_DISPOSE_MIN, BRIGHTNESS_DISPOSE_MAX)) {
    dispose();
    return;
  }
  if (inRange(extValue, BRIGHTNESS_IMMEDIATE_MIN, BRIGHTNESS_IMMEDIATE_MAX)) {
    writeOwnOn(true);
    return;
  }
  if (inRange(extValue, BRIGHTNESS_ARM_MIN, BRIGHTNESS_ARM_MAX)) {
    clearOff();
    offTask = setTimeout(function () {
      writeOwnOn(false);
    }, TIMER_MS);
  }
}

function trigger(source, value, variables, options, context) {
  if (variables.started) return;
  if (!withinBound()) return;
  if (!sameUuid(source, ownOn())) return;
  variables.started = true;
  subscribeTask = Hub.subscribeWithCondition("", "", [HS.Lightbulb], [HC.Brightness], function (extSource, extValue) {
    handleBrightness(extSource, extValue);
  });
}
`;
}
