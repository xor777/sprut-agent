import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { fillManualLightShadowSource } from "./manual-light-shadow-source.mjs";

const OWN = {
  accessoryId: 90,
  serviceId: 13,
  onCharacteristicId: 15,
  brightnessCharacteristicId: 16,
};
const FOREIGN = {
  accessoryId: 31,
  serviceId: 13,
  onCharacteristicId: 15,
  brightnessCharacteristicId: 16,
};
const MOTION = { accessoryId: 34, serviceId: 13, characteristicId: 15 };
const SECURITY = { accessoryId: 41, serviceId: 13, characteristicId: 15 };

const NIGHT = 2;
const AWAY = 1;
const OFF_DELAY_MS = 60_000;
const SAFETY_MINUTES = 0;

const HS = {
  Lightbulb: "Lightbulb",
  Switch: "Switch",
  MotionSensor: "MotionSensor",
  OccupancySensor: "OccupancySensor",
  ContactSensor: "ContactSensor",
  LightSensor: "LightSensor",
  StatelessProgrammableSwitch: "StatelessProgrammableSwitch",
  C_PulseMeter: "C_PulseMeter",
  SecuritySystem: "SecuritySystem",
};

const HC = {
  On: "On",
  Brightness: "Brightness",
  MotionDetected: "MotionDetected",
  OccupancyDetected: "OccupancyDetected",
  ContactSensorState: "ContactSensorState",
  CurrentAmbientLightLevel: "CurrentAmbientLightLevel",
  ProgrammableSwitchEvent: "ProgrammableSwitchEvent",
  C_PulseCount: "C_PulseCount",
  SecuritySystemTargetState: "SecuritySystemTargetState",
};

function serviceUuid(ids) {
  return `${ids.accessoryId}.${ids.serviceId}`;
}

function characteristicUuid(ids, characteristicId = ids.characteristicId) {
  return `${ids.accessoryId}.${ids.serviceId}.${characteristicId}`;
}

function selfChangedContext() {
  return {
    toString() {
      return "LOGIC.shadow <- C.On <- LOGIC.shadow";
    },
  };
}

function householdOptions({ debug = false } = {}) {
  return {
    motion1: serviceUuid(MOTION),
    motion2: "",
    motion3: "",
    manualControl1: "",
    manualControl2: "",
    manualControl3: "",
    luxSensor: "",
    maxAmbientLux: 50,
    gateAutoSwitch: serviceUuid(SECURITY),
    gateAutoSwitchInvert: false,
    noAutoOffWhenManualOn: true,
    noAutoOnAfterManualOff: false,
    ignoreManualWithin5sAfterSensorOn: true,
    offDelaySeconds: 60,
    manualHoldSafetyOffDelayMinutes: SAFETY_MINUTES,
    debug,
  };
}

