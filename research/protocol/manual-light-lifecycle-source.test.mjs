import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  BRIGHTNESS_ARM,
  BRIGHTNESS_DISPOSE,
  BRIGHTNESS_IMMEDIATE,
  fillLifecycleSource,
  LIFECYCLE_MAX_MS,
  LIFECYCLE_TIMER_MS,
} from "./manual-light-lifecycle-source.mjs";

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

function startSandbox(ids = OWN, now = 1_000) {
  const clock = { now };
  const writes = [];
  const timers = [];
  const values = new Map();
  const characteristics = new Map();
  let brightnessHandler;

  const HS = { Lightbulb: "Lightbulb" };
  const HC = { On: "On", Brightness: "Brightness" };

  function putCharacteristic(target, type) {
    const key = `${target.accessoryId}.${target.serviceId}.${
      type === HC.On
        ? target.onCharacteristicId
        : target.brightnessCharacteristicId
    }`;
    const cId =
      type === HC.On
        ? target.onCharacteristicId
        : target.brightnessCharacteristicId;
    const characteristic = {
      getUUID() {
        return key;
      },
      getType() {
        return type;
      },
      getAccessory() {
        return { getUUID: () => String(target.accessoryId) };
      },
      getService() {
        return { getUUID: () => `${target.accessoryId}.${target.serviceId}` };
      },
      getValue() {
        return values.get(key);
      },
      setValue(value) {
        writes.push({
          accessoryId: target.accessoryId,
          serviceId: target.serviceId,
          characteristicId: cId,
          value,
          at: clock.now,
        });
        values.set(key, value);
      },
    };
    characteristics.set(
      `${target.accessoryId}:${target.serviceId}:${cId}`,
      characteristic,
    );
    return characteristic;
  }

  const ownOn = putCharacteristic(OWN, HC.On);
  const ownBrightness = putCharacteristic(OWN, HC.Brightness);
  const foreignBrightness = putCharacteristic(FOREIGN, HC.Brightness);

  const context = {
    HS,
    HC,
    Hub: {
      getCharacteristic(aId, sId, cId) {
        return characteristics.get(`${aId}:${sId}:${cId}`);
      },
      subscribeWithCondition(_n1, _n2, _serviceTypes, _charTypes, handler) {
        brightnessHandler = handler;
      },
    },
    setTimeout(handler, timeout) {
      const task = {
        due: clock.now + timeout,
        handler,
        cleared: false,
        clear() {
          this.cleared = true;
        },
      };
      timers.push(task);
      return task;
    },
    Date: { now: () => clock.now },
  };
  vm.createContext(context);
  vm.runInContext(fillLifecycleSource(ids), context);

  function fireDueTimers() {
    for (const task of timers) {
      if (!task.cleared && !task.fired && task.due <= clock.now) {
        task.fired = true;
        task.handler();
      }
    }
  }

  return {
    ownOn,
    ownBrightness,
    foreignBrightness,
    writes,
    triggerOwnOn() {
      context.trigger(ownOn, true, context.info.variables, {}, {});
    },
    emit(characteristic, value) {
      if (typeof brightnessHandler !== "function") {
        throw new Error("subscribeWithCondition was not registered");
      }
      brightnessHandler(characteristic, value);
    },
    advance(ms) {
      clock.now += ms;
      fireDueTimers();
    },
  };
}

test("a Brightness event on another accessory does not write the probe On", () => {
  const probe = startSandbox();
  probe.triggerOwnOn();
  probe.emit(probe.foreignBrightness, BRIGHTNESS_IMMEDIATE);
  assert.deepEqual(
    probe.writes,
    [],
    "foreign Brightness must not change the probe light",
  );
});

test("an immediate Brightness write after the 5-minute bound does not write On", () => {
  const probe = startSandbox();
  probe.triggerOwnOn();
  probe.advance(LIFECYCLE_MAX_MS);
  probe.emit(probe.ownBrightness, BRIGHTNESS_IMMEDIATE);
  assert.deepEqual(
    probe.writes,
    [],
    "expiry must stop writes, otherwise a late PASS would be a leftover timer",
  );
});

test("immediate Brightness turns On now, arm Brightness turns Off only after the timer", () => {
  const probe = startSandbox();
  probe.triggerOwnOn();
  probe.emit(probe.ownBrightness, BRIGHTNESS_IMMEDIATE);
  assert.deepEqual(probe.writes, [
    {
      accessoryId: OWN.accessoryId,
      serviceId: OWN.serviceId,
      characteristicId: OWN.onCharacteristicId,
      value: true,
      at: 1_000,
    },
  ]);

  probe.writes.length = 0;
  probe.emit(probe.ownBrightness, BRIGHTNESS_ARM);
  assert.deepEqual(
    probe.writes,
    [],
    "arming must not write On before the timer",
  );

  probe.advance(LIFECYCLE_TIMER_MS - 1);
  assert.deepEqual(probe.writes, []);
  probe.advance(1);
  assert.deepEqual(probe.writes, [
    {
      accessoryId: OWN.accessoryId,
      serviceId: OWN.serviceId,
      characteristicId: OWN.onCharacteristicId,
      value: false,
      at: 1_000 + LIFECYCLE_TIMER_MS,
    },
  ]);
});

test("dispose Brightness clears an armed timer so it cannot write later", () => {
  const probe = startSandbox();
  probe.triggerOwnOn();
  probe.emit(probe.ownBrightness, BRIGHTNESS_ARM);
  probe.emit(probe.ownBrightness, BRIGHTNESS_DISPOSE);
  probe.advance(LIFECYCLE_TIMER_MS);
  assert.deepEqual(probe.writes, []);
});
