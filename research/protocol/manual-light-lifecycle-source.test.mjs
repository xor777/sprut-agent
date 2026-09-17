import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { fillLifecycleSource } from "./manual-light-lifecycle-source.mjs";

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

const TIMER_MS = 40_000;
const WINDOW_MS = 5 * 60 * 1_000;
const BRIGHTNESS_CALLBACK = 11;
const BRIGHTNESS_CALLBACK_FRESH = 12;
const BRIGHTNESS_ARM = 22;
const BRIGHTNESS_ARM_FRESH = 23;
const BRIGHTNESS_DISPOSE = 33;
const BRIGHTNESS_OUT_OF_BAND = 50;

function startSandbox({
  ids = OWN,
  now = 1_000,
  expiresAt = now + WINDOW_MS,
} = {}) {
  const clock = { now };
  const writes = [];
  const timers = [];
  const values = new Map();
  const accessories = new Map();
  const byAidCid = new Map();
  let brightnessHandler;

  const HS = { Lightbulb: "Lightbulb" };
  const HC = { On: "On", Brightness: "Brightness" };

  function putCharacteristic(target, type) {
    const cId =
      type === HC.On
        ? target.onCharacteristicId
        : target.brightnessCharacteristicId;
    const key = `${target.accessoryId}.${target.serviceId}.${cId}`;
    const characteristic = {
      getUUID() {
        return key;
      },
      getType() {
        return type;
      },
      getValue() {
        return values.get(key);
      },
      setValue(value) {
        if (type === HC.On) {
          writes.push({
            accessoryId: target.accessoryId,
            serviceId: target.serviceId,
            characteristicId: cId,
            value,
            at: clock.now,
          });
        }
        values.set(key, value);
      },
    };
    values.set(key, type === HC.On ? false : 0);
    let accessory = accessories.get(target.accessoryId);
    if (!accessory) {
      accessory = { services: new Map() };
      accessories.set(target.accessoryId, accessory);
    }
    let service = accessory.services.get(target.serviceId);
    if (!service) {
      service = { characteristics: new Map() };
      accessory.services.set(target.serviceId, service);
    }
    service.characteristics.set(cId, characteristic);
    byAidCid.set(`${target.accessoryId}:${cId}`, characteristic);
    return characteristic;
  }

  const ownOn = putCharacteristic(OWN, HC.On);
  const ownBrightness = putCharacteristic(OWN, HC.Brightness);
  const foreignBrightness = putCharacteristic(FOREIGN, HC.Brightness);

  const context = {
    HS,
    HC,
    Hub: {
      // Target SDK: getCharacteristic(aid, cid). Extra args are ignored, so
      // getCharacteristic(aid, sid, cid) looks up cid=sid and misses On.
      getCharacteristic(aid, cid) {
        return byAidCid.get(`${aid}:${cid}`);
      },
      getAccessory(aid) {
        const accessory = accessories.get(aid);
        if (!accessory) return undefined;
        return {
          getService(sid) {
            const service = accessory.services.get(sid);
            if (!service) return undefined;
            return {
              getCharacteristic(cid) {
                return service.characteristics.get(cid);
              },
            };
          },
        };
      },
      subscribeWithCondition(_n1, _n2, _serviceTypes, _charTypes, handler) {
        brightnessHandler = handler;
        const task = {
          cleared: false,
          clear() {
            this.cleared = true;
            if (brightnessHandler === handler) {
              brightnessHandler = undefined;
            }
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
    Date: { now: () => clock.now },
  };
  vm.createContext(context);
  vm.runInContext(fillLifecycleSource({ ...ids, expiresAt }), context);

  function fireDueTimers() {
    for (const task of timers) {
      if (!task.cleared && !task.fired && task.due <= clock.now) {
        task.fired = true;
        task.handler();
      }
    }
  }

  function writeBrightness(characteristic, value) {
    const previous = characteristic.getValue();
    characteristic.setValue(value);
    if (previous === value) return;
    if (typeof brightnessHandler === "function") {
      brightnessHandler(characteristic, value);
    }
  }

  return {
    writes,
    onValue() {
      return ownOn.getValue();
    },
    brightnessValue() {
      return ownBrightness.getValue();
    },
    now() {
      return clock.now;
    },
    operatorSetOn(value) {
      const previous = ownOn.getValue();
      values.set(
        `${OWN.accessoryId}.${OWN.serviceId}.${OWN.onCharacteristicId}`,
        value,
      );
      if (previous === value) return;
      context.trigger(ownOn, value, context.info.variables, {}, {});
    },
    writeOwnBrightness(value) {
      writeBrightness(ownBrightness, value);
    },
    writeForeignBrightness(value) {
      writeBrightness(foreignBrightness, value);
    },
    disable({ runtimeContinues }) {
      if (runtimeContinues) return;
      for (const task of timers) {
        if (typeof task.clear === "function") task.clear();
      }
    },
    advance(ms) {
      clock.now += ms;
      fireDueTimers();
    },
  };
}

function runDisableContrast(runtimeContinues) {
  const initialNow = 1_000;
  const probe = startSandbox({
    now: initialNow,
    expiresAt: initialNow + WINDOW_MS,
  });
  const initial = {
    on: probe.onValue(),
    brightness: probe.brightnessValue(),
  };

  probe.operatorSetOn(true);
  probe.operatorSetOn(false);
  probe.writeOwnBrightness(BRIGHTNESS_CALLBACK);
  const afterCallbackOn = probe.onValue();

  const writesAfterCallback = probe.writes.length;
  probe.writeOwnBrightness(BRIGHTNESS_CALLBACK);
  const sameValueWroteOn = probe.writes.length > writesAfterCallback;

  probe.operatorSetOn(true);
  probe.writeOwnBrightness(BRIGHTNESS_ARM);
  const onImmediatelyAfterArm = probe.onValue();
  probe.advance(TIMER_MS - 1);
  const onBeforeTimer = probe.onValue();
  probe.advance(1);
  const afterTimerControlOn = probe.onValue();

  probe.operatorSetOn(true);
  probe.writeOwnBrightness(BRIGHTNESS_ARM_FRESH);
  const onAfterSecondArm = probe.onValue();
  const armedAt = probe.now();
  probe.disable({ runtimeContinues });
  const disabledBeforeDeadline = probe.now() < armedAt + TIMER_MS;
  probe.advance(TIMER_MS);
  const afterTimerDeadlineOn = probe.onValue();

  probe.operatorSetOn(false);
  probe.writeOwnBrightness(BRIGHTNESS_CALLBACK_FRESH);
  const afterImmediateOn = probe.onValue();

  return {
    initial,
    afterCallbackOn,
    sameValueWroteOn,
    onImmediatelyAfterArm,
    onBeforeTimer,
    afterTimerControlOn,
    onAfterSecondArm,
    disabledBeforeDeadline,
    afterTimerDeadlineOn,
    afterImmediateOn,
    beforeCutoff: probe.now() < initialNow + WINDOW_MS,
  };
}

test("the disable sequence distinguishes a retained timer from a stopped runtime", () => {
  const continuing = runDisableContrast(true);
  const stopped = runDisableContrast(false);

  for (const result of [continuing, stopped]) {
    assert.equal(
      result.afterCallbackOn,
      true,
      "positive callback control must turn On before disable",
    );
    assert.equal(
      result.sameValueWroteOn,
      false,
      "repeating the current Brightness must not look like a live callback",
    );
    assert.equal(
      result.onImmediatelyAfterArm,
      true,
      "arming must not write Off immediately",
    );
    assert.equal(
      result.onBeforeTimer,
      true,
      "the 40s timer must not write Off early",
    );
    assert.equal(
      result.afterTimerControlOn,
      false,
      "positive timer control must turn Off after 40s",
    );
    assert.equal(result.onAfterSecondArm, true);
    assert.equal(result.disabledBeforeDeadline, true);
    assert.equal(result.beforeCutoff, true);
  }

  assert.deepEqual(continuing.initial, stopped.initial);
  assert.equal(
    continuing.afterTimerDeadlineOn,
    false,
    "a leftover timer must still turn Off after disable",
  );
  assert.equal(
    continuing.afterImmediateOn,
    true,
    "a leftover callback must still turn On after disable",
  );
  assert.equal(
    stopped.afterTimerDeadlineOn,
    true,
    "a stopped runtime must leave On true after the armed deadline",
  );
  assert.equal(
    stopped.afterImmediateOn,
    false,
    "a stopped runtime must leave On false after a fresh Brightness",
  );
});

function startProbeFromOff(probe, message) {
  probe.operatorSetOn(true);
  probe.operatorSetOn(false);
  probe.writes.length = 0;
  probe.writeOwnBrightness(BRIGHTNESS_CALLBACK);
  assert.equal(probe.onValue(), true, message);
  assert.equal(probe.writes.at(-1)?.value, true, message);
}

test("a Brightness event on another accessory does not write the probe On", () => {
  const probe = startSandbox();
  startProbeFromOff(probe, "probe must start before the foreign event");
  probe.writes.length = 0;
  probe.writeForeignBrightness(BRIGHTNESS_CALLBACK);
  assert.deepEqual(
    probe.writes,
    [],
    "foreign Brightness must not change the probe light",
  );
});

test("an immediate Brightness write after expiresAt does not write On", () => {
  const probe = startSandbox({ now: 1_000, expiresAt: 2_000 });
  startProbeFromOff(probe, "probe must start before the deadline");
  probe.writes.length = 0;
  probe.writeOwnBrightness(BRIGHTNESS_OUT_OF_BAND);
  probe.advance(1_001);
  probe.writeOwnBrightness(BRIGHTNESS_CALLBACK);
  assert.deepEqual(
    probe.writes,
    [],
    "expiry must stop writes, otherwise a late PASS would be a leftover timer",
  );
});

test("dispose Brightness clears the armed timer and the Brightness subscription", () => {
  const probe = startSandbox();
  startProbeFromOff(probe, "probe must start before dispose");
  probe.writes.length = 0;
  probe.writeOwnBrightness(BRIGHTNESS_ARM);
  probe.writeOwnBrightness(BRIGHTNESS_DISPOSE);
  probe.advance(TIMER_MS);
  assert.deepEqual(
    probe.writes,
    [],
    "dispose must clear the armed timer so it cannot write later",
  );
  probe.operatorSetOn(false);
  probe.writeOwnBrightness(BRIGHTNESS_CALLBACK);
  assert.equal(
    probe.onValue(),
    false,
    "dispose must clear the subscription so a fresh Brightness cannot turn On",
  );
  assert.deepEqual(probe.writes, []);
});