function startSandbox({
  now = 1_000_000,
  expiresAt = now + 30 * 60 * 1000,
  options = householdOptions(),
} = {}) {
  const clock = { now };
  const writes = [];
  const logs = [];
  const timers = [];
  const accessories = new Map();
  const byAidCid = new Map();
  let externalHandler;

  function putAccessory({
    accessoryId,
    serviceId,
    serviceType,
    serviceName,
    characteristics,
  }) {
    const accessory = {
      id: accessoryId,
      name: `accessory-${accessoryId}`,
      services: new Map(),
      getId() {
        return accessoryId;
      },
      getName() {
        return this.name;
      },
      getRoom() {
        return { getName: () => "office" };
      },
      getServices() {
        return [...this.services.values()];
      },
      getService(sid) {
        return this.services.get(Number(sid)) ?? this.services.get(sid);
      },
    };
    const service = {
      accessoryId,
      serviceId,
      type: serviceType,
      name: serviceName,
      characteristics: new Map(),
      characteristicsByType: new Map(),
      getType() {
        return serviceType;
      },
      getName() {
        return serviceName;
      },
      getUUID() {
        return `${accessoryId}.${serviceId}`;
      },
      getAccessory() {
        return accessory;
      },
      getId() {
        return serviceId;
      },
      getCharacteristic(typeOrId) {
        return (
          this.characteristicsByType.get(typeOrId) ??
          this.characteristics.get(typeOrId)
        );
      },
    };
    for (const spec of characteristics) {
      const key = characteristicUuid(
        { accessoryId, serviceId },
        spec.characteristicId,
      );
      const characteristic = {
        type: spec.type,
        characteristicId: spec.characteristicId,
        value: spec.value,
        getType() {
          return spec.type;
        },
        getUUID() {
          return key;
        },
        getValue() {
          return this.value;
        },
        getService() {
          return service;
        },
        setValue(value) {
          writes.push({
            accessoryId,
            serviceId,
            characteristicId: spec.characteristicId,
            type: spec.type,
            value,
            at: clock.now,
          });
          this.value = value;
        },
      };
      service.characteristics.set(spec.characteristicId, characteristic);
      service.characteristicsByType.set(spec.type, characteristic);
      byAidCid.set(`${accessoryId}:${spec.characteristicId}`, characteristic);
    }
    accessory.services.set(serviceId, service);
    accessories.set(accessoryId, accessory);
    return accessory;
  }

  putAccessory({
    accessoryId: OWN.accessoryId,
    serviceId: OWN.serviceId,
    serviceType: HS.Lightbulb,
    serviceName: "shadow",
    characteristics: [
      {
        type: HC.On,
        characteristicId: OWN.onCharacteristicId,
        value: false,
      },
      {
        type: HC.Brightness,
        characteristicId: OWN.brightnessCharacteristicId,
        value: 0,
      },
    ],
  });
  putAccessory({
    accessoryId: FOREIGN.accessoryId,
    serviceId: FOREIGN.serviceId,
    serviceType: HS.Lightbulb,
    serviceName: "office-lamp",
    characteristics: [
      {
        type: HC.On,
        characteristicId: FOREIGN.onCharacteristicId,
        value: false,
      },
      {
        type: HC.Brightness,
        characteristicId: FOREIGN.brightnessCharacteristicId,
        value: 0,
      },
    ],
  });
  putAccessory({
    accessoryId: MOTION.accessoryId,
    serviceId: MOTION.serviceId,
    serviceType: HS.MotionSensor,
    serviceName: "office-motion",
    characteristics: [
      {
        type: HC.MotionDetected,
        characteristicId: MOTION.characteristicId,
        value: false,
      },
    ],
  });
  putAccessory({
    accessoryId: SECURITY.accessoryId,
    serviceId: SECURITY.serviceId,
    serviceType: HS.SecuritySystem,
    serviceName: "security",
    characteristics: [
      {
        type: HC.SecuritySystemTargetState,
        characteristicId: SECURITY.characteristicId,
        value: NIGHT,
      },
    ],
  });

  const ownOn = accessories
    .get(OWN.accessoryId)
    .getService(OWN.serviceId)
    .getCharacteristic(HC.On);
  const foreignOn = accessories
    .get(FOREIGN.accessoryId)
    .getService(FOREIGN.serviceId)
    .getCharacteristic(HC.On);
  const motionDetected = accessories
    .get(MOTION.accessoryId)
    .getService(MOTION.serviceId)
    .getCharacteristic(HC.MotionDetected);
  const securityTarget = accessories
    .get(SECURITY.accessoryId)
    .getService(SECURITY.serviceId)
    .getCharacteristic(HC.SecuritySystemTargetState);

  function fireDueTimers() {
    let fired = true;
    while (fired) {
      fired = false;
      for (const task of timers) {
        if (!task.cleared && !task.fired && task.due <= clock.now) {
          task.fired = true;
          fired = true;
          task.handler();
        }
      }
    }
  }

  const context = {
    HS,
    HC,
    Hub: {
      getAccessories() {
        return [...accessories.values()];
      },
      getAccessory(id) {
        return accessories.get(Number(id)) ?? accessories.get(id);
      },
      getCharacteristic(aid, cid) {
        return byAidCid.get(`${aid}:${cid}`);
      },
      subscribeWithCondition(_cond, _value, _hs, _hc, handler) {
        externalHandler = handler;
        const task = {
          cleared: false,
          clear() {
            this.cleared = true;
            if (externalHandler === handler) externalHandler = undefined;
          },
        };
        timers.push(task);
        return task;
      },
    },
    setTimeout(handler, timeout) {
      const task = {
        due: clock.now + timeout,
        handler,
        cleared: false,
        fired: false,
        clear() {
          this.cleared = true;
        },
      };
      timers.push(task);
      return task;
    },
    clearTimeout(id) {
      if (id && typeof id.clear === "function") id.clear();
    },
    Date: { now: () => clock.now },
    console: {
      info(...args) {
        logs.push({ level: "info", args, at: clock.now });
      },
      error(...args) {
        logs.push({ level: "error", args, at: clock.now });
      },
    },
    global: {},
  };
  vm.createContext(context);
  vm.runInContext(
    fillManualLightShadowSource({
      accessoryId: OWN.accessoryId,
      serviceId: OWN.serviceId,
      onCharacteristicId: OWN.onCharacteristicId,
      expiresAt,
    }),
    context,
  );

  function setValueQuiet(characteristic, value) {
    characteristic.value = value;
  }

  function fireExternal(characteristic, value) {
    setValueQuiet(characteristic, value);
    if (typeof externalHandler === "function") {
      externalHandler(characteristic, value);
    }
  }

  return {
    writes,
    logs,
    options,
    variables: context.info.variables,
    onValue() {
      return ownOn.getValue();
    },
    foreignOnValue() {
      return foreignOn.getValue();
    },
    now() {
      return clock.now;
    },
    startAssignedLight({ value = false, context: triggerContext = {} } = {}) {
      setValueQuiet(ownOn, value);
      context.trigger(
        ownOn,
        value,
        context.info.variables,
        options,
        triggerContext,
      );
    },
    triggerForeignLight(value = false) {
      setValueQuiet(foreignOn, value);
      context.trigger(foreignOn, value, context.info.variables, options, {});
    },
    externalOn() {
      setValueQuiet(ownOn, true);
      context.trigger(ownOn, true, context.info.variables, options, {});
    },
    externalOff() {
      setValueQuiet(ownOn, false);
      context.trigger(ownOn, false, context.info.variables, options, {});
    },
    echoLogicOn() {
      setValueQuiet(ownOn, true);
      context.trigger(
        ownOn,
        true,
        context.info.variables,
        options,
        selfChangedContext(),
      );
    },
    echoLogicOff() {
      setValueQuiet(ownOn, false);
      context.trigger(
        ownOn,
        false,
        context.info.variables,
        options,
        selfChangedContext(),
      );
    },
    setNight(value) {
      setValueQuiet(securityTarget, value);
    },
    changeNight(value) {
      fireExternal(securityTarget, value);
    },
    motion(value) {
      fireExternal(motionDetected, value);
    },
    ownWrites() {
      return writes.filter(
        (write) =>
          write.accessoryId === OWN.accessoryId && write.type === HC.On,
      );
    },
    foreignWrites() {
      return writes.filter(
        (write) => write.accessoryId === FOREIGN.accessoryId,
      );
    },
    advance(ms) {
      clock.now += ms;
      fireDueTimers();
    },
  };
}

