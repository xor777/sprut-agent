import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM_COMMIT = "99a852fd12567720730c05e11032f3cafc1a020d";
export const UPSTREAM_SHA256 =
  "4737a6b455ae5c86e795c2b5f59057872736293dbf64f295eef78cc9184d1244";
export const UPSTREAM_SOURCE_URL = `https://github.com/KirillAshikhmin/Sprut.Hub_Tools/blob/${UPSTREAM_COMMIT}/MotionLightAutomation/source/MotionLightAutomation.js`;
export const UPSTREAM_LICENSE_URL = `https://github.com/KirillAshikhmin/Sprut.Hub_Tools/blob/${UPSTREAM_COMMIT}/LICENSE`;
export const NIGHT_TARGET_STATE = 2;

const upstreamPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "manual-light-shadow-upstream.txt",
);

const GATE_LIST_FROM = `        gate: [
            {serviceTypes: [HS.Switch], characteristicTypes: [HC.On]}
        ],`;

const GATE_LIST_TO = `        gate: [
            {serviceTypes: [HS.Switch], characteristicTypes: [HC.On]},
            {serviceTypes: [HS.SecuritySystem], characteristicTypes: [HC.SecuritySystemTargetState]}
        ],`;

const AUTO_ALLOWED_FROM = `    const svc = getServiceFromListOption(options, "gateAutoSwitch");
    if (!svc) {
        return true;
    }
    const invert = options.gateAutoSwitchInvert === true;
    const gateIsOn = svc.getCharacteristic(HC.On).getValue() === true;
    return invert ? !gateIsOn : gateIsOn;
}`;

const AUTO_ALLOWED_TO = `    const svc = getServiceFromListOption(options, "gateAutoSwitch");
    if (!svc) {
        return true;
    }
    if (svc.getType() === HS.SecuritySystem) {
        const night = svc.getCharacteristic(HC.SecuritySystemTargetState);
        return !!(night && night.getValue() === ${NIGHT_TARGET_STATE});
    }
    const invert = options.gateAutoSwitchInvert === true;
    const gateIsOn = svc.getCharacteristic(HC.On).getValue() === true;
    return invert ? !gateIsOn : gateIsOn;
}`;

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

function replaceOnce(source, from, to, label) {
  const index = source.indexOf(from);
  if (index === -1 || source.indexOf(from, index + 1) !== -1) {
    throw new Error(
      `MotionLightAutomation ${label} is not a unique patch site for ${UPSTREAM_COMMIT}`,
    );
  }
  return source.slice(0, index) + to + source.slice(index + from.length);
}

function adaptNightGate(source) {
  const withGateList = replaceOnce(
    source,
    GATE_LIST_FROM,
    GATE_LIST_TO,
    "gate picker",
  );
  return replaceOnce(
    withGateList,
    AUTO_ALLOWED_FROM,
    AUTO_ALLOWED_TO,
    "NIGHT gate check",
  );
}

function isolationPreamble({
  accessoryId,
  serviceId,
  onCharacteristicId,
  expiresAt,
}) {
  return `var TARGET_AID = ${accessoryId};
var TARGET_SID = ${serviceId};
var TARGET_ON_CID = ${onCharacteristicId};
var EXPIRES_AT = ${expiresAt};
var shadowDisposed = false;
var shadowSubscribeTask;
var shadowTimeouts = [];

function shadowExpired() {
    return Date.now() >= EXPIRES_AT;
}

function shadowAllowsEffect() {
    return !shadowDisposed && !shadowExpired();
}

function shadowOwnService(service) {
    return !!(service && typeof service.getUUID === "function" &&
        service.getUUID() === String(TARGET_AID) + "." + String(TARGET_SID));
}

function shadowOwnOnCharacteristic(ch) {
    if (!ch || typeof ch.getType !== "function" || ch.getType() !== HC.On) {
        return false;
    }
    if (typeof ch.getService === "function") {
        return shadowOwnService(ch.getService());
    }
    return typeof ch.getUUID === "function" &&
        ch.getUUID() === String(TARGET_AID) + "." + String(TARGET_SID) + "." + String(TARGET_ON_CID);
}

function shadowClearTask(task) {
    if (!task) {
        return;
    }
    try {
        if (typeof task.clear === "function") {
            task.clear();
        } else if (typeof _clearTimeout === "function") {
            _clearTimeout(task);
        }
    } catch (e) {}
}

function disposeShadow() {
    shadowDisposed = true;
    shadowClearTask(shadowSubscribeTask);
    shadowSubscribeTask = undefined;
    for (var i = 0; i < shadowTimeouts.length; i++) {
        shadowClearTask(shadowTimeouts[i]);
    }
    shadowTimeouts = [];
}

var _hubSubscribe = Hub.subscribeWithCondition.bind(Hub);
Hub.subscribeWithCondition = function(cond, value, hs, hc, handler) {
    var wrapped = function(extSource, extValue) {
        if (!shadowAllowsEffect()) {
            return;
        }
        return handler(extSource, extValue);
    };
    var task = _hubSubscribe(cond, value, hs, hc, wrapped);
    shadowSubscribeTask = task;
    return task;
};

var _setTimeout = setTimeout;
var _clearTimeout = clearTimeout;
setTimeout = function(handler, timeout) {
    if (!shadowAllowsEffect()) {
        return { clear: function() {} };
    }
    var wrapped = function() {
        if (!shadowAllowsEffect()) {
            return;
        }
        handler();
    };
    var task = _setTimeout(wrapped, timeout);
    shadowTimeouts.push(task);
    return task;
};
clearTimeout = function(id) {
    if (id && typeof id.clear === "function") {
        try { id.clear(); } catch (e) {}
        return;
    }
    return _clearTimeout(id);
};

var _consoleInfo = console.info.bind(console);
var _consoleError = console.error.bind(console);
console.info = function() {
    if (!shadowAllowsEffect()) {
        return;
    }
    return _consoleInfo.apply(console, arguments);
};
console.error = function() {
    if (!shadowAllowsEffect()) {
        return;
    }
    return _consoleError.apply(console, arguments);
};

var shadowRemain = EXPIRES_AT - Date.now();
if (shadowRemain <= 0) {
    disposeShadow();
} else {
    shadowTimeouts.push(_setTimeout(function() { disposeShadow(); }, shadowRemain));
}

`;
}

const ISOLATION_POSTAMBLE = `
var _trigger = trigger;
trigger = function(source, value, variables, options, context) {
    if (!shadowAllowsEffect()) {
        return;
    }
    if (!shadowOwnOnCharacteristic(source)) {
        return;
    }
    return _trigger(source, value, variables, options, context);
};

var _setLightOn = setLightOn;
setLightOn = function(lightSvc, on, options, logSource) {
    if (!shadowAllowsEffect()) {
        return;
    }
    if (!shadowOwnService(lightSvc)) {
        return;
    }
    return _setLightOn(lightSvc, on, options, logSource);
};
`;

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
  const adapted = adaptNightGate(readUpstreamSource());
  return (
    `/* MotionLightAutomation, MIT License, Copyright (c) 2025 Kirill Ashikhmin
 * Upstream ${UPSTREAM_COMMIT}
 * ${UPSTREAM_SOURCE_URL}
 * ${UPSTREAM_LICENSE_URL}
 * Shadow NIGHT gate + write isolation: sprut-agent SPRUT-105.
 */
` +
    isolationPreamble({
      accessoryId,
      serviceId,
      onCharacteristicId,
      expiresAt,
    }) +
    adapted +
    ISOLATION_POSTAMBLE
  );
}
