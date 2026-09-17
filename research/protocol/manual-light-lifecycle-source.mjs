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

  // Over-eager RED source: any Brightness event writes own On, with no id
  // filter, expiry, or timer. Replaced in GREEN.
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

function trigger(source, value, variables, options, context) {
  if (variables.started) return;
  variables.started = true;
  Hub.subscribeWithCondition("", "", [HS.Lightbulb], [HC.Brightness], function (extSource, extValue) {
    var on = Hub.getCharacteristic(TARGET_AID, TARGET_SID, ON_CID);
    if (on) on.setValue(true);
  });
}
`;
}