test("fill requires accessory, service, On and expiresAt copied after create", () => {
  assert.throws(
    () =>
      fillManualLightShadowSource({
        accessoryId: OWN.accessoryId,
        serviceId: OWN.serviceId,
        onCharacteristicId: OWN.onCharacteristicId,
        expiresAt: 0,
      }),
    /expiresAt/,
  );
});

test("motion during NIGHT turns the filled light on and off after 60s quiet", () => {
  const shadow = startSandbox();
  shadow.startAssignedLight();
  shadow.motion(true);
  assert.equal(shadow.onValue(), true, "auto On from live motion while NIGHT");
  shadow.echoLogicOn();

  shadow.motion(false);
  shadow.advance(OFF_DELAY_MS - 1);
  assert.equal(shadow.onValue(), true, "Off timer must not fire early");
  shadow.advance(1);
  assert.equal(shadow.onValue(), false, "auto Off after 60s without motion");
  assert.equal(shadow.foreignWrites().length, 0);
});

test("motion outside NIGHT does not turn the light on", () => {
  const shadow = startSandbox();
  shadow.startAssignedLight();
  shadow.setNight(AWAY);
  shadow.motion(true);
  assert.equal(shadow.onValue(), false);
  assert.equal(shadow.ownWrites().length, 0);
});

test("entering NIGHT while motion is already active does not itself turn the light on", () => {
  const shadow = startSandbox();
  shadow.startAssignedLight();
  shadow.setNight(AWAY);
  shadow.motion(true);
  assert.equal(shadow.onValue(), false);
  shadow.changeNight(NIGHT);
  assert.equal(shadow.onValue(), false);
  assert.equal(shadow.ownWrites().length, 0);
});

test("external On stays on through motion and 60s quiet when safety delay is 0", () => {
  const shadow = startSandbox();
  shadow.startAssignedLight();
  shadow.externalOn();
  assert.equal(shadow.onValue(), true);

  shadow.motion(true);
  shadow.motion(false);
  shadow.advance(OFF_DELAY_MS);
  assert.equal(shadow.onValue(), true);
  assert.equal(
    shadow.ownWrites().some((write) => write.value === false),
    false,
    "manual hold with safety=0 must not schedule auto Off",
  );
});

test("external Off releases hold so a later motion can auto-on again", () => {
  const shadow = startSandbox();
  shadow.startAssignedLight();
  shadow.externalOn();
  shadow.externalOff();
  shadow.motion(true);
  assert.equal(shadow.onValue(), true);
  shadow.echoLogicOn();
  shadow.motion(false);
  shadow.advance(OFF_DELAY_MS);
  assert.equal(shadow.onValue(), false);
});

test("a foreign light is not written even if its On event arrives first", () => {
  const shadow = startSandbox({
    options: { ...householdOptions(), gateAutoSwitch: "" },
  });
  shadow.startAssignedLight();
  shadow.triggerForeignLight(false);
  shadow.motion(true);
  assert.equal(shadow.foreignWrites().length, 0);
  assert.equal(shadow.foreignOnValue(), false);
});

test("after the filled expiresAt the source does not write On or Off", () => {
  const now = 1_000_000;
  const expiresAt = now + 5_000;
  const shadow = startSandbox({
    now,
    expiresAt,
    options: { ...householdOptions({ debug: true }), gateAutoSwitch: "" },
  });
  shadow.startAssignedLight();
  shadow.motion(true);
  shadow.echoLogicOn();
  assert.equal(shadow.onValue(), true);

  shadow.advance(expiresAt - now);
  const writesAtExpiry = shadow.writes.length;
  const logsAtExpiry = shadow.logs.length;
  shadow.motion(false);
  shadow.advance(OFF_DELAY_MS);
  shadow.motion(true);
  assert.equal(shadow.writes.length, writesAtExpiry);
  assert.equal(shadow.logs.length, logsAtExpiry);
});
