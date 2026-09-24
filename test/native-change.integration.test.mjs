import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serial = "native-change-test-hub";
const homeRef = `spruthub://hub/${serial}`;
const accessoryRef = `${homeRef}/accessory/34`;
const workshopRoomRef = `${homeRef}/room/2`;
const characteristicRef = `spruthub://hub/${serial}/accessory/34/service/13/characteristic/15`;
const climateServiceRef = `spruthub://hub/${serial}/accessory/34/service/14`;
const climateSettings = [
  {
    ref: `${climateServiceRef}/characteristic/30`,
    type: "TargetTemperature",
    baseline: 21,
    requested: 23,
    kind: "doubleValue",
  },
  {
    ref: `${climateServiceRef}/characteristic/31`,
    type: "TargetHeatingCoolingState",
    baseline: 1,
    requested: 2,
    kind: "intValue",
  },
  {
    ref: `${climateServiceRef}/characteristic/32`,
    type: "C_FanSpeed",
    baseline: 30,
    requested: 60,
    kind: "intValue",
  },
];
const motionCharacteristicRef = `spruthub://hub/${serial}/accessory/32/service/13/characteristic/15`;
const serviceRef = `spruthub://hub/${serial}/accessory/34/service/13`;
const smoothLogicType = "SmoothBrightnessChange";
const smoothLogicRef = `${serviceRef}/logic/${smoothLogicType}`;
const scenarioRef = `spruthub://hub/${serial}/scenario/existing-block`;
const existingBlockWindowKey = "opaque-scenario-window-7f2a";
const scenarioWindowRef = `${homeRef}/window/${encodeURIComponent(existingBlockWindowKey)}`;
const scenarioSdk = `interface Hub {
  getCharacteristic(aId: number, sId: number, cId: number): Characteristic;
}
interface Cron {
  schedule(expression: String, handler: Function): Task;
}
interface Mail {
  /** @param password Пароль пользователя */
  password(password: String): Mail;
}
interface SSH {
  /** @param password Пароль пользователя */
  password(password: String): SSH;
}
declare function setTimeout(handler: Function, timeout?: number, ...arguments: any[]): Task;`;
const firstLogicSource = `info = {
  name: "Bedside start level",
  description: "Set the initial brightness once",
  version: "1.0",
  author: "sprut-agent",
  onStart: false,
  sourceServices: [HS.Lightbulb],
  sourceCharacteristics: [HC.On],
  options: [],
  variables: { wasOn: false }
};

function trigger(source, value, variables, options, context) {
  if (value === true && variables.wasOn === false) {
    source.getService().getCharacteristic(HC.Brightness).setValue(15);
  }
  variables.wasOn = value === true;
}`;
const secondLogicSource = firstLogicSource
  .replace('name: "Bedside start level"', 'name: "Updated bedside level"')
  .replace(
    'description: "Set the initial brightness once"',
    'description: "Set the updated brightness once"',
  )
  .replace("setValue(15)", "setValue(25)");
const nativeLogicDescriptions = [
  {
    source: firstLogicSource,
    description: "Set the initial brightness once",
  },
  {
    source: secondLogicSource,
    description: "Set the updated brightness once",
  },
];

function nativeLogicDescription(source) {
  return nativeLogicDescriptions.find(({ source: snapshot }) =>
    source.startsWith(snapshot),
  )?.description;
}
const deviceWindowRef = `${homeRef}/window/Controller%2Fzigbee_demo%2FChild%2FDEVICE_A%2F`;
const startupOptionKey = "/11/0006_OnOff/4003_StartUpOnOff/255";
const smoothOptionKeys = {
  start: "StartValue",
  end: "EndValue",
  duration: "Duration",
};
const characteristicOptionKeys = {
  primary: "primary",
  switchOffTime: "SwitchOffTime",
  showAllEvents: "ShowAllEvents",
  retryCount: "RetryCount",
  mode: "Mode",
};

function sensitiveListOption() {
  return {
    key: "AccessToken",
    name: "Access token",
    type: "GenericString",
    inputType: "LIST",
    read: true,
    write: true,
    disabled: false,
    value: { stringValue: "LEAK" },
    validValues: [
      { name: "Current", value: { stringValue: "LEAK" } },
      { name: "Replacement", value: { stringValue: "SAFE" } },
    ],
  };
}

function motionCharacteristicOptions() {
  return [
    {
      key: characteristicOptionKeys.primary,
      name: "Основное",
      type: "GenericInteger",
      inputType: "GROUP",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: 0 },
    },
    {
      key: characteristicOptionKeys.switchOffTime,
      name: "Выключить через (сек.)",
      type: "GenericDouble",
      inputType: "NUMBER",
      read: true,
      write: true,
      disabled: false,
      value: { doubleValue: 180 },
    },
    {
      key: characteristicOptionKeys.showAllEvents,
      name: "Выводить все события в лог",
      type: "GenericBoolean",
      inputType: "CHECKBOX",
      read: true,
      write: true,
      disabled: false,
      value: { boolValue: false },
    },
    {
      key: characteristicOptionKeys.retryCount,
      name: "Число повторов",
      type: "GenericLong",
      inputType: "NUMBER",
      read: true,
      write: true,
      disabled: false,
      minValue: 0,
      maxValue: 4,
      minStep: 1,
      value: { longValue: 0 },
    },
    {
      key: characteristicOptionKeys.mode,
      name: "Режим",
      type: "GenericInteger",
      inputType: "LIST",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: 0 },
      validValues: [
        { name: "Обычный", value: { intValue: 0 } },
        { name: "Подробный", value: { intValue: 1 } },
        { name: "Ручной", value: { intValue: 2 } },
      ],
    },
  ];
}

function smoothLogicOptions() {
  return [
    {
      key: "Primary",
      name: "Плавное изменение яркости",
      type: "Group",
      inputType: "GROUP",
      read: true,
      write: false,
      disabled: false,
    },
    {
      key: smoothOptionKeys.start,
      name: "Начальная яркость",
      type: "GenericInteger",
      inputType: "NUMBER",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: 1 },
    },
    {
      key: smoothOptionKeys.end,
      name: "Конечная яркость",
      type: "GenericInteger",
      inputType: "NUMBER",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: 100 },
    },
    {
      key: smoothOptionKeys.duration,
      name: "Продолжительность",
      type: "GenericInteger",
      inputType: "NUMBER",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: 900 },
    },
  ];
}

function logicOptionsKey(aId, sId, type) {
  return `${aId}:${sId}:${type}`;
}

function configuredSmoothLogicOptions(state) {
  return state.logicOptions[logicOptionsKey(34, 13, smoothLogicType)];
}

function installClimateFixture(hub) {
  hub.state.accessories[1].services.push({
    aId: 34,
    sId: 14,
    name: "Климат офиса",
    type: "HeaterCooler",
    characteristics: climateSettings.map(({ type, baseline, kind }, index) => ({
      aId: 34,
      sId: 14,
      cId: 30 + index,
      control: {
        name: type,
        type,
        read: true,
        write: true,
        ...(type === "TargetTemperature"
          ? { minValue: 10, maxValue: 30, minStep: 0.5 }
          : type === "TargetHeatingCoolingState"
            ? {
                validValues: [
                  { key: "OFF", name: "Выключено", value: { intValue: 0 } },
                  { key: "HEAT", name: "Нагрев", value: { intValue: 1 } },
                  { key: "COOL", name: "Охлаждение", value: { intValue: 2 } },
                ],
              }
            : { minValue: 0, maxValue: 100, minStep: 10 }),
        value: { [kind]: baseline },
      },
    })),
  });
}

function currentCharacteristicValue(hub, ref) {
  const match =
    /\/accessory\/(\d+)\/service\/(\d+)\/characteristic\/(\d+)$/.exec(ref);
  assert.ok(match, `unexpected characteristic ref: ${ref}`);
  const [, aId, sId, cId] = match.map(Number);
  return hub.state.accessories
    .find(({ id }) => id === aId)
    ?.services.find((service) => service.sId === sId)
    ?.characteristics.find((characteristic) => characteristic.cId === cId)
    ?.control.value;
}

function climateControl(hub, type) {
  return hub.state.accessories
    .flatMap(({ services = [] }) => services)
    .flatMap(({ characteristics = [] }) => characteristics)
    .find(({ control }) => control.type === type).control;
}

function scenarioOptionsWindow({ name, desc, windowKey }) {
  return {
    windowKey,
    label: { text: "Настройки сценария" },
    options: [
      {
        key: "Name",
        name: "Имя",
        type: "GenericString",
        inputType: "TEXT",
        read: true,
        write: true,
        disabled: false,
        value: { stringValue: name },
      },
      {
        key: "Desc",
        name: "Описание",
        type: "GenericString",
        inputType: "TEXT_MULTILINE",
        read: true,
        write: true,
        disabled: false,
        value: { stringValue: desc },
      },
    ],
  };
}

function windowByKey(state, windowKey) {
  if (state.window?.windowKey === windowKey) return state.window;
  return state.windows[windowKey] ?? null;
}

function syncScenarioMetadataFromWindow(state, window) {
  const scenario = state.scenarios.find(
    (candidate) => candidate.optionsWindow === window.windowKey,
  );
  if (!scenario) return;
  const name = window.options.find(({ key }) => key === "Name")?.value
    ?.stringValue;
  const desc = window.options.find(({ key }) => key === "Desc")?.value
    ?.stringValue;
  if (typeof name === "string") scenario.name = name;
  if (typeof desc === "string") scenario.desc = desc;
}

function setScenarioMetadata(hub, { name, desc, index = "existing-block" }) {
  const scenario = hub.state.scenarios.find((item) => item.index === index);
  assert.ok(scenario, `missing scenario ${index}`);
  if (typeof name === "string") scenario.name = name;
  if (typeof desc === "string") scenario.desc = desc;
  const window = windowByKey(hub.state, scenario.optionsWindow);
  if (!window) return;
  if (typeof name === "string") {
    const option = window.options.find(({ key }) => key === "Name");
    if (option) option.value = { stringValue: name };
  }
  if (typeof desc === "string") {
    const option = window.options.find(({ key }) => key === "Desc");
    if (option) option.value = { stringValue: desc };
  }
}

function windowUpdates(hub) {
  return hub.requests.filter(({ window }) => window?.update);
}

function characteristicUpdates(hub) {
  return hub.requests.filter(({ characteristic }) => characteristic?.update);
}

function scenarioDeletes(hub) {
  return hub.requests.filter(({ scenario }) => scenario?.delete);
}

async function prepareBlockNameAndDesc(
  client,
  { name, desc, nameReason, descReason },
) {
  const renamed = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
      value: name,
      reason: nameReason,
    },
  });
  assert.equal(renamed.structuredContent.status, "prepared");
  const described = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Desc",
      value: desc,
      reason: descReason,
    },
  });
  assert.equal(described.structuredContent.status, "prepared");
  return {
    nameRef: renamed.structuredContent.change_ref,
    descRef: described.structuredContent.change_ref,
  };
}

function assignedSmoothLogic({ active = false } = {}) {
  return {
    aId: 34,
    sId: 13,
    type: smoothLogicType,
    name: "Плавное изменение яркости",
    active,
    optionsWindow: `Logic/${smoothLogicType}/34/13`,
  };
}

function setAction({
  aId = 34,
  sId = 13,
  cId = 15,
  hs = "Lightbulb",
  hc = "On",
  value = "true",
} = {}) {
  return {
    type: "service",
    aId,
    sId,
    hs,
    characteristics: [{ type: "set", cId, hc, value }],
  };
}

function characteristicCondition({
  aId = 32,
  sId = 13,
  cId = 15,
  trigger = true,
} = {}) {
  return {
    type: "characteristic",
    aId,
    sId,
    cId,
    hs: "MotionSensor",
    hc: "MotionDetected",
    trigger,
    cond: "=",
    value: "true",
    timeCond: "",
    time: 0,
  };
}

function blockData({ delay = 60_000, nested = false } = {}) {
  const delayedOff = {
    type: "delay",
    index: 1,
    mode: "RESET",
    time: delay,
    targets: [setAction({ value: "false" })],
  };
  return {
    vendorConfiguration: { preserved: true },
    targets: [
      {
        type: "if",
        mode: "EVERY",
        if: {
          type: "condition",
          mode: nested ? "OR" : "AND",
          conditions: [
            characteristicCondition(),
            ...(nested
              ? [
                  {
                    type: "condition",
                    mode: "AND",
                    conditions: [characteristicCondition({ trigger: false })],
                  },
                ]
              : []),
          ],
        },
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
        then: [setAction(), delayedOff],
        else: nested ? [setAction({ value: "false" })] : [],
        then_delay: 0,
        else_delay: 0,
      },
    ],
  };
}

function dailyCron(hour, minute) {
  return {
    type: "cron",
    mode: "NONE",
    cron: `0 ${minute} ${hour} ? * * *`,
    offset: 0,
  };
}

function parseNativeRefIds(ref) {
  const match =
    /\/accessory\/(\d+)\/service\/(\d+)(?:\/characteristic\/(\d+))?$/.exec(ref);
  assert.ok(match, `unexpected native ref: ${ref}`);
  return {
    aId: Number(match[1]),
    sId: Number(match[2]),
    ...(match[3] === undefined ? {} : { cId: Number(match[3]) }),
  };
}

function publishedBlockNode(contract, kind) {
  const node = contract.supported?.nodes?.[kind];
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw new Error(`BLOCK contract does not publish node ${kind}`);
  }
  return node;
}

function publishedChild(form, field, shape) {
  const rule = form.children?.[field];
  if (
    rule === null ||
    typeof rule !== "object" ||
    Array.isArray(rule) ||
    rule.shape !== shape ||
    !Array.isArray(rule.types)
  ) {
    throw new Error(
      `BLOCK ${form.type ?? "root"} does not publish ${shape} child ${field}`,
    );
  }
  return rule;
}

function publishedPredicateField(form, childType) {
  const matches = Object.entries(form.children ?? {}).filter(
    ([, rule]) =>
      rule?.shape === "single" &&
      Array.isArray(rule.types) &&
      rule.types.includes(childType),
  );
  if (matches.length !== 1) {
    throw new Error(
      `BLOCK ${form.type ?? "root"} does not publish one scalar child for ${childType}`,
    );
  }
  return matches[0][0];
}

function publishedNativeIds(form, ids) {
  if (!Array.isArray(form.native_ids) || form.native_ids.length === 0) {
    throw new Error(`BLOCK ${form.type} does not publish native_ids`);
  }
  const selected = {};
  for (const key of form.native_ids) {
    if (!Number.isSafeInteger(ids[key])) {
      throw new Error(`missing native id ${key} for ${form.type}`);
    }
    selected[key] = ids[key];
  }
  return selected;
}

function requiredFieldSpec(form, name) {
  const spec = form.fields?.[name];
  if ((form.editor_optional ?? []).includes(name)) {
    throw new Error(
      `BLOCK ${form.type} publishes required field ${name} as optional`,
    );
  }
  if (spec === undefined) {
    throw new Error(
      `BLOCK ${form.type} does not publish required field ${name}`,
    );
  }
  return spec;
}

function requiredFieldName(form, name) {
  requiredFieldSpec(form, name);
  return name;
}

function entityType(result) {
  const type = result?.structuredContent?.entity?.type;
  if (typeof type !== "string" || type.length === 0) {
    throw new Error("get_entity did not return a native type");
  }
  return type;
}

function publishedNativeType(form, field, entityResult) {
  const expectedSource =
    field === "hs"
      ? "service_type_from_get_entity"
      : "characteristic_type_from_get_entity";
  if (requiredFieldSpec(form, field) !== expectedSource) {
    throw new Error(
      `BLOCK ${form.type}.${field} does not publish ${expectedSource}`,
    );
  }
  return entityType(entityResult);
}

function publishedScalarString(form, value) {
  const encoding = form.value_encoding;
  if (encoding?.form !== "native_scalar_as_string") {
    throw new Error(
      `BLOCK ${form.type} does not publish native scalar string encoding`,
    );
  }
  if (typeof value === "boolean") {
    const token = encoding.bool?.[value];
    if (token !== (value ? "true" : "false")) {
      throw new Error(
        `BLOCK ${form.type} does not publish lowercase bool scalar strings`,
      );
    }
    return token;
  }
  if (typeof value === "number") {
    if (
      Number.isInteger(value) &&
      encoding.integer !== "optional_minus_digits"
    ) {
      throw new Error(
        `BLOCK ${form.type} does not publish integer scalar strings`,
      );
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (encoding.string !== "literal") {
      throw new Error(
        `BLOCK ${form.type} does not publish literal string scalars`,
      );
    }
    return value;
  }
  throw new Error(`unsupported ${form.type} value`);
}

function nativeDelayTimeFromContract(contract, { seconds }) {
  const form = publishedBlockNode(contract, "delay");
  const spec = requiredFieldSpec(form, "time");
  if (spec.type !== "integer" || spec.unit !== "milliseconds") {
    throw new Error("BLOCK delay.time does not publish native milliseconds");
  }
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error("household delay seconds must be a positive integer");
  }
  return seconds * 1000;
}

function preparedDelayTimes(data) {
  const times = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (node.type === "delay" && "time" in node) times.push(node.time);
    for (const value of Object.values(node)) visit(value);
  };
  visit(data);
  return times;
}

function assembleCronFromContract(contract, hhmm) {
  const [hour, minute] = hhmm.split(":").map(Number);
  const form = publishedBlockNode(contract, "cron");
  const template =
    contract.supported?.daily_interval?.native_shape?.start ??
    contract.supported?.daily_interval?.native_shape?.end;
  if (template === null || typeof template !== "object") {
    throw new Error("BLOCK contract does not publish daily cron shape");
  }
  return {
    ...structuredClone(template),
    ...structuredClone(form.constants ?? {}),
    cron: String(template.cron)
      .replace("MM", String(minute))
      .replace("HH", String(hour)),
  };
}

function assembleIntervalFromContract(contract, { start, end, trigger }) {
  const form = publishedBlockNode(contract, "interval");
  const startField = "start";
  const endField = "end";
  publishedChild(form, startField, "single");
  publishedChild(form, endField, "single");
  if (form.fields?.trigger !== "boolean") {
    throw new Error("BLOCK interval does not publish trigger");
  }
  return {
    type: form.type,
    trigger,
    [startField]: assembleCronFromContract(contract, start),
    [endField]: assembleCronFromContract(contract, end),
  };
}

function assembleCharacteristicFromContract(
  contract,
  { ref, service, characteristic, trigger, cond, value },
) {
  const form = publishedBlockNode(contract, "characteristic");
  const hs = requiredFieldName(form, "hs");
  const hc = requiredFieldName(form, "hc");
  const triggerField = requiredFieldName(form, "trigger");
  const condField = requiredFieldName(form, "cond");
  const valueField = requiredFieldName(form, "value");
  return {
    type: form.type,
    ...publishedNativeIds(form, parseNativeRefIds(ref)),
    [hs]: publishedNativeType(form, hs, service),
    [hc]: publishedNativeType(form, hc, characteristic),
    [triggerField]: trigger,
    [condField]: cond,
    [valueField]: publishedScalarString(form, value),
    ...structuredClone(form.constants ?? {}),
  };
}

function assembleServiceSetFromContract(
  contract,
  { ref, service, characteristic, value },
) {
  const serviceForm = publishedBlockNode(contract, "service");
  const setForm = publishedBlockNode(contract, "set");
  const ids = parseNativeRefIds(ref);
  const setField = Object.entries(serviceForm.children ?? {}).find(
    ([, rule]) =>
      rule?.shape === "array" &&
      Array.isArray(rule.types) &&
      rule.types.includes("set"),
  )?.[0];
  if (setField === undefined) {
    throw new Error("BLOCK service does not publish set children");
  }
  const hs = requiredFieldName(serviceForm, "hs");
  const hc = requiredFieldName(setForm, "hc");
  const valueField = requiredFieldName(setForm, "value");
  return {
    type: serviceForm.type,
    ...publishedNativeIds(serviceForm, ids),
    [hs]: publishedNativeType(serviceForm, hs, service),
    [setField]: [
      {
        type: setForm.type,
        ...publishedNativeIds(setForm, ids),
        [hc]: publishedNativeType(setForm, hc, characteristic),
        [valueField]: publishedScalarString(setForm, value),
      },
    ],
  };
}

function assembleDelayFromContract(contract, { afterSeconds, targets }) {
  const form = publishedBlockNode(contract, "delay");
  const targetsField = Object.entries(form.children ?? {}).find(
    ([, rule]) =>
      rule?.shape === "array" &&
      Array.isArray(rule.types) &&
      rule.types.includes(targets[0]?.type),
  )?.[0];
  if (targetsField === undefined) {
    throw new Error("BLOCK delay does not publish action children");
  }
  if (form.fields?.index?.type !== "integer") {
    throw new Error("BLOCK delay does not publish index");
  }
  return {
    type: form.type,
    ...structuredClone(form.constants ?? {}),
    index: form.fields.index.minimum,
    time: nativeDelayTimeFromContract(contract, { seconds: afterSeconds }),
    [targetsField]: targets,
  };
}

function assembleConditionFromContract(contract, children) {
  const form = publishedBlockNode(contract, "condition");
  const conditionsField = Object.entries(form.children ?? {}).find(
    ([, rule]) =>
      rule?.shape === "array" &&
      Array.isArray(rule.types) &&
      children.every((child) => rule.types.includes(child.type)),
  )?.[0];
  if (conditionsField === undefined) {
    throw new Error("BLOCK condition does not publish nested conditions");
  }
  const modes = form.fields?.mode;
  if (!Array.isArray(modes) || !modes.includes("AND")) {
    throw new Error("BLOCK condition does not publish AND/OR modes");
  }
  return {
    type: form.type,
    mode: "AND",
    [conditionsField]: children,
  };
}

function assembleIfFromContract(contract, { when, thenActions, elseActions }) {
  const form = publishedBlockNode(contract, "if");
  if ((form.editor_optional ?? []).includes("state")) {
    throw new Error("BLOCK if publishes hub-assigned state as editor optional");
  }
  if (form.hub_assigned?.state !== "omit_on_create") {
    throw new Error(
      "BLOCK if does not publish hub-assigned state omit_on_create",
    );
  }
  const predicateField = publishedPredicateField(form, when.type);
  const thenField = "then";
  const elseField = "else";
  publishedChild(form, thenField, "array");
  publishedChild(form, elseField, "array");
  return {
    type: form.type,
    ...structuredClone(form.constants ?? {}),
    [predicateField]: when,
    [thenField]: thenActions,
    [elseField]: elseActions,
  };
}

function assembleSupportedBlockFromContract(contract, { targets }) {
  const form = publishedBlockNode(contract, "root");
  const targetsField = Object.entries(form.children ?? {}).find(
    ([, rule]) =>
      rule?.shape === "array" &&
      Array.isArray(rule.types) &&
      targets.every((child) => rule.types.includes(child.type)),
  )?.[0];
  if (targetsField === undefined) {
    throw new Error("BLOCK root does not publish supported targets");
  }
  return { [targetsField]: targets };
}

// Fills a published time-trigger form token by token, e.g. MM, HH, DAYS.
function assembleTimeTriggerFromContract(
  contract,
  formName,
  { mode, offsetMinutes = 0, ...tokens },
) {
  const trigger = contract.supported?.time_trigger;
  const form = trigger?.forms?.[formName];
  if (trigger?.node !== "cron" || form === null || typeof form !== "object") {
    throw new Error(`BLOCK contract does not publish time trigger ${formName}`);
  }
  if (
    !publishedChild(
      publishedBlockNode(contract, "condition"),
      "conditions",
      "array",
    ).types.includes("cron")
  ) {
    throw new Error("BLOCK condition does not accept a cron trigger");
  }
  const selectedMode = Array.isArray(form.mode) ? mode : form.mode;
  if (Array.isArray(form.mode) && !form.mode.includes(mode)) {
    throw new Error(`time trigger ${formName} does not publish mode ${mode}`);
  }
  let offset = form.offset;
  if (typeof form.offset === "object") {
    if (form.offset.unit !== "minutes") {
      throw new Error(`time trigger ${formName} offset is not in minutes`);
    }
    offset = offsetMinutes;
  }
  return {
    type: "cron",
    mode: selectedMode,
    cron: form.cron
      .split(" ")
      .map((token) =>
        Object.hasOwn(tokens, token) ? String(tokens[token]) : token,
      )
      .join(" "),
    offset,
  };
}

function scenarioData(hub, index) {
  return JSON.parse(
    hub.state.scenarios.find((item) => item.index === index).data,
  );
}

function dailyIntervalBlockData({
  start = [22, 30],
  end = [6, 15],
  inside = "true",
  outside = "false",
} = {}) {
  return {
    targets: [
      {
        type: "if",
        mode: "EVERY",
        if: {
          type: "condition",
          mode: "AND",
          conditions: [
            {
              type: "interval",
              start: dailyCron(...start),
              end: dailyCron(...end),
              trigger: true,
            },
          ],
        },
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
        then: [setAction({ value: inside })],
        else: [setAction({ value: outside })],
        then_delay: 0,
        else_delay: 0,
      },
    ],
  };
}

function everyIf({ when, thenActions, elseActions = [] }) {
  return {
    type: "if",
    mode: "EVERY",
    if: when,
    // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
    then: thenActions,
    else: elseActions,
    then_delay: 0,
    else_delay: 0,
  };
}

function conditionGroup(leaf, mode = "AND") {
  return {
    type: "condition",
    mode,
    conditions: [structuredClone(leaf)],
  };
}

const workModeValues = [
  { key: "DAY", name: "День", value: 0 },
  { key: "EVENING", name: "Вечер", value: 1 },
  { key: "NIGHT", name: "Ночь", value: 2 },
  { key: "OFF", name: "Выкл.", value: 3 },
];
const workModeRef = `${homeRef}/accessory/50/service/13/characteristic/15`;
const workModeDay = {
  kind: "intValue",
  value: 0,
  key: "DAY",
  name: "День",
};
const workModeEvening = {
  kind: "intValue",
  value: 1,
  key: "EVENING",
  name: "Вечер",
};
const workModeNight = {
  kind: "intValue",
  value: 2,
  key: "NIGHT",
  name: "Ночь",
};
const workModeOff = {
  kind: "intValue",
  value: 3,
  key: "OFF",
  name: "Выкл.",
};

function installEnumAccessory(hub, { id, name, hs, hc, values, current = 0 }) {
  hub.state.accessories.push(
    boundAccessory({
      id,
      roomId: 1,
      name,
      service: {
        sId: 13,
        name,
        type: hs,
        cId: 15,
        characteristicName: name,
        characteristicType: hc,
        value: { intValue: current },
      },
    }),
  );
  hub.state.accessories.find(
    (accessory) => accessory.id === id,
  ).services[0].characteristics[0].control.validValues = values.map((item) => ({
    key: item.key,
    name: item.name,
    value: { intValue: item.value },
  }));
}

function installWorkModeAccessory(hub) {
  installEnumAccessory(hub, {
    id: 50,
    name: "Режим работы",
    hs: "Fan",
    hc: "C_WorkMode",
    values: workModeValues,
  });
}

function enumEquals({ aId, hs, hc, value, trigger = true }) {
  return {
    type: "characteristic",
    aId,
    sId: 13,
    cId: 15,
    hs,
    hc,
    trigger,
    cond: "=",
    value: String(value),
    timeCond: "",
    time: 0,
  };
}

function workModeEquals(value, trigger = true) {
  return enumEquals({
    aId: 50,
    hs: "Fan",
    hc: "C_WorkMode",
    value,
    trigger,
  });
}

function rootIfBlockData({ when, thenValue = "true", elseValue }) {
  return {
    targets: [
      everyIf({
        when,
        thenActions: [setAction({ value: thenValue })],
        elseActions:
          elseValue === undefined ? [] : [setAction({ value: elseValue })],
      }),
    ],
  };
}

function accessoryGetIds(hub) {
  return hub.requests
    .filter((params) => params.accessory?.get)
    .map((params) => params.accessory.get.id);
}

async function prepareBlockCreate(client, { name, data, reason }) {
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name,
      description: name,
      active: true,
      on_start: false,
      sync: false,
      data,
      reason,
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  return prepared;
}

function previewAction(prepared, pointer, value) {
  const action = prepared.structuredContent.block_action_preview.actions.find(
    (item) =>
      item.configuration_pointer === pointer && item.command.value === value,
  );
  assert.ok(action, `missing preview action ${pointer} ${value}`);
  return action;
}

function singleCharacteristicPredicateBlockData({
  predicate = characteristicCondition(),
  nestedPredicate = characteristicCondition({ trigger: false }),
  siblingMode = "OR",
} = {}) {
  return {
    targets: [
      everyIf({
        when: predicate,
        thenActions: [
          setAction(),
          everyIf({
            when: nestedPredicate,
            thenActions: [
              setAction({ cId: 16, hc: "Brightness", value: "20" }),
            ],
          }),
        ],
        elseActions: [setAction({ value: "false" })],
      }),
      everyIf({
        when: conditionGroup(
          characteristicCondition({ trigger: false }),
          siblingMode,
        ),
        thenActions: [setAction({ value: "false" })],
      }),
    ],
  };
}

function parseScenarioBlockData(payload) {
  if (typeof payload?.data !== "string") return null;
  try {
    return JSON.parse(payload.data);
  } catch {
    return null;
  }
}

function hasDirectCharacteristicIfPredicate(data) {
  let found = false;
  const childFields = {
    root: ["targets"],
    if: ["if", "then", "else"],
    condition: ["conditions"],
    interval: ["start", "end"],
    service: ["characteristics"],
    delay: ["targets"],
  };
  const visit = (node, kind) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    if (kind === "if" && node.if?.type === "characteristic") found = true;
    for (const key of childFields[kind] ?? []) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) visit(child, child?.type);
      } else {
        visit(value, value?.type);
      }
    }
  };
  visit(data, "root");
  return found;
}

function rejectDirectCharacteristicIfPredicate(socket, request, payload) {
  const data = parseScenarioBlockData(payload);
  if (!data || !hasDirectCharacteristicIfPredicate(data)) return false;
  socket.send(
    JSON.stringify({
      id: request.id,
      error: {
        code: 400,
        message: "if predicate must be a condition group",
      },
    }),
  );
  return true;
}

function blockNodeAtPointer(data, pointer) {
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value?.[part], data);
}

function independentlyEnabledPausedAction(data, pointer, now) {
  const wrapper = blockNodeAtPointer(data, pointer);
  assert.equal(wrapper.type, "if");
  assert.equal(wrapper.if.type, "condition");
  assert.equal(wrapper.if.conditions.length, 1);
  const code = wrapper.if.conditions[0];
  assert.equal(code.type, "code");
  const match = /^return Date\.now\(\) >= (\d+);(?: \/\* [^*]+ \*\/)?$/.exec(
    code.code,
  );
  assert.ok(match, `unexpected native deadline condition: ${code.code}`);
  return now >= Number(match[1]) ? wrapper.then[0] : undefined;
}

function withRuntimeBlockFields(data) {
  let nextBlockId = 1;
  const childFields = {
    root: ["targets"],
    if: ["if", "then", "else"],
    condition: ["conditions"],
    interval: ["start", "end"],
    service: ["characteristics"],
    delay: ["targets"],
  };
  const visit = (value, kind) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return structuredClone(value);
    const normalized = structuredClone(value);
    if (kind !== "root") {
      normalized.blockId = nextBlockId++;
      if (kind === "if") normalized.state = false;
    }
    for (const key of childFields[kind] ?? []) {
      normalized[key] = Array.isArray(value[key])
        ? value[key].map((child) => visit(child, child?.type))
        : visit(value[key], value[key]?.type);
    }
    return normalized;
  };
  return visit(data, "root");
}

function scenarioBindingProjection(data, accessories) {
  const rooms = new Set();
  const iconsIf = [];
  const iconsThen = [];
  const seenIf = new Set();
  const seenThen = new Set();
  const addIcon = (list, seen, icon) => {
    if (typeof icon === "string" && !seen.has(icon)) {
      seen.add(icon);
      list.push(icon);
    }
  };
  const visit = (value, region) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, region);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (Number.isInteger(value.aId)) {
      const accessory = accessories.find(({ id }) => id === value.aId);
      if (Number.isInteger(accessory?.roomId)) rooms.add(accessory.roomId);
      const service = accessory?.services?.find(
        (candidate) => candidate.sId === value.sId,
      );
      const icon = service?.type ?? value.hs;
      if (region === "if") addIcon(iconsIf, seenIf, icon);
      if (region === "then") addIcon(iconsThen, seenThen, icon);
    }
    if (Object.hasOwn(value, "if")) visit(value.if, "if");
    if (Object.hasOwn(value, "then")) visit(value.then, "then");
    if (Object.hasOwn(value, "else")) visit(value.else, "then");
    for (const [key, child] of Object.entries(value)) {
      if (key === "if" || key === "then" || key === "else") continue;
      visit(child, region);
    }
  };
  visit(data);
  return {
    rooms: [...rooms].sort((left, right) => left - right),
    iconsIf,
    iconsThen,
  };
}

function boundAccessory({ id, roomId, name, service }) {
  return {
    id,
    roomId,
    name,
    online: true,
    services: [
      {
        aId: id,
        sId: service.sId,
        name: service.name,
        type: service.type,
        characteristics: [
          {
            aId: id,
            sId: service.sId,
            cId: service.cId,
            control: {
              name: service.characteristicName,
              type: service.characteristicType,
              read: true,
              write: true,
              value: service.value,
            },
          },
        ],
      },
    ],
  };
}

async function startHub(port = 0) {
  const requests = [];
  const state = {
    rooms: [
      { id: 1, order: 1, name: "Офис", visible: true },
      { id: 2, order: 2, name: "Мастерская", visible: true },
    ],
    characteristic: {
      aId: 34,
      sId: 13,
      cId: 15,
      control: {
        name: "Включена",
        type: "On",
        read: true,
        write: true,
        value: { boolValue: false },
      },
    },
    externalOn: true,
    accessories: [
      {
        id: 32,
        roomId: 1,
        name: "Датчик",
        online: true,
        services: [
          {
            aId: 32,
            sId: 13,
            name: "Движение",
            type: "MotionSensor",
            characteristics: [
              {
                aId: 32,
                sId: 13,
                cId: 15,
                control: {
                  name: "Движение",
                  type: "MotionDetected",
                  read: true,
                  write: false,
                  value: { boolValue: false },
                },
              },
            ],
          },
        ],
      },
      {
        id: 34,
        roomId: 1,
        name: "Лампа",
        online: true,
        extensionKey: "zigbee_demo",
        deviceId: "DEVICE_A",
        services: [
          {
            aId: 34,
            sId: 13,
            name: "Свет",
            type: "Lightbulb",
            characteristics: [],
          },
        ],
      },
      {
        id: 35,
        roomId: 1,
        name: "Подсветка той же лампы",
        online: true,
        extensionKey: "zigbee_demo",
        deviceId: "DEVICE_A",
        services: [],
      },
    ],
    scenarios: [
      {
        index: "existing-block",
        name: "Существующий BLOCK",
        desc: "Ручная конфигурация",
        active: false,
        onStart: false,
        sync: false,
        type: "BLOCK",
        optionsWindow: existingBlockWindowKey,
        data: JSON.stringify(blockData()),
        vendorTopLevel: "preserve-me",
      },
    ],
    windows: {
      [existingBlockWindowKey]: scenarioOptionsWindow({
        name: "Существующий BLOCK",
        desc: "Ручная конфигурация",
        windowKey: existingBlockWindowKey,
      }),
    },
    nextWindow: 1,
    window: {
      windowKey: "Controller/zigbee_demo/Child/DEVICE_A/",
      label: { text: "Настройки лампы" },
      options: [
        {
          key: startupOptionKey,
          name: "После восстановления питания",
          type: "GenericInteger",
          inputType: "LIST",
          read: true,
          write: true,
          disabled: false,
          value: { intValue: 255 },
          validValues: [
            { name: "Выключена", value: { intValue: 0 }, checked: true },
            { name: "Включена", value: { intValue: 1 }, checked: true },
            {
              name: "Предыдущее состояние",
              value: { intValue: 255 },
              checked: true,
            },
          ],
        },
        {
          key: "/11/0008_Level/4000_Transition/0",
          name: "Плавность включения",
          type: "GenericInteger",
          inputType: "LIST",
          read: true,
          write: true,
          disabled: false,
          value: { intValue: 1 },
          validValues: [
            { name: "Сразу", value: { intValue: 0 } },
            { name: "Плавно", value: { intValue: 1 } },
          ],
        },
      ],
    },
    logicTypes: [
      {
        type: smoothLogicType,
        name: "Плавное изменение яркости",
        desc: "Плавно меняет яркость при включении света",
      },
    ],
    logics: [],
    logicOptions: {
      [logicOptionsKey(34, 13, smoothLogicType)]: smoothLogicOptions(),
    },
    characteristicOptions: motionCharacteristicOptions(),
    scenarioLogicTypes: {},
    scenarioSdk,
    nextScenario: 1,
    behavior: {
      closeAfterCreate: false,
      rejectNextScenarioCreate: false,
      rejectNextScenarioUpdate: false,
      rejectNextScenarioRun: false,
      rejectNextScenarioRunAsUnsupported: false,
      stopAfterAccessoryGet: null,
      closeAfterScenarioUpdate: false,
      closeAfterScenarioRun: false,
      closeAfterCharacteristicUpdate: false,
      dropNextCharacteristicUpdate: false,
      rejectNextCharacteristicUpdate: false,
      closeAfterCharacteristicSetOptions: false,
      dropNextCharacteristicSetOptions: false,
      closeAfterWindowUpdate: false,
      dropNextWindowUpdate: false,
      holdNextWindowUpdate: false,
      failNextCharacteristicGet: false,
      failNextWindowGet: false,
      failWindowGetAfterUpdate: false,
      failNextScenarioGet: false,
      rejectNextWindowUpdate: false,
      ignoreNextUpdate: false,
      invalidNextScenarioList: false,
      missingScenarioGetAsNotFoundError: false,
      rejectScenarioGetAsInternalError: false,
      closeAfterLogicCreate: false,
      closeAfterLogicSetOptions: false,
      failNextLogicList: false,
      closeAfterAccessoryUpdate: false,
      closeAfterRoomCreate: false,
      dropNextAccessoryUpdate: false,
      failAccessoryGetAfterUpdate: false,
      failNextAccessoryGet: false,
      invalidNextRoomList: false,
      missingRoomGetAsNotFoundError: false,
      normalizeNextAccessoryName: false,
      rejectNextRoomGetAsInternalError: false,
      recalculateBlockRooms: false,
      projectBlockDerivedFields: false,
    },
  };
  state.accessories[1].services[0].characteristics.push(state.characteristic);
  state.accessories[1].services[0].characteristics.push(
    {
      aId: 34,
      sId: 13,
      cId: 16,
      control: {
        name: "Яркость",
        type: "Brightness",
        read: true,
        write: true,
        minValue: 0,
        maxValue: 100,
        minStep: 1,
        value: { intValue: 20 },
      },
    },
    {
      aId: 34,
      sId: 13,
      cId: 17,
      control: {
        name: "Только чтение",
        type: "StatusActive",
        read: true,
        write: false,
        value: { boolValue: true },
      },
    },
    {
      aId: 34,
      sId: 13,
      cId: 18,
      control: {
        name: "Режим",
        type: "TargetMode",
        read: true,
        write: true,
        value: { stringValue: "home" },
        validValues: [
          {
            key: "home",
            name: "Дома",
            value: { stringValue: "home" },
          },
          {
            key: "away",
            name: "Вне дома",
            value: { stringValue: "away" },
          },
        ],
      },
    },
  );
  const server = new WebSocketServer({ port });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", async (data) => {
      const request = JSON.parse(data.toString());
      requests.push(structuredClone(request.params));
      const params = request.params;
      if (
        (params.characteristic?.get &&
          state.behavior.failNextCharacteristicGet) ||
        (params.accessory?.get && state.behavior.failNextAccessoryGet) ||
        (params.window?.get && state.behavior.failNextWindowGet) ||
        (params.scenario?.get && state.behavior.failNextScenarioGet) ||
        (params.logic?.list && state.behavior.failNextLogicList)
      ) {
        state.behavior.failNextCharacteristicGet = false;
        state.behavior.failNextAccessoryGet = false;
        state.behavior.failNextWindowGet = false;
        state.behavior.failNextScenarioGet = false;
        state.behavior.failNextLogicList = false;
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: 500, message: "temporary read failure" },
          }),
        );
        return;
      }
      let result;
      if (params.hub?.list) {
        result = {
          hub: {
            list: {
              hubs: [{ serial, name: "Тестовый дом", online: true }],
            },
          },
        };
      } else if (params.room?.list) {
        if (state.behavior.invalidNextRoomList) {
          state.behavior.invalidNextRoomList = false;
          result = { room: { list: { rooms: {} } } };
        } else {
          result = { room: { list: { rooms: structuredClone(state.rooms) } } };
        }
      } else if (params.room?.get) {
        const room = state.rooms.find(({ id }) => id === params.room.get.id);
        if (
          state.behavior.rejectNextRoomGetAsInternalError ||
          (!room && state.behavior.missingRoomGetAsNotFoundError)
        ) {
          state.behavior.rejectNextRoomGetAsInternalError = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: {
                code: -32603,
                message: "Not found: 'Комната уже не существует'",
              },
            }),
          );
          return;
        }
        result = {
          room: {
            get: structuredClone(room) ?? null,
          },
        };
      } else if (params.room?.create) {
        const room = {
          id: Math.max(...state.rooms.map(({ id }) => id), 0) + 1,
          order: state.rooms.length + 1,
          name: params.room.create.name,
          visible: true,
        };
        state.rooms.push(room);
        if (state.behavior.closeAfterRoomCreate) {
          state.behavior.closeAfterRoomCreate = false;
          socket.close();
          return;
        }
        result = { room: { create: structuredClone(room) } };
      } else if (params.room?.delete) {
        const roomIndex = state.rooms.findIndex(
          ({ id }) => id === params.room.delete.id,
        );
        if (roomIndex >= 0) state.rooms.splice(roomIndex, 1);
        result = { room: { delete: {} } };
      } else if (params.room?.update) {
        // RoomUpdateRequest {id, name, visible}: only present fields change.
        const update = params.room.update;
        const room = state.rooms.find(({ id }) => id === update.id);
        if (room && Object.hasOwn(update, "name")) room.name = update.name;
        if (room && Object.hasOwn(update, "visible")) {
          room.visible = update.visible;
        }
        result = { room: { update: {} } };
      } else if (params.service?.update) {
        // ServiceUpdateRequest {aId, sId, order, grid, name, visible}.
        const update = params.service.update;
        const service = state.accessories
          .find(({ id }) => id === update.aId)
          ?.services.find(({ sId }) => sId === update.sId);
        if (service && Object.hasOwn(update, "name")) {
          service.name = update.name;
        }
        if (service && Object.hasOwn(update, "visible")) {
          service.visible = update.visible;
        }
        result = { service: { update: {} } };
      } else if (params.characteristic?.get) {
        const selected = state.accessories
          .find(({ id }) => id === params.characteristic.get.aId)
          ?.services.find(({ sId }) => sId === params.characteristic.get.sId)
          ?.characteristics.find(
            ({ cId }) => cId === params.characteristic.get.cId,
          );
        result = {
          characteristic: { get: structuredClone(selected) ?? null },
        };
      } else if (params.characteristic?.getOptions) {
        const { aId, sId, cId } = params.characteristic.getOptions;
        result = {
          characteristic: {
            getOptions: {
              options:
                aId === 32 && sId === 13 && cId === 15
                  ? structuredClone(state.characteristicOptions)
                  : [],
            },
          },
        };
      } else if (params.characteristic?.setOptions) {
        if (state.behavior.dropNextCharacteristicSetOptions) {
          state.behavior.dropNextCharacteristicSetOptions = false;
          socket.close();
          return;
        }
        for (const update of params.characteristic.setOptions.options) {
          const option = state.characteristicOptions.find(
            ({ key }) => key === update.key,
          );
          if (option) option.value = structuredClone(update.value);
        }
        if (state.behavior.closeAfterCharacteristicSetOptions) {
          state.behavior.closeAfterCharacteristicSetOptions = false;
          socket.close();
          return;
        }
        result = { characteristic: { setOptions: {} } };
      } else if (params.window?.get) {
        const window = windowByKey(state, params.window.get.windowKey);
        result = { window: { get: structuredClone(window) ?? null } };
      } else if (params.window?.update) {
        if (state.behavior.rejectNextWindowUpdate) {
          state.behavior.rejectNextWindowUpdate = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: 400, message: "window update rejected" },
            }),
          );
          return;
        }
        const window = windowByKey(state, params.window.update.windowKey);
        if (!state.behavior.dropNextWindowUpdate && window) {
          for (const update of params.window.update.options) {
            const option = window.options.find(({ key }) => key === update.key);
            if (option) option.value = structuredClone(update.value);
          }
          syncScenarioMetadataFromWindow(state, window);
        }
        state.behavior.dropNextWindowUpdate = false;
        if (state.behavior.holdNextWindowUpdate) {
          state.behavior.holdNextWindowUpdate = false;
          return;
        }
        if (state.behavior.failWindowGetAfterUpdate) {
          state.behavior.failWindowGetAfterUpdate = false;
          state.behavior.failNextWindowGet = true;
        }
        if (state.behavior.closeAfterWindowUpdate) {
          state.behavior.closeAfterWindowUpdate = false;
          socket.close();
          return;
        }
        result = { window: { update: {} } };
      } else if (params.characteristic?.update) {
        if (state.behavior.rejectNextCharacteristicUpdate) {
          state.behavior.rejectNextCharacteristicUpdate = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: 400, message: "characteristic update rejected" },
            }),
          );
          return;
        }
        const selected = state.accessories
          .find(({ id }) => id === params.characteristic.update.aId)
          ?.services.find(({ sId }) => sId === params.characteristic.update.sId)
          ?.characteristics.find(
            ({ cId }) => cId === params.characteristic.update.cId,
          );
        if (!state.behavior.dropNextCharacteristicUpdate && selected) {
          selected.control.value = structuredClone(
            params.characteristic.update.control.value,
          );
        }
        if (
          selected?.control.type === "On" &&
          Object.hasOwn(params.characteristic.update.control.value, "boolValue")
        ) {
          state.externalOn =
            params.characteristic.update.control.value.boolValue;
        }
        if (state.behavior.dropNextCharacteristicUpdate) {
          state.behavior.dropNextCharacteristicUpdate = false;
          socket.close();
          return;
        }
        if (state.behavior.closeAfterCharacteristicUpdate) {
          state.behavior.closeAfterCharacteristicUpdate = false;
          socket.close();
          return;
        }
        result = { characteristic: { update: {} } };
      } else if (params.logic?.types) {
        result = {
          logic: { types: { logicTypes: structuredClone(state.logicTypes) } },
        };
      } else if (params.logic?.list) {
        result = {
          logic: {
            list: {
              logics: state.logics
                .filter(
                  ({ aId, sId }) =>
                    aId === params.logic.list.aId &&
                    sId === params.logic.list.sId,
                )
                .map((logic) => structuredClone(logic)),
            },
          },
        };
      } else if (params.logic?.get) {
        const logic = state.logics.find(
          ({ aId, sId, type }) =>
            aId === params.logic.get.aId &&
            sId === params.logic.get.sId &&
            type === params.logic.get.type,
        );
        if (!logic) {
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: -32603, message: "Not found" },
            }),
          );
          return;
        }
        result = { logic: { get: structuredClone(logic) } };
      } else if (params.logic?.getOptions) {
        const logic = state.logics.find(
          ({ aId, sId, type }) =>
            aId === params.logic.getOptions.aId &&
            sId === params.logic.getOptions.sId &&
            type === params.logic.getOptions.type,
        );
        if (!logic) {
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: -32603, message: "Not found" },
            }),
          );
          return;
        }
        result = {
          logic: {
            getOptions: {
              options: structuredClone(
                state.logicOptions[
                  logicOptionsKey(logic.aId, logic.sId, logic.type)
                ],
              ),
            },
          },
        };
      } else if (params.logic?.create) {
        const created = {
          ...structuredClone(params.logic.create),
          active: false,
          optionsWindow: `Logic/${params.logic.create.type}/34/13`,
        };
        state.logics.push(created);
        if (state.behavior.closeAfterLogicCreate) {
          state.behavior.closeAfterLogicCreate = false;
          socket.close();
          return;
        }
        result = { logic: { create: structuredClone(created) } };
      } else if (params.logic?.setOptions) {
        const options =
          state.logicOptions[
            logicOptionsKey(
              params.logic.setOptions.aId,
              params.logic.setOptions.sId,
              params.logic.setOptions.type,
            )
          ];
        for (const update of params.logic.setOptions.options) {
          const option = options.find(({ key }) => key === update.key);
          if (option) option.value = structuredClone(update.value);
        }
        if (state.behavior.closeAfterLogicSetOptions) {
          state.behavior.closeAfterLogicSetOptions = false;
          socket.close();
          return;
        }
        result = { logic: { setOptions: {} } };
      } else if (params.logic?.update) {
        const logic = state.logics.find(
          ({ aId, sId, type }) =>
            aId === params.logic.update.aId &&
            sId === params.logic.update.sId &&
            type === params.logic.update.type,
        );
        if (logic) logic.active = params.logic.update.active;
        result = { logic: { update: {} } };
      } else if (params.logic?.delete) {
        const index = state.logics.findIndex(
          ({ aId, sId, type }) =>
            aId === params.logic.delete.aId &&
            sId === params.logic.delete.sId &&
            type === params.logic.delete.type,
        );
        if (index >= 0) state.logics.splice(index, 1);
        result = { logic: { delete: {} } };
      } else if (params.accessory?.get) {
        result = {
          accessory: {
            get:
              structuredClone(
                state.accessories.find(
                  ({ id }) => id === params.accessory.get.id,
                ),
              ) ?? null,
          },
        };
      } else if (params.accessory?.list) {
        result = {
          accessory: {
            list: {
              accessories: state.accessories
                .filter(
                  ({ roomId }) =>
                    params.accessory.list.roomId === undefined ||
                    roomId === params.accessory.list.roomId,
                )
                .map((accessory) => structuredClone(accessory)),
            },
          },
        };
      } else if (params.accessory?.update) {
        const accessory = state.accessories.find(
          ({ id }) => id === params.accessory.update.id,
        );
        if (accessory && !state.behavior.dropNextAccessoryUpdate) {
          accessory.name = state.behavior.normalizeNextAccessoryName
            ? params.accessory.update.name.replace(/\s*·\s*/g, " ")
            : params.accessory.update.name;
          accessory.roomId = params.accessory.update.roomId;
        }
        state.behavior.dropNextAccessoryUpdate = false;
        state.behavior.normalizeNextAccessoryName = false;
        if (state.behavior.failAccessoryGetAfterUpdate) {
          state.behavior.failAccessoryGetAfterUpdate = false;
          state.behavior.failNextAccessoryGet = true;
        }
        if (state.behavior.closeAfterAccessoryUpdate) {
          state.behavior.closeAfterAccessoryUpdate = false;
          socket.close();
          return;
        }
        result = { accessory: { update: {} } };
      } else if (params.scenario?.list) {
        if (state.behavior.invalidNextScenarioList) {
          state.behavior.invalidNextScenarioList = false;
          result = { scenario: { list: { scenarios: {} } } };
        } else {
          result = {
            scenario: {
              list: {
                scenarios: state.scenarios.map(({ data: _data, ...scenario }) =>
                  structuredClone(scenario),
                ),
              },
            },
          };
        }
      } else if (params.scenario?.sdk) {
        result = { scenario: { sdk: { sdk: state.scenarioSdk } } };
      } else if (params.scenario?.get) {
        const scenario = state.scenarios.find(
          ({ index }) => index === params.scenario.get.index,
        );
        if (
          state.behavior.rejectScenarioGetAsInternalError ||
          (!scenario && state.behavior.missingScenarioGetAsNotFoundError)
        ) {
          socket.send(
            JSON.stringify({
              id: request.id,
              error: {
                code: -32603,
                message: `Not found: 'Scenario ${params.scenario.get.index}'`,
              },
            }),
          );
          return;
        }
        result = {
          scenario: {
            get: structuredClone(scenario) ?? null,
          },
        };
      } else if (params.scenario?.create) {
        if (state.behavior.rejectNextScenarioCreate) {
          state.behavior.rejectNextScenarioCreate = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: 400, message: "scenario compilation failed" },
            }),
          );
          return;
        }
        if (
          params.scenario.create.type === "BLOCK" &&
          rejectDirectCharacteristicIfPredicate(
            socket,
            request,
            params.scenario.create,
          )
        ) {
          return;
        }
        const index = `created-${state.nextScenario++}`;
        const { expand: _expand, ...createFields } = params.scenario.create;
        const created = {
          ...structuredClone(createFields),
          data:
            params.scenario.create.type === "BLOCK"
              ? JSON.stringify(
                  withRuntimeBlockFields(
                    JSON.parse(params.scenario.create.data),
                  ),
                )
              : params.scenario.create.data,
          index,
          predefined: false,
        };
        if (created.type === "LOGIC") {
          created.desc = nativeLogicDescription(created.data) ?? created.desc;
        }
        if (created.type === "BLOCK") {
          const windowKey = `opaque-scenario-window-${state.nextWindow++}`;
          created.optionsWindow = windowKey;
          state.windows[windowKey] = scenarioOptionsWindow({
            name: created.name,
            desc: created.desc,
            windowKey,
          });
        }
        state.scenarios.push(created);
        if (created.type === "LOGIC") {
          const type = `GeneratedLogicType${state.nextScenario - 1}`;
          state.scenarioLogicTypes[index] = type;
          state.logicTypes.push({
            type,
            name: created.name,
            desc: created.desc,
          });
          state.logicOptions[logicOptionsKey(34, 13, type)] = [];
        }
        if (state.behavior.closeAfterCreate) {
          state.behavior.closeAfterCreate = false;
          socket.close();
          return;
        }
        result = { scenario: { create: structuredClone(created) } };
      } else if (params.scenario?.update) {
        if (state.behavior.rejectNextScenarioUpdate) {
          state.behavior.rejectNextScenarioUpdate = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: 400, message: "scenario update rejected" },
            }),
          );
          return;
        }
        const scenario = state.scenarios.find(
          ({ index }) => index === params.scenario.update.index,
        );
        if (
          scenario?.type === "BLOCK" &&
          rejectDirectCharacteristicIfPredicate(
            socket,
            request,
            params.scenario.update,
          )
        ) {
          return;
        }
        if (!state.behavior.ignoreNextUpdate) {
          Object.assign(
            scenario,
            structuredClone(
              Object.fromEntries(
                Object.entries(params.scenario.update).filter(
                  ([key]) =>
                    key !== "index" &&
                    key !== "expand" &&
                    !(
                      scenario.type === "BLOCK" &&
                      (key === "name" || key === "desc")
                    ),
                ),
              ),
            ),
          );
          if (
            scenario.type === "BLOCK" &&
            typeof params.scenario.update.data === "string"
          ) {
            const requestedData = JSON.parse(params.scenario.update.data);
            scenario.data = JSON.stringify(
              withRuntimeBlockFields(requestedData),
            );
            if (
              state.behavior.recalculateBlockRooms ||
              state.behavior.projectBlockDerivedFields
            ) {
              const projection = scenarioBindingProjection(
                requestedData,
                state.accessories,
              );
              scenario.rooms = projection.rooms;
              if (state.behavior.projectBlockDerivedFields) {
                scenario.iconsIf = projection.iconsIf;
                scenario.iconsThen = projection.iconsThen;
                scenario.error = true;
                scenario.order = 11;
                scenario.bundleId = "hub-ui";
              }
            }
          } else if (typeof params.scenario.update.data === "string") {
            scenario.desc =
              nativeLogicDescription(params.scenario.update.data) ??
              scenario.desc;
          }
        }
        state.behavior.ignoreNextUpdate = false;
        if (state.behavior.closeAfterScenarioUpdate) {
          state.behavior.closeAfterScenarioUpdate = false;
          socket.close();
          return;
        }
        result = {
          scenario: {
            update: {},
          },
        };
      } else if (params.scenario?.run) {
        if (state.behavior.rejectNextScenarioRunAsUnsupported) {
          state.behavior.rejectNextScenarioRunAsUnsupported = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: -32601, message: "method not found" },
            }),
          );
          return;
        }
        if (state.behavior.rejectNextScenarioRun) {
          state.behavior.rejectNextScenarioRun = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: 400, message: "scenario run rejected" },
            }),
          );
          return;
        }
        const scenario = state.scenarios.find(
          ({ index }) => index === params.scenario.run.index,
        );
        assert.ok(scenario, "scenario.run must address an existing scenario");
        // Only the live-observed action-only BLOCK form changes values here.
        // A manual run of conditions, delays, code or other scenario types
        // has no observed semantics, so the fake acknowledges it unsimulated.
        const data = scenario.type === "BLOCK" ? JSON.parse(scenario.data) : {};
        const simulated =
          Array.isArray(data.targets) &&
          data.targets.every(({ type }) => type === "service");
        for (const target of simulated ? data.targets : []) {
          const service = state.accessories
            .find(({ id }) => id === target.aId)
            ?.services.find(({ sId }) => sId === target.sId);
          assert.equal(service?.type, target.hs);
          for (const action of target.characteristics) {
            assert.equal(action.type, "set");
            const characteristic = service.characteristics.find(
              ({ cId }) => cId === action.cId,
            );
            assert.equal(characteristic?.control.type, action.hc);
            const kind = Object.keys(characteristic.control.value)[0];
            characteristic.control.value = {
              [kind]:
                kind === "boolValue"
                  ? action.value === "true"
                  : kind === "stringValue"
                    ? action.value
                    : Number(action.value),
            };
          }
        }
        if (state.behavior.closeAfterScenarioRun) {
          state.behavior.closeAfterScenarioRun = false;
          socket.close();
          return;
        }
        result = { scenario: { run: {} } };
      } else if (params.scenario?.delete) {
        const index = state.scenarios.findIndex(
          (scenario) => scenario.index === params.scenario.delete.index,
        );
        if (index >= 0) {
          const [deleted] = state.scenarios.splice(index, 1);
          const logicType = state.scenarioLogicTypes[deleted.index];
          if (logicType) {
            delete state.scenarioLogicTypes[deleted.index];
            state.logicTypes = state.logicTypes.filter(
              ({ type }) => type !== logicType,
            );
          }
        }
        result = { scenario: { delete: {} } };
      } else {
        assert.fail(`unsupported test request: ${JSON.stringify(params)}`);
      }
      for (const [matches, callbackName] of [
        [params.scenario?.create, "afterCreate"],
        [params.scenario?.update, "afterUpdate"],
        [params.scenario?.run, "afterRun"],
        [params.scenario?.delete, "afterDelete"],
      ]) {
        if (matches && state.behavior[callbackName]) {
          const callback = state.behavior[callbackName];
          state.behavior[callbackName] = undefined;
          await callback();
        }
      }
      const response = JSON.stringify({ id: request.id, result });
      const stopAfterAccessoryGet =
        params.accessory?.get &&
        state.behavior.stopAfterAccessoryGet === params.accessory.get.id;
      if (stopAfterAccessoryGet) {
        state.behavior.stopAfterAccessoryGet = null;
        socket.send(response);
        socket.terminate();
        server.close();
        return;
      }
      socket.send(response);
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    requests,
    server,
    state,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

test("a window option applies one native setting and restores its baseline after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);

  const contract = await firstClient.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
    },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.deepEqual(contract.structuredContent.contract, {
    type: "GenericInteger",
    input_type: "LIST",
    kind: "intValue",
    valid_values: [
      { name: "Выключена", value: 0, kind: "intValue" },
      { name: "Включена", value: 1, kind: "intValue" },
      { name: "Предыдущее состояние", value: 255, kind: "intValue" },
    ],
    confirmation: "separate_window_get_readback",
  });

  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.deepEqual(prepared.structuredContent.diff, {
    value: { from: 255, to: 0, kind: "intValue" },
  });
  assert.equal(prepared.structuredContent.restore_supported, true);

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.deepEqual(applied.structuredContent.observed_value, {
    value: 0,
    kind: "intValue",
  });
  assert.equal(
    applied.structuredContent.limitations.some((limitation) =>
      limitation.includes("physical power cycle remain unverified"),
    ),
    true,
  );
  assert.equal(hub.state.window.options[1].value.intValue, 1);
  assert.deepEqual(
    hub.requests.filter(({ window }) => window?.update),
    [
      {
        window: {
          update: {
            windowKey: "Controller/zigbee_demo/Child/DEVICE_A/",
            options: [{ key: startupOptionKey, value: { intValue: 0 } }],
          },
        },
      },
    ],
  );
  assert.ok(hub.requests.at(-1).window?.get);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: deviceWindowRef },
  });
  assert.deepEqual(
    history.structuredContent.changes.map(({ change_ref }) => change_ref),
    [prepared.structuredContent.change_ref],
  );
  const discoveredChangeRef = history.structuredContent.changes[0].change_ref;

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: discoveredChangeRef },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(restored.structuredContent.observed_value, {
    value: 255,
    kind: "intValue",
  });
  assert.equal(hub.state.window.options[1].value.intValue, 1);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);

  const repeated = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: discoveredChangeRef },
  });
  assert.equal(repeated.structuredContent.status, "restored");
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
  assert.equal(
    hub.requests.some(
      ({ characteristic, scenario }) =>
        characteristic?.update ||
        scenario?.create ||
        scenario?.update ||
        scenario?.delete,
    ),
    false,
  );
});

test("an already desired window option creates no owned change or write", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.window.options[0].value = { intValue: 0 };
  const client = await startClient(t, hub, stateDirectory);

  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.deepEqual(prepared.structuredContent, {
    status: "already_desired",
    operation: "window_option",
    target_ref: deviceWindowRef,
    option_key: startupOptionKey,
    observed_value: { value: 0, kind: "intValue" },
    native_write_sent: false,
    owned_change_created: false,
  });
  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: deviceWindowRef },
  });
  assert.deepEqual(history.structuredContent.changes, []);
  assert.equal(
    hub.requests.some(({ window }) => window?.update),
    false,
  );
});

test("a lost unexecuted window write can retry without losing the baseline", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.behavior.dropNextWindowUpdate = true;
  hub.state.behavior.closeAfterWindowUpdate = true;

  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.deepEqual(uncertain.structuredContent.observed_value, {
    value: 255,
    kind: "intValue",
  });

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const applied = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(hub.state.window.options[0].value.intValue, 0);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(hub.state.window.options[0].value.intValue, 255);
});

test("a lost executed window write is reconciled without another update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.behavior.closeAfterWindowUpdate = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, false);
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 1);

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const repeatedRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(repeatedRestore.structuredContent.status, "restored");
  assert.equal(repeatedRestore.structuredContent.verification.fresh, false);
  assert.equal(hub.state.window.options[0].value.intValue, 255);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
});

test("a lost apply readback can be restored without a preliminary get", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.behavior.failWindowGetAfterUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.write_intent.direction, "apply");
  assert.equal(hub.state.window.options[0].value.intValue, 0);
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.applied_value_observed, true);
  assert.equal(hub.state.window.options[0].value.intValue, 255);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
});

test("a baseline read does not discard a delayed window apply", async (t) => {
  for (const readBeforeRestore of [false, true]) {
    await t.test(
      readBeforeRestore ? "after get" : "without get",
      async (scenario) => {
        const { hub, stateDirectory } = await setup(scenario);
        const firstClient = await startClient(scenario, hub, stateDirectory);
        const prepared = await firstClient.callTool({
          name: "prepare_native_change",
          arguments: {
            operation: "window_option",
            target_ref: deviceWindowRef,
            option_key: startupOptionKey,
            value: 0,
            reason: "Не включать лампу после восстановления питания",
          },
        });
        hub.state.behavior.dropNextWindowUpdate = true;

        const applied = await firstClient.callTool({
          name: "apply_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });
        assert.equal(applied.structuredContent.status, "uncertain");
        assert.equal(applied.structuredContent.write_intent.direction, "apply");
        assert.equal(hub.state.window.options[0].value.intValue, 255);

        if (readBeforeRestore) {
          const observed = await firstClient.callTool({
            name: "get_native_change",
            arguments: { change_ref: prepared.structuredContent.change_ref },
          });
          assert.equal(observed.structuredContent.status, "uncertain");
          assert.equal(
            observed.structuredContent.write_intent.direction,
            "apply",
          );
        }

        const waitingRestore = await firstClient.callTool({
          name: "restore_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });
        assert.equal(
          waitingRestore.isError,
          undefined,
          waitingRestore.content[0]?.text,
        );
        assert.equal(waitingRestore.structuredContent.status, "uncertain");
        assert.equal(
          waitingRestore.structuredContent.write_intent.direction,
          "apply",
        );
        assert.deepEqual(waitingRestore.structuredContent.observed_value, {
          value: 255,
          kind: "intValue",
        });
        assert.equal(
          hub.requests.filter(({ window }) => window?.update).length,
          1,
        );

        hub.state.behavior.failNextWindowGet = true;
        const unreadableRestore = await firstClient.callTool({
          name: "restore_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });
        assert.equal(
          unreadableRestore.isError,
          undefined,
          unreadableRestore.content[0]?.text,
        );
        assert.equal(unreadableRestore.structuredContent.status, "uncertain");
        assert.equal(
          unreadableRestore.structuredContent.write_intent.direction,
          "apply",
        );
        assert.equal(
          unreadableRestore.structuredContent.verification.fresh,
          false,
        );
        assert.equal(
          hub.requests.filter(({ window }) => window?.update).length,
          1,
        );

        hub.state.window.options[0].value = { intValue: 0 };
        await firstClient.close();
        const secondClient = await startClient(scenario, hub, stateDirectory);
        const restored = await secondClient.callTool({
          name: "restore_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });

        assert.equal(restored.isError, undefined, restored.content[0]?.text);
        assert.equal(restored.structuredContent.status, "restored");
        assert.equal(restored.structuredContent.applied_value_observed, true);
        assert.equal(hub.state.window.options[0].value.intValue, 255);
        assert.equal(
          hub.requests.filter(({ window }) => window?.update).length,
          2,
        );
      },
    );
  }
});

test("window option contract rejects controls outside the reversible setting slice", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const option = hub.state.window.options[0];
  const unsupported = [
    { type: "GenericInteger", inputType: "BUTTON" },
    { type: "GenericBoolean", inputType: "LIST" },
    { type: "GenericInteger", inputType: "LIST", validValues: undefined },
    { type: "GenericInteger", inputType: "LIST", disabled: true },
    { type: "GenericString", inputType: "TEXT" },
  ];

  for (const fields of unsupported) {
    Object.assign(option, {
      type: "GenericInteger",
      inputType: "LIST",
      disabled: false,
      validValues: [
        { name: "Выключена", value: { intValue: 0 } },
        { name: "Предыдущее состояние", value: { intValue: 255 } },
      ],
      ...fields,
    });
    const contract = await client.callTool({
      name: "get_native_change_contract",
      arguments: {
        operation: "window_option",
        target_ref: deviceWindowRef,
        option_key: startupOptionKey,
      },
    });
    assert.equal(contract.isError, true);
    assert.match(
      contract.structuredContent.error.code,
      /unsupported_window_option|insufficient_rights/,
    );
  }
  assert.equal(
    hub.requests.some(({ window }) => window?.update),
    false,
  );
});

test("window option restore preserves a third value chosen after apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  for (const validValue of hub.state.window.options[0].validValues) {
    validValue.name = `Актуально: ${validValue.name}`;
  }
  delete hub.state.window.options[0].validValues.find(
    ({ value }) => value.intValue === 1,
  ).name;
  hub.state.window.options[0].value = { intValue: 1 };

  const conflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.deepEqual(conflict.structuredContent.value_choices, {
    baseline: {
      value: 255,
      kind: "intValue",
      name: "Актуально: Предыдущее состояние",
    },
    requested: {
      value: 0,
      kind: "intValue",
      name: "Актуально: Выключена",
    },
    observed: {
      value: 1,
      kind: "intValue",
    },
  });
  assert.deepEqual(conflict.structuredContent.conflict_resolution, {
    requires_user_decision: true,
    action_if_authorized: "prepare_new_window_option_change",
    effect: {
      replace: {
        value: 1,
        kind: "intValue",
      },
      with: {
        value: 255,
        kind: "intValue",
        name: "Актуально: Предыдущее состояние",
      },
    },
  });
  assert.equal(hub.state.window.options[0].value.intValue, 1);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 1);
});

test("a prepared window change cannot restore a matching manual value", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.window.options[0].value = { intValue: 0 };
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const observed = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: deviceWindowRef },
  });

  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "not_owned");
  assert.equal(observed.structuredContent.status, "not_owned");
  assert.equal(
    history.structuredContent.changes[0].recorded_status,
    "not_owned",
  );
  assert.equal(hub.state.window.options[0].value.intValue, 0);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 0);
});

test("a rejected window apply never earns the right to restore a matching manual value", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.behavior.rejectNextWindowUpdate = true;
  const rejected = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  hub.state.window.options[0].value = { intValue: 0 };
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "not_owned");
  assert.equal(hub.state.window.options[0].value.intValue, 0);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 1);
});

test("an uncertain restore cannot be turned back into apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.failWindowGetAfterUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.write_intent.direction, "restore");
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const reconciled = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(reconciled.structuredContent.status, "restored");
  assert.equal(reconciled.structuredContent.write_intent.direction, "restore");
  assert.equal(hub.state.window.options[0].value.intValue, 255);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
});

test("a restore interrupted before readback cannot be turned back into apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.holdNextWindowUpdate = true;
  const interruptedRestore = firstClient
    .callTool({
      name: "restore_native_change",
      arguments: { change_ref: prepared.structuredContent.change_ref },
    })
    .catch((error) => error);
  await waitFor(
    () => hub.requests.filter(({ window }) => window?.update).length === 2,
  );
  await firstClient.close();
  await interruptedRestore;
  assert.equal(hub.state.window.options[0].value.intValue, 255);

  const secondClient = await startClient(t, hub, stateDirectory);
  const reconciled = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(reconciled.isError, undefined, reconciled.content[0]?.text);
  assert.equal(reconciled.structuredContent.status, "restored");
  assert.equal(reconciled.structuredContent.write_intent.direction, "restore");
  assert.equal(hub.state.window.options[0].value.intValue, 255);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
});

test("a terminal window restore is explicit that no fresh readback occurred", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const readsBeforeRepeat = hub.requests.filter(
    ({ window }) => window?.get,
  ).length;

  const repeated = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "restored");
  assert.equal(repeated.structuredContent.verification.fresh, false);
  assert.equal(
    hub.requests.filter(({ window }) => window?.get).length,
    readsBeforeRepeat,
  );
});

async function startClient(t, hub, stateDirectory) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "native-change-test-token",
      SPRUTHUB_SERIAL: serial,
      SPRUTHUB_CID: "native-change-test-client",
      SPRUTHUB_TIMEOUT_MS: "1000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "native-change-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(t) {
  const hub = await startHub();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-native-change-"),
  );
  t.after(async () => {
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, stateDirectory };
}

function installNativeCommandFixture(hub) {
  const firstLight = hub.state.accessories
    .find(({ id }) => id === 34)
    .services.find(({ sId }) => sId === 13);
  firstLight.characteristics.find(({ cId }) => cId === 15).control.value = {
    boolValue: true,
  };
  hub.state.accessories.push(
    {
      id: 36,
      roomId: 2,
      name: "Настольная лампа",
      online: true,
      services: [
        {
          aId: 36,
          sId: 13,
          name: "Свет",
          type: "Lightbulb",
          characteristics: [
            {
              aId: 36,
              sId: 13,
              cId: 15,
              control: {
                name: "Включена",
                type: "On",
                read: true,
                write: true,
                value: { boolValue: true },
              },
            },
            {
              aId: 36,
              sId: 13,
              cId: 16,
              control: {
                name: "Яркость",
                type: "Brightness",
                read: true,
                write: true,
                value: { intValue: 80 },
              },
            },
          ],
        },
      ],
    },
    {
      id: 37,
      roomId: 2,
      name: "Чужая лампа",
      online: true,
      services: [
        {
          aId: 37,
          sId: 13,
          name: "Свет",
          type: "Lightbulb",
          characteristics: [
            {
              aId: 37,
              sId: 13,
              cId: 15,
              control: {
                name: "Включена",
                type: "On",
                read: true,
                write: true,
                value: { boolValue: true },
              },
            },
            {
              aId: 37,
              sId: 13,
              cId: 16,
              control: {
                name: "Яркость",
                type: "Brightness",
                read: true,
                write: true,
                value: { intValue: 55 },
              },
            },
          ],
        },
      ],
    },
  );
  const data = {
    blockId: 0,
    targets: [
      { ...setAction({ aId: 34, value: "false" }), blockId: 1 },
      { ...setAction({ aId: 36, value: "false" }), blockId: 3 },
    ],
  };
  data.targets[0].characteristics[0].blockId = 2;
  data.targets[1].characteristics[0].blockId = 4;
  hub.state.scenarios.push({
    index: "all-off-command",
    name: "Выключить выбранный свет",
    desc: "Постоянная команда общего выключения",
    active: true,
    onStart: false,
    sync: false,
    type: "BLOCK",
    data: JSON.stringify(data),
    predefined: false,
  });
  return {
    scenarioRef: `${homeRef}/scenario/all-off-command`,
    data,
    secondOnRef: `${homeRef}/accessory/36/service/13/characteristic/15`,
    secondBrightnessRef: `${homeRef}/accessory/36/service/13/characteristic/16`,
    foreignOnRef: `${homeRef}/accessory/37/service/13/characteristic/15`,
    foreignBrightnessRef: `${homeRef}/accessory/37/service/13/characteristic/16`,
  };
}

test("an action-only BLOCK is explicitly run once and can be run again with a new intent", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const fixture = installNativeCommandFixture(hub);
  const firstClient = await startClient(t, hub, stateDirectory);

  const contract = await firstClient.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "scenario_run",
      target_ref: fixture.scenarioRef,
    },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.equal(
    contract.structuredContent.contract.scope,
    "any_active_scenario",
  );

  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: fixture.scenarioRef,
      reason: "Выключить выбранные лампы общей нативной командой",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.equal(prepared.structuredContent.native_write_sent, false);
  assert.equal(prepared.structuredContent.targets_known, true);
  assert.deepEqual(prepared.structuredContent.effect, { predicted: true });
  assert.deepEqual(
    prepared.structuredContent.targets.map(({ characteristic_ref, value }) => ({
      characteristic_ref,
      value,
    })),
    [
      { characteristic_ref: characteristicRef, value: false },
      { characteristic_ref: fixture.secondOnRef, value: false },
    ],
  );
  assert.deepEqual(currentCharacteristicValue(hub, characteristicRef), {
    boolValue: true,
  });
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.run),
    false,
  );

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.deepEqual(applied.structuredContent.command_delivery, {
    status: "acknowledged",
    native_acknowledged: true,
    physical_delivery: "not_proven",
    atomic: false,
  });
  assert.deepEqual(
    applied.structuredContent.target_observations.map(
      ({ characteristic_ref, expected_value, observed_value, matches }) => ({
        characteristic_ref,
        expected_value,
        observed_value,
        matches,
      }),
    ),
    [
      {
        characteristic_ref: characteristicRef,
        expected_value: { value: false, kind: "boolValue" },
        observed_value: { value: false, kind: "boolValue" },
        matches: true,
      },
      {
        characteristic_ref: fixture.secondOnRef,
        expected_value: { value: false, kind: "boolValue" },
        observed_value: { value: false, kind: "boolValue" },
        matches: true,
      },
    ],
  );
  assert.deepEqual(currentCharacteristicValue(hub, characteristicRef), {
    boolValue: false,
  });
  assert.deepEqual(currentCharacteristicValue(hub, fixture.secondOnRef), {
    boolValue: false,
  });
  assert.deepEqual(
    currentCharacteristicValue(
      hub,
      `${homeRef}/accessory/34/service/13/characteristic/16`,
    ),
    { intValue: 20 },
  );
  assert.deepEqual(
    currentCharacteristicValue(hub, fixture.secondBrightnessRef),
    {
      intValue: 80,
    },
  );
  assert.deepEqual(currentCharacteristicValue(hub, fixture.foreignOnRef), {
    boolValue: true,
  });
  assert.deepEqual(
    currentCharacteristicValue(hub, fixture.foreignBrightnessRef),
    {
      intValue: 55,
    },
  );
  assert.deepEqual(
    hub.requests.filter(({ scenario }) => scenario?.run),
    [{ scenario: { run: { index: "all-off-command" } } }],
  );

  const repeatedApply = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeatedApply.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(({ scenario }) => scenario?.run).length, 1);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: fixture.scenarioRef },
  });
  assert.equal(history.structuredContent.changes[0].operation, "scenario_run");
  hub.state.accessories
    .filter(({ id }) => [34, 36].includes(id))
    .forEach((accessory) => {
      accessory.services[0].characteristics.find(
        ({ cId }) => cId === 15,
      ).control.value = { boolValue: true };
    });
  const secondPrepared = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: fixture.scenarioRef,
      reason: "Повторно выключить выбранные лампы",
    },
  });
  const secondApplied = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: secondPrepared.structuredContent.change_ref },
  });
  assert.equal(secondApplied.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(({ scenario }) => scenario?.run).length, 2);
});

test("scenario run refuses changed targets and never retries an unknown delivery", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const fixture = installNativeCommandFixture(hub);
  const client = await startClient(t, hub, stateDirectory);
  const changed = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: fixture.scenarioRef,
      reason: "Зафиксировать выбранную область команды",
    },
  });
  const scenario = hub.state.scenarios.find(
    ({ index }) => index === "all-off-command",
  );
  const changedData = JSON.parse(scenario.data);
  changedData.targets[1].aId = 37;
  scenario.data = JSON.stringify(changedData);
  const conflict = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: changed.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "scenario_changed");
  assert.equal(
    hub.requests.filter(({ scenario: request }) => request?.run).length,
    0,
  );

  scenario.data = JSON.stringify(fixture.data);
  const lostAck = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: fixture.scenarioRef,
      reason: "Не повторять команду после потерянного ACK",
    },
  });
  hub.state.behavior.closeAfterScenarioRun = true;
  const uncertain = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: lostAck.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.command_delivery.status, "unknown");
  assert.equal(
    hub.requests.filter(({ scenario: request }) => request?.run).length,
    1,
  );
  await client.close();
  const restartedClient = await startClient(t, hub, stateDirectory);
  const inspected = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: lostAck.structuredContent.change_ref },
  });
  assert.equal(inspected.structuredContent.status, "uncertain");
  assert.equal(inspected.structuredContent.command_delivery.status, "unknown");
  const repeated = await restartedClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: lostAck.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ scenario: request }) => request?.run).length,
    1,
  );
});

test("a rejected scenario run remains rejected after inspection and restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const fixture = installNativeCommandFixture(hub);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: fixture.scenarioRef,
      reason: "Сохранить подтверждённый отказ запуска",
    },
  });
  hub.state.behavior.rejectNextScenarioRun = true;

  const rejected = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, "request_rejected");
  const inspected = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(inspected.structuredContent.status, "not_applied");
  assert.deepEqual(inspected.structuredContent.command_delivery, {
    status: "rejected",
    native_acknowledged: false,
    rejection: { code: "request_rejected", protocol_code: 400 },
    physical_delivery: "not_proven",
    atomic: false,
  });
  await firstClient.close();

  const restartedClient = await startClient(t, hub, stateDirectory);
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(persisted.structuredContent.status, "not_applied");
  assert.deepEqual(
    persisted.structuredContent.command_delivery,
    inspected.structuredContent.command_delivery,
  );
  const repeated = await restartedClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "not_applied");
  assert.equal(hub.requests.filter(({ scenario }) => scenario?.run).length, 1);
});

test("a scenario run not sent after connection loss keeps its reason and needs a new intent", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const fixture = installNativeCommandFixture(hub);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: fixture.scenarioRef,
      reason: "Сохранить подтверждённую неотправку запуска",
    },
  });
  hub.state.behavior.stopAfterAccessoryGet = 36;

  const notSent = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(
    notSent.isError,
    true,
    JSON.stringify(notSent.structuredContent),
  );
  assert.equal(notSent.structuredContent.error.code, "connection_failed");
  assert.equal(
    notSent.structuredContent.error.action,
    "restore_connection_then_prepare_native_change",
  );
  assert.equal(hub.requests.filter(({ scenario }) => scenario?.run).length, 0);
  const inspectedWhileOffline = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(inspectedWhileOffline.structuredContent.status, "not_applied");
  assert.equal(
    inspectedWhileOffline.structuredContent.native_write_sent,
    false,
  );
  assert.deepEqual(inspectedWhileOffline.structuredContent.command_delivery, {
    status: "not_sent",
    native_acknowledged: false,
    failure: {
      code: "connection_failed",
      action: "restore_connection_then_prepare_native_change",
    },
    physical_delivery: "not_proven",
    atomic: false,
  });
  await firstClient.close();

  const recoveredPort = Number(new URL(hub.url).port);
  await new Promise((resolve) => hub.server.close(() => resolve()));
  const recoveredHub = await startHub(recoveredPort);
  t.after(async () => {
    for (const socket of recoveredHub.server.clients) socket.terminate();
    await new Promise((resolve) => recoveredHub.server.close(resolve));
  });
  const recoveredFixture = installNativeCommandFixture(recoveredHub);
  const restartedClient = await startClient(t, recoveredHub, stateDirectory);
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(
    persisted.isError,
    undefined,
    JSON.stringify(persisted.structuredContent),
  );
  assert.deepEqual(
    persisted.structuredContent.command_delivery,
    inspectedWhileOffline.structuredContent.command_delivery,
  );
  const repeated = await restartedClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "not_applied");
  assert.equal(
    recoveredHub.requests.filter(({ scenario }) => scenario?.run).length,
    0,
  );

  const newIntent = await restartedClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: recoveredFixture.scenarioRef,
      reason: "Повторить явный запрос после восстановления соединения",
    },
  });
  const applied = await restartedClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: newIntent.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(
    recoveredHub.requests.filter(({ scenario }) => scenario?.run).length,
    1,
  );
});

test("an unsupported scenario run is a persisted explicit rejection", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const fixture = installNativeCommandFixture(hub);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: fixture.scenarioRef,
      reason: "Сохранить отсутствие native run метода",
    },
  });
  hub.state.behavior.rejectNextScenarioRunAsUnsupported = true;

  const unsupported = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(
    unsupported.isError,
    true,
    JSON.stringify(unsupported.structuredContent),
  );
  assert.equal(unsupported.structuredContent.error.code, "unsupported");
  await firstClient.close();

  const restartedClient = await startClient(t, hub, stateDirectory);
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(persisted.structuredContent.status, "not_applied");
  assert.deepEqual(persisted.structuredContent.command_delivery, {
    status: "rejected",
    native_acknowledged: false,
    rejection: { code: "unsupported", action: "inspect_home" },
    physical_delivery: "not_proven",
    atomic: false,
  });
  const repeated = await restartedClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "not_applied");
  assert.equal(hub.requests.filter(({ scenario }) => scenario?.run).length, 1);
});

test("scenario run readback distinguishes an unavailable target from a known difference", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const fixture = installNativeCommandFixture(hub);
  const client = await startClient(t, hub, stateDirectory);
  const secondAccessory = structuredClone(
    hub.state.accessories.find(({ id }) => id === 36),
  );
  const unavailablePrepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: fixture.scenarioRef,
      reason: "Различить недоступное показание после ACK",
    },
  });
  hub.state.behavior.afterRun = () => {
    hub.state.accessories = hub.state.accessories.filter(({ id }) => id !== 36);
  };

  const unavailable = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: unavailablePrepared.structuredContent.change_ref },
  });
  assert.equal(unavailable.structuredContent.status, "applied");
  assert.equal(
    unavailable.structuredContent.verification.result,
    "command_acknowledged_with_incomplete_target_readback",
  );
  assert.equal(
    unavailable.structuredContent.target_observations[1].matches,
    null,
  );
  assert.equal(
    unavailable.structuredContent.target_observations[1].error.code,
    "incompatible_response",
  );

  hub.state.accessories.push(secondAccessory);
  const differentPrepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: fixture.scenarioRef,
      reason: "Отличить измеренное расхождение после ACK",
    },
  });
  hub.state.behavior.afterRun = () => {
    hub.state.accessories
      .find(({ id }) => id === 34)
      .services.find(({ sId }) => sId === 13)
      .characteristics.find(({ cId }) => cId === 15).control.value = {
      boolValue: true,
    };
  };
  const different = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: differentPrepared.structuredContent.change_ref },
  });
  assert.equal(
    different.structuredContent.verification.result,
    "command_acknowledged_with_target_value_difference",
  );
  assert.equal(
    different.structuredContent.target_observations[0].matches,
    false,
  );
});

test("a persisted run intent becomes unknown after the final journal save is lost", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const fixture = installNativeCommandFixture(hub);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: fixture.scenarioRef,
      reason: "Не повторять отправленную команду после сбоя журнала",
    },
  });
  let restoreStorage;
  hub.state.behavior.afterRun = async () => {
    restoreStorage = await blockStateDirectory(t, stateDirectory);
  };

  const appliedWithoutFinalSave = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(appliedWithoutFinalSave.structuredContent.status, "applied");
  assert.equal(
    appliedWithoutFinalSave.structuredContent.local_state.saved,
    false,
  );
  assert.equal(hub.requests.filter(({ scenario }) => scenario?.run).length, 1);

  await firstClient.close();
  await restoreStorage();
  const restartedClient = await startClient(t, hub, stateDirectory);
  const recovered = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "uncertain");
  assert.equal(recovered.structuredContent.command_delivery.status, "unknown");
  const repeated = await restartedClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(hub.requests.filter(({ scenario }) => scenario?.run).length, 1);
});

const brightnessRef = `${serviceRef}/characteristic/16`;

function lampOn(hub, value) {
  hub.state.accessories
    .find(({ id }) => id === 34)
    .services.find(({ sId }) => sId === 13)
    .characteristics.find(({ cId }) => cId === 15).control.value = {
    boolValue: value,
  };
}

const runnableScenarioCases = [
  {
    key: "scene",
    title: "BLOCK scene with any literal values and runtime flags",
    install(hub) {
      const scenario = {
        index: "movie-scene",
        name: "Кино",
        desc: "Приглушить свет",
        active: true,
        onStart: false,
        sync: true,
        type: "BLOCK",
        data: JSON.stringify({
          targets: [
            {
              type: "service",
              aId: 34,
              sId: 13,
              hs: "Lightbulb",
              characteristics: [
                { type: "set", cId: 15, hc: "On", value: "true" },
                { type: "set", cId: 16, hc: "Brightness", value: "30" },
              ],
            },
          ],
        }),
      };
      hub.state.scenarios.push(scenario);
      return scenario;
    },
    targetsKnown: true,
    targets: [
      { characteristic_ref: characteristicRef, value: true },
      { characteristic_ref: brightnessRef, value: 30 },
    ],
    effect: { predicted: true },
    verification: "command_acknowledged_and_target_values_observed",
    checkHome(hub) {
      assert.deepEqual(currentCharacteristicValue(hub, characteristicRef), {
        boolValue: true,
      });
      assert.deepEqual(currentCharacteristicValue(hub, brightnessRef), {
        intValue: 30,
      });
    },
  },
  {
    key: "conditional",
    title: "BLOCK with a trigger and a condition",
    install(hub) {
      lampOn(hub, true);
      const scenario = {
        index: "leaving-home",
        name: "Уходим из дома",
        desc: "",
        active: true,
        onStart: false,
        sync: false,
        type: "BLOCK",
        data: JSON.stringify({
          targets: [
            {
              type: "if",
              mode: "EVERY",
              if: {
                type: "condition",
                mode: "AND",
                conditions: [characteristicCondition()],
              },
              // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
              then: [setAction({ value: "false" })],
              else: [],
              then_delay: 0,
              else_delay: 0,
            },
          ],
        }),
      };
      hub.state.scenarios.push(scenario);
      return scenario;
    },
    targetsKnown: true,
    targets: [{ characteristic_ref: characteristicRef, value: false }],
    effect: { predicted: false, reasons: ["conditions_evaluated_by_hub"] },
    // The hub decides the branch; an unchanged lamp is not reported as a
    // failed run.
    verification: "command_acknowledged_effect_not_predicted",
  },
  {
    key: "uninterpreted",
    title: "BLOCK with an action this server does not interpret",
    install(hub) {
      lampOn(hub, true);
      const scenario = {
        index: "night-mode",
        name: "Ночной режим",
        desc: "",
        active: true,
        onStart: false,
        sync: false,
        type: "BLOCK",
        data: JSON.stringify({
          targets: [
            setAction({ value: "false" }),
            { type: "code", blockId: 7, code: "global.nightMode();" },
          ],
        }),
      };
      hub.state.scenarios.push(scenario);
      return scenario;
    },
    targetsKnown: false,
    targets: [{ characteristic_ref: characteristicRef, value: false }],
    effect: { predicted: false, reasons: ["targets_unknown"] },
    verification: "command_acknowledged_effect_not_predicted",
  },
  {
    key: "logic",
    title: "LOGIC",
    install(hub) {
      const scenario = {
        index: "evening-logic",
        name: "Вечерняя яркость",
        desc: "Set the initial brightness once",
        active: true,
        onStart: false,
        sync: false,
        type: "LOGIC",
        data: firstLogicSource,
      };
      hub.state.scenarios.push(scenario);
      return scenario;
    },
    targetsKnown: false,
    targets: [],
    effect: { predicted: false, reasons: ["targets_unknown"] },
    verification: "command_acknowledged_effect_not_predicted",
  },
  {
    key: "global",
    title: "GLOBAL",
    install(hub) {
      const scenario = {
        index: "global-helpers",
        name: "Общие функции",
        desc: "",
        active: true,
        onStart: true,
        sync: false,
        type: "GLOBAL",
        data: 'log.info("helpers ready");',
      };
      hub.state.scenarios.push(scenario);
      return scenario;
    },
    targetsKnown: false,
    targets: [],
    effect: { predicted: false, reasons: ["targets_unknown"] },
    verification: "command_acknowledged_effect_not_predicted",
  },
];

function installRunnableScenario(hub, key) {
  return runnableScenarioCases.find((item) => item.key === key).install(hub);
}

function scenarioRuns(hub) {
  return hub.requests
    .filter(({ scenario }) => scenario?.run)
    .map(({ scenario }) => scenario.run.index);
}

function hubConfigurationWrites(hub) {
  return hub.requests.filter(
    ({ scenario, characteristic }) =>
      scenario?.create ||
      scenario?.update ||
      scenario?.delete ||
      characteristic?.update,
  );
}

async function prepareScenarioRun(client, targetRef, name) {
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: targetRef,
      reason: `Запусти сценарий «${name}»`,
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  return prepared.structuredContent;
}

test("an active scenario of any type is run once by its prepared intent", async (t) => {
  for (const scenarioCase of runnableScenarioCases) {
    await t.test(scenarioCase.title, async (subtest) => {
      const { hub, stateDirectory } = await setup(subtest);
      const scenario = scenarioCase.install(hub);
      const configuration = structuredClone(scenario);
      const targetRef = scenarioRefFor(scenario);
      const client = await startClient(subtest, hub, stateDirectory);

      const contract = await client.callTool({
        name: "get_native_change_contract",
        arguments: { operation: "scenario_run", target_ref: targetRef },
      });
      assert.equal(contract.isError, undefined, contract.content[0]?.text);

      const prepared = await prepareScenarioRun(
        client,
        targetRef,
        scenario.name,
      );
      assert.equal(prepared.status, "prepared");
      assert.equal(prepared.scenario.type, scenario.type);
      assert.equal(prepared.targets_known, scenarioCase.targetsKnown);
      assert.deepEqual(
        prepared.targets.map(({ characteristic_ref, value }) => ({
          characteristic_ref,
          value,
        })),
        scenarioCase.targets,
      );
      assert.deepEqual(prepared.effect, scenarioCase.effect);
      assert.deepEqual(scenarioRuns(hub), []);

      const applied = await callChangeTool(
        client,
        "apply_native_change",
        prepared.change_ref,
      );
      assert.equal(applied.status, "applied");
      assert.equal(applied.command_delivery.status, "acknowledged");
      assert.equal(applied.verification.result, scenarioCase.verification);
      assert.deepEqual(scenarioRuns(hub), [scenario.index]);
      scenarioCase.checkHome?.(hub);

      const repeated = await callChangeTool(
        client,
        "apply_native_change",
        prepared.change_ref,
      );
      assert.equal(repeated.status, "applied");
      assert.deepEqual(scenarioRuns(hub), [scenario.index]);
      assert.deepEqual(hubConfigurationWrites(hub), []);
      assert.deepEqual(scenario, configuration);
    });
  }
});

test("a turned-off scenario is not run and the agent is pointed to scenario_active", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const inactive = hub.state.scenarios.find(
    ({ index }) => index === "existing-block",
  );
  assert.equal(inactive.active, false);
  const targetRef = scenarioRefFor(inactive);

  for (const [name, reason] of [
    ["get_native_change_contract", undefined],
    ["prepare_native_change", "Запусти выключенный сценарий"],
  ]) {
    const refused = await client.callTool({
      name,
      arguments: {
        operation: "scenario_run",
        target_ref: targetRef,
        ...(reason ? { reason } : {}),
      },
    });
    assert.equal(refused.isError, true, name);
    assert.equal(
      refused.structuredContent.error.code,
      "scenario_inactive",
      refused.content[0]?.text,
    );
    assert.deepEqual(refused.structuredContent.next, {
      tool: "get_native_change_contract",
      arguments: { operation: "scenario_active", target_ref: targetRef },
    });
  }
  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: targetRef },
  });
  assert.deepEqual(history.structuredContent.changes, []);

  const scenarioReads = hub.requests.filter(({ scenario }) => scenario?.get);
  const foreign = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: "spruthub://hub/other-home/scenario/existing-block",
      reason: "Не запускать сценарий другого дома",
    },
  });
  assert.equal(foreign.isError, true);
  assert.equal(foreign.structuredContent.error.code, "unsupported_home_write");
  assert.deepEqual(
    hub.requests.filter(({ scenario }) => scenario?.get),
    scenarioReads,
  );
  assert.deepEqual(scenarioRuns(hub), []);
  assert.equal(inactive.active, false);
});

test("apply rechecks the exact scenario of any type and never resends a lost run", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const logic = installRunnableScenario(hub, "logic");
  const global = installRunnableScenario(hub, "global");
  const scene = installRunnableScenario(hub, "scene");
  const firstClient = await startClient(t, hub, stateDirectory);
  const runs = [];
  for (const scenario of [logic, global, scene]) {
    runs.push(
      await prepareScenarioRun(
        firstClient,
        scenarioRefFor(scenario),
        scenario.name,
      ),
    );
  }

  logic.data = secondLogicSource;
  global.active = false;
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== scene.index,
  );
  for (const run of runs) {
    const conflict = await callChangeTool(
      firstClient,
      "apply_native_change",
      run.change_ref,
    );
    assert.equal(conflict.status, "conflict", run.target_ref);
    assert.equal(conflict.conflict_reason, "scenario_changed", run.target_ref);
  }
  assert.deepEqual(scenarioRuns(hub), []);

  logic.data = firstLogicSource;
  const lostAck = await prepareScenarioRun(
    firstClient,
    scenarioRefFor(logic),
    logic.name,
  );
  hub.state.behavior.closeAfterScenarioRun = true;
  const uncertain = await callChangeTool(
    firstClient,
    "apply_native_change",
    lostAck.change_ref,
  );
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.command_delivery.status, "unknown");
  await firstClient.close();

  const restartedClient = await startClient(t, hub, stateDirectory);
  const repeated = await callChangeTool(
    restartedClient,
    "apply_native_change",
    lostAck.change_ref,
  );
  assert.equal(repeated.status, "uncertain");
  assert.deepEqual(scenarioRuns(hub), [logic.index]);
});

test("an action-only BLOCK can be created without running and restoration removes only its configuration", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const fixture = installNativeCommandFixture(hub);
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== "all-off-command",
  );
  const client = await startClient(t, hub, stateDirectory);
  const unsupportedData = structuredClone(fixture.data);
  unsupportedData.targets[0].characteristics[0].value = "true";
  const unsupportedCreate = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Неподдержанная action-only команда",
      description: "Не расширять проверенный OFF-срез",
      active: true,
      on_start: false,
      sync: false,
      data: unsupportedData,
      reason: "Проверить границу безопасного запуска",
    },
  });
  assert.equal(unsupportedCreate.isError, true);
  assert.equal(
    JSON.parse(unsupportedCreate.content[0].text).error.code,
    "invalid_block_data",
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create),
    false,
  );
  const unsafeAutostart = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Небезопасный автозапуск",
      description: "Создание и запуск должны оставаться разными действиями",
      active: true,
      on_start: true,
      sync: false,
      data: fixture.data,
      reason: "Не запускать общую команду при старте хаба",
    },
  });
  assert.equal(unsafeAutostart.isError, true);
  assert.equal(
    JSON.parse(unsafeAutostart.content[0].text).error.code,
    "invalid_native_change",
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create),
    false,
  );
  const preparedCreate = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Выключить выбранный свет",
      description: "Постоянная команда общего выключения",
      active: true,
      on_start: false,
      sync: false,
      data: fixture.data,
      reason: "Сохранить общую команду на хабе",
    },
  });
  assert.equal(
    preparedCreate.isError,
    undefined,
    preparedCreate.content[0]?.text,
  );
  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: preparedCreate.structuredContent.change_ref },
  });
  assert.equal(created.structuredContent.status, "applied");
  assert.deepEqual(currentCharacteristicValue(hub, characteristicRef), {
    boolValue: true,
  });
  assert.equal(hub.requests.filter(({ scenario }) => scenario?.run).length, 0);

  const run = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_run",
      target_ref: created.structuredContent.scenario_ref,
      reason: "Запустить сохранённую команду",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: run.structuredContent.change_ref },
  });
  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: preparedCreate.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(currentCharacteristicValue(hub, characteristicRef), {
    boolValue: false,
  });
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "created-1"),
    false,
  );
});

async function blockStateDirectory(t, stateDirectory) {
  const backupDirectory = `${stateDirectory}-backup`;
  await rename(stateDirectory, backupDirectory);
  await writeFile(stateDirectory, "local state storage unavailable\n");
  let restored = false;
  const restore = async () => {
    if (restored) return;
    await rm(stateDirectory, { force: true });
    await rename(backupDirectory, stateDirectory);
    restored = true;
  };
  t.after(async () => {
    if (!restored) await rm(stateDirectory, { force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  });
  return restore;
}

test("a read-only characteristic exposes writable options through the shared typed history", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);

  const detail = await firstClient.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: motionCharacteristicRef,
      include: ["options"],
    },
  });
  assert.equal(detail.isError, undefined, detail.content[0]?.text);
  assert.equal(detail.structuredContent.entity.capabilities.write, false);
  const switchOffTime = detail.structuredContent.entity.options.find(
    ({ key }) => key === characteristicOptionKeys.switchOffTime,
  );
  assert.deepEqual(switchOffTime.native_change, {
    native_write: true,
    supported: true,
    operation: "characteristic_option",
    next: {
      tool: "get_native_change_contract",
      arguments: {
        operation: "characteristic_option",
        target_ref: motionCharacteristicRef,
        option_key: characteristicOptionKeys.switchOffTime,
      },
    },
  });
  assert.deepEqual(
    detail.structuredContent.entity.options.find(
      ({ key }) => key === characteristicOptionKeys.primary,
    ).native_change,
    {
      native_write: true,
      supported: false,
      reason: "unsupported_input_type",
    },
  );

  const contract = await firstClient.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.switchOffTime,
    },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.deepEqual(contract.structuredContent.contract, {
    type: "GenericDouble",
    input_type: "NUMBER",
    kind: "doubleValue",
    confirmation: "separate_characteristic_get_options_readback",
  });

  const writesBeforePrepare = hub.requests.filter(
    ({ characteristic }) => characteristic?.setOptions,
  ).length;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.switchOffTime,
      value: 10,
      reason: "Вернуть минутной автоматике согласованную задержку",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.equal(prepared.structuredContent.native_write_sent, false);
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.setOptions)
      .length,
    writesBeforePrepare,
  );

  hub.state.behavior.closeAfterCharacteristicSetOptions = true;
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);
  assert.deepEqual(
    hub.requests.filter(({ characteristic }) => characteristic?.setOptions),
    [
      {
        characteristic: {
          setOptions: {
            aId: 32,
            sId: 13,
            cId: 15,
            options: [
              {
                key: characteristicOptionKeys.switchOffTime,
                value: { doubleValue: 10 },
              },
            ],
          },
        },
      },
    ],
  );
  assert.deepEqual(
    hub.state.characteristicOptions.map(({ key, value }) => ({ key, value })),
    motionCharacteristicOptions().map(({ key, value }) => ({
      key,
      value:
        key === characteristicOptionKeys.switchOffTime
          ? { doubleValue: 10 }
          : value,
    })),
  );

  const repeated = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.switchOffTime,
      value: 10,
      reason: "Не создавать лишнее владение",
    },
  });
  assert.equal(repeated.structuredContent.status, "already_desired");
  assert.equal(repeated.structuredContent.owned_change_created, false);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: motionCharacteristicRef },
  });
  assert.deepEqual(
    history.structuredContent.changes.map(({ change_ref }) => change_ref),
    [prepared.structuredContent.change_ref],
  );
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(
    hub.state.characteristicOptions.find(
      ({ key }) => key === characteristicOptionKeys.switchOffTime,
    ).value,
    { doubleValue: 180 },
  );
});

test("an unexecuted characteristic option write can retry once and still restore", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.switchOffTime,
      value: 10,
      reason: "Повторить только невыполненную запись настройки",
    },
  });

  hub.state.behavior.dropNextCharacteristicSetOptions = true;
  const uncertain = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.isError, undefined, uncertain.content[0]?.text);
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.restore_supported, true);
  assert.deepEqual(
    hub.state.characteristicOptions.find(
      ({ key }) => key === characteristicOptionKeys.switchOffTime,
    ).value,
    { doubleValue: 180 },
  );

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.restore_supported, true);
  assert.deepEqual(
    hub.state.characteristicOptions.find(
      ({ key }) => key === characteristicOptionKeys.switchOffTime,
    ).value,
    { doubleValue: 10 },
  );
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.setOptions)
      .length,
    2,
  );

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(
    hub.state.characteristicOptions.find(
      ({ key }) => key === characteristicOptionKeys.switchOffTime,
    ).value,
    { doubleValue: 180 },
  );
});

test("LIST discovery and writes reject native choices that contradict numeric constraints", async (t) => {
  for (const { name, mutate } of [
    {
      name: "range",
      mutate: (option) => Object.assign(option, { minValue: 0, maxValue: 100 }),
    },
    {
      name: "step",
      mutate: (option) => Object.assign(option, { minValue: 0, minStep: 2 }),
    },
  ]) {
    await t.test(name, async (scenario) => {
      const { hub, stateDirectory } = await setup(scenario);
      const client = await startClient(scenario, hub, stateDirectory);
      mutate(hub.state.window.options[0]);

      const detail = await client.callTool({
        name: "get_entity",
        arguments: { entity_ref: deviceWindowRef },
      });
      const option = detail.structuredContent.entity.options.find(
        ({ key }) => key === startupOptionKey,
      );
      assert.deepEqual(option.native_change, {
        native_write: true,
        supported: false,
        reason: "inconsistent_valid_values",
      });

      for (const request of [
        {
          name: "get_native_change_contract",
          arguments: {
            operation: "window_option",
            target_ref: deviceWindowRef,
            option_key: startupOptionKey,
          },
        },
        {
          name: "prepare_native_change",
          arguments: {
            operation: "window_option",
            target_ref: deviceWindowRef,
            option_key: startupOptionKey,
            value: 0,
            reason: "Не обещать противоречащий native contract",
          },
        },
      ]) {
        const rejected = await client.callTool(request);
        assert.equal(rejected.isError, true);
        assert.equal(
          rejected.structuredContent.error.code,
          "incompatible_response",
        );
      }
      assert.equal(
        hub.requests.some(({ window }) => window?.update),
        false,
      );
    });
  }
});

test("option changes stop promising restore when their baseline is no longer valid", async (t) => {
  const cases = [
    {
      name: "characteristic option",
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.mode,
      install() {},
      option(hub) {
        return hub.state.characteristicOptions.find(
          ({ key }) => key === characteristicOptionKeys.mode,
        );
      },
    },
    {
      name: "window option",
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      install() {},
      option(hub) {
        return hub.state.window.options.find(
          ({ key }) => key === startupOptionKey,
        );
      },
    },
    {
      name: "logic option",
      operation: "logic_option",
      target_ref: smoothLogicRef,
      option_key: "Mode",
      install(hub) {
        hub.state.logics.push(assignedSmoothLogic());
        configuredSmoothLogicOptions(hub.state).push({
          key: "Mode",
          name: "Режим",
          type: "GenericInteger",
          inputType: "LIST",
          read: true,
          write: true,
          disabled: false,
          value: { intValue: 0 },
          validValues: [
            { name: "Обычный", value: { intValue: 0 } },
            { name: "Подробный", value: { intValue: 1 } },
          ],
        });
      },
      option(hub) {
        return configuredSmoothLogicOptions(hub.state).find(
          ({ key }) => key === "Mode",
        );
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (scenario) => {
      const { hub, stateDirectory } = await setup(scenario);
      testCase.install(hub);
      const client = await startClient(scenario, hub, stateDirectory);
      const contract = await client.callTool({
        name: "get_native_change_contract",
        arguments: {
          operation: testCase.operation,
          target_ref: testCase.target_ref,
          option_key: testCase.option_key,
        },
      });
      assert.equal(contract.isError, undefined, contract.content[0]?.text);
      assert.equal(contract.structuredContent.restore_supported, true);

      const prepared = await client.callTool({
        name: "prepare_native_change",
        arguments: {
          operation: testCase.operation,
          target_ref: testCase.target_ref,
          option_key: testCase.option_key,
          value: 1,
          reason: "Не обещать возврат исчезнувшего исходного значения",
        },
      });
      const applied = await client.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(applied.structuredContent.status, "applied");
      const option = testCase.option(hub);
      option.validValues = option.validValues.filter(
        ({ value }) =>
          value.intValue !== prepared.structuredContent.diff.value.from,
      );

      const observed = await client.callTool({
        name: "get_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(observed.isError, undefined, observed.content[0]?.text);
      assert.equal(observed.structuredContent.restore_supported, false);
      assert.equal(
        observed.structuredContent.restore_limitation.code,
        "baseline_not_writable",
      );
      const writesBeforeRestore = hub.requests.filter((request) =>
        testCase.operation === "characteristic_option"
          ? request.characteristic?.setOptions
          : testCase.operation === "window_option"
            ? request.window?.update
            : request.logic?.setOptions,
      ).length;
      const restored = await client.callTool({
        name: "restore_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(restored.isError, true);
      assert.equal(
        restored.structuredContent.error.code,
        "restore_unsupported",
      );
      assert.equal(
        hub.requests.filter((request) =>
          testCase.operation === "characteristic_option"
            ? request.characteristic?.setOptions
            : testCase.operation === "window_option"
              ? request.window?.update
              : request.logic?.setOptions,
        ).length,
        writesBeforeRestore,
      );
      assert.deepEqual(option.value, { intValue: 1 });
    });
  }
});

test("sensitive LIST options stay redacted and cannot create history for any owner", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.logics.push(assignedSmoothLogic());
  hub.state.characteristicOptions.push(sensitiveListOption());
  hub.state.window.options.push(sensitiveListOption());
  configuredSmoothLogicOptions(hub.state).push(sensitiveListOption());
  const client = await startClient(t, hub, stateDirectory);

  const owners = [
    {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      read: {
        entity_ref: motionCharacteristicRef,
        include: ["options"],
      },
    },
    {
      operation: "window_option",
      target_ref: deviceWindowRef,
      read: { entity_ref: deviceWindowRef },
    },
    {
      operation: "logic_option",
      target_ref: smoothLogicRef,
      read: { entity_ref: smoothLogicRef, include: ["options"] },
    },
  ];
  for (const owner of owners) {
    const detail = await client.callTool({
      name: "get_entity",
      arguments: owner.read,
    });
    assert.equal(detail.isError, undefined, detail.content[0]?.text);
    assert.equal(JSON.stringify(detail).includes("LEAK"), false);
    assert.equal(
      detail.structuredContent.entity.options.some(
        ({ redacted, reason }) =>
          redacted === true && reason === "sensitive_native_data",
      ),
      true,
    );

    for (const request of [
      {
        name: "get_native_change_contract",
        arguments: {
          operation: owner.operation,
          target_ref: owner.target_ref,
          option_key: "AccessToken",
        },
      },
      {
        name: "prepare_native_change",
        arguments: {
          operation: owner.operation,
          target_ref: owner.target_ref,
          option_key: "AccessToken",
          value: "SAFE",
          reason: "Секретная настройка не становится публичной записью",
        },
      },
    ]) {
      const rejected = await client.callTool(request);
      assert.equal(rejected.isError, true);
      assert.equal(
        rejected.structuredContent.error.code,
        "sensitive_native_data",
      );
      assert.equal(JSON.stringify(rejected).includes("LEAK"), false);
    }
  }

  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef },
  });
  assert.deepEqual(history.structuredContent.changes, []);

  const historicalOption = {
    ...sensitiveListOption(),
    key: "VisibleMode",
    name: "Visible mode",
    sensitive: false,
  };
  hub.state.characteristicOptions.push(historicalOption);
  const historical = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: historicalOption.key,
      value: "SAFE",
      reason: "Ранее обычная настройка стала чувствительной",
    },
  });
  assert.equal(historical.isError, undefined, historical.content[0]?.text);
  historicalOption.sensitive = true;

  const hiddenHistory = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: historical.structuredContent.change_ref },
  });
  assert.equal(hiddenHistory.isError, true);
  assert.equal(
    hiddenHistory.structuredContent.error.code,
    "sensitive_native_data",
  );
  assert.equal(JSON.stringify(hiddenHistory).includes("LEAK"), false);
  const summaries = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef },
  });
  assert.equal(JSON.stringify(summaries).includes("LEAK"), false);
  assert.equal(
    hub.requests.some(
      ({ characteristic, window, logic }) =>
        characteristic?.setOptions || window?.update || logic?.setOptions,
    ),
    false,
  );
});

test("the option contract preserves scalar envelopes and rejects unsafe forms for every owner", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.logics.push(assignedSmoothLogic());
  const client = await startClient(t, hub, stateDirectory);

  const cases = [
    {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.retryCount,
      expected: {
        type: "GenericLong",
        input_type: "NUMBER",
        kind: "longValue",
        min: 0,
        max: 4,
        step: 1,
        confirmation: "separate_characteristic_get_options_readback",
      },
    },
    {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.showAllEvents,
      expected: {
        type: "GenericBoolean",
        input_type: "CHECKBOX",
        kind: "boolValue",
        confirmation: "separate_characteristic_get_options_readback",
      },
    },
    {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      expected: {
        type: "GenericInteger",
        input_type: "LIST",
        kind: "intValue",
        valid_values: [
          { name: "Выключена", value: 0, kind: "intValue" },
          { name: "Включена", value: 1, kind: "intValue" },
          {
            name: "Предыдущее состояние",
            value: 255,
            kind: "intValue",
          },
        ],
        confirmation: "separate_window_get_readback",
      },
    },
    {
      operation: "logic_option",
      target_ref: smoothLogicRef,
      option_key: smoothOptionKeys.duration,
      expected: {
        type: "GenericInteger",
        input_type: "NUMBER",
        kind: "intValue",
        confirmation: "separate_logic_get_options_readback",
      },
    },
  ];
  for (const { expected, ...arguments_ } of cases) {
    const result = await client.callTool({
      name: "get_native_change_contract",
      arguments: arguments_,
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.deepEqual(result.structuredContent.contract, expected);
  }

  const checkboxOption = hub.state.characteristicOptions.find(
    ({ key }) => key === characteristicOptionKeys.showAllEvents,
  );
  for (const unavailable of [
    { write: false, disabled: false },
    { write: true, disabled: true },
  ]) {
    Object.assign(checkboxOption, unavailable);
    const contract = await client.callTool({
      name: "get_native_change_contract",
      arguments: {
        operation: "characteristic_option",
        target_ref: motionCharacteristicRef,
        option_key: characteristicOptionKeys.showAllEvents,
      },
    });
    assert.equal(contract.isError, true);
    assert.equal(contract.structuredContent.error.code, "insufficient_rights");
  }
  Object.assign(checkboxOption, { write: true, disabled: false });

  const zero = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.retryCount,
      value: 0,
      reason: "Нулевое значение не теряется",
    },
  });
  assert.equal(zero.structuredContent.status, "already_desired");
  const checkbox = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.showAllEvents,
      value: true,
      reason: "Булево значение остаётся boolValue",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: checkbox.structuredContent.change_ref },
  });
  assert.deepEqual(
    hub.state.characteristicOptions.find(
      ({ key }) => key === characteristicOptionKeys.showAllEvents,
    ).value,
    { boolValue: true },
  );

  const writesBeforeRejections = hub.requests.filter(
    ({ characteristic }) => characteristic?.setOptions,
  ).length;
  for (const arguments_ of [
    {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.primary,
      value: 1,
      reason: "GROUP не является значением",
    },
    {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.retryCount,
      value: 5,
      reason: "Значение вне явного диапазона",
    },
    {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.retryCount,
      value: 1.5,
      reason: "longValue не смешивается с дробным значением",
    },
    {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.mode,
      value: 3,
      reason: "Значение вне явного списка",
    },
  ]) {
    const rejected = await client.callTool({
      name: "prepare_native_change",
      arguments: arguments_,
    });
    assert.equal(rejected.isError, true);
  }
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.setOptions)
      .length,
    writesBeforeRejections,
  );

  const mode = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.mode,
      value: 1,
      reason: "Проверить защиту ручного значения",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: mode.structuredContent.change_ref },
  });
  hub.state.characteristicOptions.find(
    ({ key }) => key === characteristicOptionKeys.mode,
  ).value = { intValue: 2 };
  const writesBeforeRestore = hub.requests.filter(
    ({ characteristic }) => characteristic?.setOptions,
  ).length;
  const conflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: mode.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.setOptions)
      .length,
    writesBeforeRestore,
  );
});

test("a characteristic value uses one recoverable native change path", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);

  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
      value: true,
      reason: "Включить офисную лампу",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.match(
    prepared.structuredContent.change_ref,
    /^spruthub-change:\/\/native\/[a-f0-9]{24}$/,
  );
  assert.deepEqual(prepared.structuredContent.diff, {
    value: { from: false, to: true, kind: "boolValue" },
  });
  assert.equal(prepared.structuredContent.native_write_sent, false);
  assert.equal(prepared.structuredContent.restore_supported, false);

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, true);
  assert.deepEqual(applied.structuredContent.observed_value, {
    value: true,
    kind: "boolValue",
  });
  assert.equal(applied.structuredContent.command_caused_observation, "unknown");
  assert.equal(applied.structuredContent.physical_effect_reversible, false);
  assert.equal(hub.state.characteristic.control.value.boolValue, true);

  const updates = hub.requests.filter(
    ({ characteristic }) => characteristic?.update,
  );
  assert.deepEqual(updates, [
    {
      characteristic: {
        update: {
          aId: 34,
          sId: 13,
          cId: 15,
          control: { value: { boolValue: true } },
        },
      },
    },
  ]);
  assert.equal(
    hub.requests.at(-1).characteristic?.get?.cId,
    15,
    "a separate readback must follow the native ACK",
  );
  const readback = await firstClient.callTool({
    name: "get_entity",
    arguments: { entity_ref: characteristicRef },
  });
  assert.equal(readback.isError, undefined, readback.content[0]?.text);
  assert.deepEqual(readback.structuredContent.entity.current_value, {
    value: true,
    source_timestamp: null,
  });

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const afterRestart = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(afterRestart.isError, undefined, afterRestart.content[0]?.text);
  assert.equal(afterRestart.structuredContent.status, "applied");
  assert.deepEqual(afterRestart.structuredContent.observed_value, {
    value: true,
    kind: "boolValue",
  });
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    1,
  );
});

test("a prepared climate mode is restorable through history after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const firstClient = await startClient(t, hub, stateDirectory);

  const noOp = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: climateSettings[0].ref,
      value: climateSettings[0].baseline,
      reason: "Не создавать изменение для уже выбранной температуры",
    },
  });
  assert.deepEqual(noOp.structuredContent, {
    status: "already_desired",
    operation: "characteristic_value",
    target_ref: climateSettings[0].ref,
    observed_value: {
      value: climateSettings[0].baseline,
      kind: climateSettings[0].kind,
    },
    native_write_sent: false,
  });

  const prepared = [];
  for (const setting of climateSettings) {
    const contract = await firstClient.callTool({
      name: "get_native_change_contract",
      arguments: {
        operation: "characteristic_value",
        target_ref: setting.ref,
      },
    });
    assert.equal(contract.isError, undefined, contract.content[0]?.text);
    assert.equal(contract.structuredContent.contract.type, setting.type);
    assert.equal(contract.structuredContent.restore_supported, true);
    assert.equal(contract.structuredContent.physical_effect_reversible, false);

    const change = await firstClient.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "characteristic_value",
        target_ref: setting.ref,
        value: setting.requested,
        reason: "Подготовить согласованный климат офиса",
      },
    });
    assert.equal(change.isError, undefined, change.content[0]?.text);
    assert.equal(change.structuredContent.restore_supported, true);
    assert.equal(change.structuredContent.physical_effect_reversible, false);
    prepared.push(change);
  }

  for (const [index, change] of prepared.entries()) {
    const applied = await firstClient.callTool({
      name: "apply_native_change",
      arguments: { change_ref: change.structuredContent.change_ref },
    });
    assert.equal(applied.structuredContent.status, "applied");
    const writesAfterApply = hub.requests.filter(
      ({ characteristic }) => characteristic?.update,
    ).length;
    const repeated = await firstClient.callTool({
      name: "apply_native_change",
      arguments: { change_ref: change.structuredContent.change_ref },
    });
    assert.equal(repeated.structuredContent.status, "applied");
    assert.equal(
      hub.requests.filter(({ characteristic }) => characteristic?.update)
        .length,
      writesAfterApply,
    );
    assert.deepEqual(
      currentCharacteristicValue(hub, climateSettings[index].ref),
      {
        [climateSettings[index].kind]: climateSettings[index].requested,
      },
    );
  }

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: climateServiceRef },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.deepEqual(
    new Set(
      history.structuredContent.changes.map(({ change_ref }) => change_ref),
    ),
    new Set(
      prepared.map(({ structuredContent }) => structuredContent.change_ref),
    ),
  );

  for (const [index, change] of [...prepared.entries()].reverse()) {
    const restored = await secondClient.callTool({
      name: "restore_native_change",
      arguments: { change_ref: change.structuredContent.change_ref },
    });
    assert.equal(restored.isError, undefined, restored.content[0]?.text);
    assert.equal(restored.structuredContent.status, "restored");
    assert.deepEqual(
      currentCharacteristicValue(hub, climateSettings[index].ref),
      {
        [climateSettings[index].kind]: climateSettings[index].baseline,
      },
    );
  }
});

test("native characteristic choices expose only values that can be prepared", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[1];
  const control = climateControl(hub, setting.type);
  Object.assign(control, {
    minValue: 0,
    maxValue: 2,
    minStep: 1,
    unit: "mode",
    value: { intValue: 0 },
    validValues: [
      {
        key: "AUTO",
        name: "Авто",
        value: { intValue: 0 },
        checked: false,
      },
      { key: "HEAT", name: "Нагрев", value: { intValue: 1 } },
      {
        key: "COOL",
        name: "Охлаждение",
        value: { intValue: 2 },
        checked: true,
      },
      {
        key: "LAST_VALUE",
        name: "Последний режим",
        value: { intValue: -666666 },
        checked: true,
      },
    ],
  });
  const client = await startClient(t, hub, stateDirectory);

  const detail = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: setting.ref },
  });
  assert.equal(detail.isError, undefined, detail.content[0]?.text);
  assert.deepEqual(detail.structuredContent.entity.current_value, {
    value: 0,
    enum: { key: "AUTO", name: "Авто" },
    source_timestamp: null,
  });
  assert.equal(detail.structuredContent.entity.capabilities.unit, "mode");
  assert.equal(
    detail.structuredContent.entity.freshness.source_timestamp,
    null,
  );
  assert.equal(
    typeof detail.structuredContent.entity.freshness.observed_at,
    "string",
  );
  assert.deepEqual(detail.structuredContent.entity.capabilities.valid_values, [
    { key: "HEAT", name: "Нагрев", value: 1 },
    { key: "COOL", name: "Охлаждение", value: 2 },
  ]);

  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
    },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.deepEqual(contract.structuredContent.contract.valid_values, [
    { key: "HEAT", name: "Нагрев", value: 1, kind: "intValue" },
    { key: "COOL", name: "Охлаждение", value: 2, kind: "intValue" },
  ]);
  assert.equal(contract.structuredContent.restore_supported, false);
  assert.equal(
    contract.structuredContent.restore_limitation.code,
    "baseline_not_writable",
  );

  for (const value of [0, -666666]) {
    const rejected = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "characteristic_value",
        target_ref: setting.ref,
        value,
        reason: "Не подготавливать недоступный нативный режим",
      },
    });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent.error.code, "invalid_native_value");
  }
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: 2,
      reason: "Подготовить доступный нативный режим",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.equal(prepared.structuredContent.restore_supported, false);
  assert.equal(
    hub.requests.some(({ characteristic }) => characteristic?.update),
    false,
  );
});

test("an explicit empty characteristic choice set remains restrictive", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[1];
  const control = climateControl(hub, setting.type);
  control.validValues.forEach((candidate) => {
    candidate.checked = false;
  });
  const client = await startClient(t, hub, stateDirectory);

  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
    },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.deepEqual(contract.structuredContent.contract.valid_values, []);

  const unconstrained = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "characteristic_value",
      target_ref: climateSettings[0].ref,
    },
  });
  assert.equal(
    Object.hasOwn(unconstrained.structuredContent.contract, "valid_values"),
    false,
  );

  const rejected = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: 2,
      reason: "Не снимать явное пустое ограничение",
    },
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, "invalid_native_value");
  assert.equal(
    hub.requests.some(({ characteristic }) => characteristic?.update),
    false,
  );
});

test("apply rechecks native characteristic choice availability before writing", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[1];
  const control = climateControl(hub, setting.type);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: 2,
      reason: "Проверить доступность режима перед записью",
    },
  });
  control.validValues.find(({ value }) => value.intValue === 2).checked = false;

  const rejected = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, "invalid_native_value");
  assert.deepEqual(control.value, { intValue: 1 });
  assert.equal(
    hub.requests.some(({ characteristic }) => characteristic?.update),
    false,
  );
});

test("restore rechecks native characteristic baseline availability before writing", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[1];
  const control = climateControl(hub, setting.type);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: 2,
      reason: "Не возвращать ставший недоступным исходный режим",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  control.validValues.find(({ value }) => value.intValue === 1).checked = false;

  const observed = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(observed.isError, undefined, observed.content[0]?.text);
  assert.equal(observed.structuredContent.restore_supported, false);
  assert.equal(
    observed.structuredContent.restore_limitation.code,
    "baseline_not_writable",
  );
  const writesBeforeRestore = hub.requests.filter(
    ({ characteristic }) => characteristic?.update,
  ).length;
  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, true);
  assert.equal(restored.structuredContent.error.code, "restore_unsupported");
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    writesBeforeRestore,
  );
  assert.deepEqual(control.value, { intValue: 2 });
});

test("ordinary decimal native steps accept their represented values", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[0];
  const control = climateControl(hub, setting.type);
  Object.assign(control, {
    minValue: 10,
    maxValue: 30,
    minStep: 0.1,
    value: { doubleValue: 21.6 },
  });
  const client = await startClient(t, hub, stateDirectory);

  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: 21.7,
      reason: "Подготовить обычную дробную уставку",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.deepEqual(prepared.structuredContent.diff.value, {
    from: 21.6,
    to: 21.7,
    kind: "doubleValue",
  });
  const offStep = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: 21.75,
      reason: "Не ослаблять нативный шаг",
    },
  });
  assert.equal(offStep.isError, true);
  assert.equal(offStep.structuredContent.error.code, "invalid_native_value");
});

test("an unchanged command is still delivered to resynchronize external state", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  assert.equal(hub.state.characteristic.control.value.boolValue, false);
  assert.equal(hub.state.externalOn, true);
  const client = await startClient(t, hub, stateDirectory);

  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
      value: false,
      reason: "Повторно синхронизировать исполнитель с сохранённой командой",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.equal(prepared.structuredContent.restore_supported, false);

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(hub.state.externalOn, false);
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    1,
  );
});

test("an invalid climate baseline is reported as non-restorable before apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[0];
  currentCharacteristicValue(hub, setting.ref).doubleValue = 21.3;
  const firstClient = await startClient(t, hub, stateDirectory);

  const contract = await firstClient.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
    },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.equal(contract.structuredContent.restore_supported, false);
  assert.deepEqual(contract.structuredContent.restore_limitation, {
    code: "baseline_not_writable",
    message:
      "The saved baseline cannot be restored automatically: The requested value does not match the native step.",
  });

  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: 22,
      reason: "Подготовить температуру с невозвращаемым исходным значением",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.equal(prepared.structuredContent.restore_supported, false);
  assert.equal(
    prepared.structuredContent.restore_limitation.code,
    "baseline_not_writable",
  );
  assert.ok(
    prepared.structuredContent.limitations.includes(
      prepared.structuredContent.restore_limitation.message,
    ),
  );
  assert.equal(
    prepared.structuredContent.limitations.some((limitation) =>
      limitation.includes("runtime command"),
    ),
    false,
  );
  assert.equal(prepared.structuredContent.diff.value.from, 21.3);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(history.structuredContent.restore_supported, false);
  assert.equal(
    history.structuredContent.restore_limitation.code,
    "baseline_not_writable",
  );
  const restore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restore.isError, true);
  assert.equal(restore.structuredContent.error.code, "restore_unsupported");
});

test("unsupported native values do not report a manually observed baseline as restored", async (t) => {
  const cases = [
    {
      name: "runtime command",
      install() {},
      ref: characteristicRef,
      baseline: false,
      requested: true,
      setBaseline(hub) {
        currentCharacteristicValue(hub, characteristicRef).boolValue = false;
      },
      limitation: undefined,
    },
    {
      name: "climate setting with an invalid baseline",
      install: installClimateFixture,
      ref: climateSettings[0].ref,
      baseline: 21.3,
      requested: 22,
      setBaseline(hub) {
        currentCharacteristicValue(hub, climateSettings[0].ref).doubleValue =
          21.3;
      },
      limitation: "baseline_not_writable",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (t) => {
      const { hub, stateDirectory } = await setup(t);
      testCase.install(hub);
      testCase.setBaseline(hub);
      const firstClient = await startClient(t, hub, stateDirectory);
      const prepared = await firstClient.callTool({
        name: "prepare_native_change",
        arguments: {
          operation: "characteristic_value",
          target_ref: testCase.ref,
          value: testCase.requested,
          reason: "Не объявлять неподдерживаемый возврат выполненным",
        },
      });
      assert.equal(
        prepared.structuredContent.diff.value.from,
        testCase.baseline,
      );
      assert.equal(prepared.structuredContent.restore_supported, false);
      assert.equal(
        prepared.structuredContent.restore_limitation?.code,
        testCase.limitation,
      );
      const applied = await firstClient.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(applied.structuredContent.status, "applied");
      testCase.setBaseline(hub);
      const writesAfterManualChange = hub.requests.filter(
        ({ characteristic }) => characteristic?.update,
      ).length;
      const firstObservation = await firstClient.callTool({
        name: "get_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(firstObservation.structuredContent.status, "conflict");
      assert.equal(
        firstObservation.structuredContent.manual_change_observed,
        true,
      );
      await firstClient.close();

      const secondClient = await startClient(t, hub, stateDirectory);
      for (const tool of ["get_native_change", "apply_native_change"]) {
        const result = await secondClient.callTool({
          name: tool,
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });
        assert.equal(result.isError, undefined, result.content[0]?.text);
        assert.equal(result.structuredContent.status, "conflict", tool);
        assert.equal(
          result.structuredContent.conflict_reason,
          "manual_change",
          tool,
        );
        assert.equal(
          result.structuredContent.manual_change_observed,
          true,
          tool,
        );
        assert.equal(
          result.structuredContent.verification.result,
          "baseline_value_observed",
          tool,
        );
        assert.equal(result.structuredContent.restore_supported, false, tool);
      }
      assert.equal(
        hub.requests.filter(({ characteristic }) => characteristic?.update)
          .length,
        writesAfterManualChange,
      );
    });
  }
});

test("an interrupted climate mode restores only settings that were applied", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = [];
  for (const setting of climateSettings) {
    prepared.push(
      await firstClient.callTool({
        name: "prepare_native_change",
        arguments: {
          operation: "characteristic_value",
          target_ref: setting.ref,
          value: setting.requested,
          reason: "Подготовить прерываемый климатический режим",
        },
      }),
    );
  }
  for (const change of prepared.slice(0, 2)) {
    const applied = await firstClient.callTool({
      name: "apply_native_change",
      arguments: { change_ref: change.structuredContent.change_ref },
    });
    assert.equal(applied.structuredContent.status, "applied");
  }
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const untouched = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared[2].structuredContent.change_ref },
  });
  assert.equal(untouched.structuredContent.status, "not_owned");
  assert.equal(
    untouched.structuredContent.conflict_reason,
    "change_was_not_applied",
  );
  assert.deepEqual(currentCharacteristicValue(hub, climateSettings[2].ref), {
    [climateSettings[2].kind]: climateSettings[2].baseline,
  });
  for (const index of [1, 0]) {
    const restored = await secondClient.callTool({
      name: "restore_native_change",
      arguments: { change_ref: prepared[index].structuredContent.change_ref },
    });
    assert.equal(restored.structuredContent.status, "restored");
    assert.deepEqual(
      currentCharacteristicValue(hub, climateSettings[index].ref),
      {
        [climateSettings[index].kind]: climateSettings[index].baseline,
      },
    );
  }
});

test("climate restore preserves a later manual setting", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const firstClient = await startClient(t, hub, stateDirectory);
  const setting = climateSettings[0];
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: setting.requested,
      reason: "Настроить температуру офиса",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const manualValue = { doubleValue: 24 };
  const stored = currentCharacteristicValue(hub, setting.ref);
  Object.assign(stored, manualValue);
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const conflict = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.deepEqual(currentCharacteristicValue(hub, setting.ref), manualValue);
});

test("a third climate value resolves an uncertain restore as a manual conflict", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[0];
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: setting.requested,
      reason: "Проверить ручную настройку после потерянного возврата",
    },
  });
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");

  hub.state.behavior.dropNextCharacteristicUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.write_intent.direction, "restore");
  currentCharacteristicValue(hub, setting.ref).doubleValue = 24;
  const writesBeforeReconciliation = hub.requests.filter(
    ({ characteristic }) => characteristic?.update,
  ).length;
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const conflict = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.deepEqual(conflict.structuredContent.observed_value, {
    value: 24,
    kind: setting.kind,
  });
  assert.equal(conflict.structuredContent.write_intent.direction, "restore");
  assert.deepEqual(currentCharacteristicValue(hub, setting.ref), {
    [setting.kind]: 24,
  });
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    writesBeforeReconciliation,
  );

  const repeated = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "conflict");
  assert.equal(repeated.structuredContent.conflict_reason, "manual_change");
  assert.deepEqual(currentCharacteristicValue(hub, setting.ref), {
    [setting.kind]: 24,
  });
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    writesBeforeReconciliation,
  );
});

test("a manual value after an unknown climate apply stays a conflict across restore and restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[0];
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: setting.requested,
      reason: "Сохранить неизвестный исход климатической команды",
    },
  });
  hub.state.behavior.dropNextCharacteristicUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  currentCharacteristicValue(hub, setting.ref).doubleValue = 24;
  const writesAfterUnknownApply = hub.requests.filter(
    ({ characteristic }) => characteristic?.update,
  ).length;
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const conflict = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.equal(
    conflict.structuredContent.write_intent.phase,
    "needs_reconciliation",
  );
  const firstRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(firstRestore.structuredContent.status, "conflict");
  assert.equal(firstRestore.structuredContent.conflict_reason, "manual_change");
  assert.equal(
    firstRestore.structuredContent.write_intent.phase,
    "needs_reconciliation",
  );
  await secondClient.close();

  const thirdClient = await startClient(t, hub, stateDirectory);
  const repeatedRestore = await thirdClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeatedRestore.structuredContent.status, "conflict");
  assert.equal(
    repeatedRestore.structuredContent.conflict_reason,
    "manual_change",
  );
  assert.equal(
    repeatedRestore.structuredContent.write_intent.phase,
    "needs_reconciliation",
  );
  assert.deepEqual(currentCharacteristicValue(hub, setting.ref), {
    [setting.kind]: 24,
  });
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    writesAfterUnknownApply,
  );
});

test("an observed manual climate change cannot regain restore ownership", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[0];
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: setting.requested,
      reason: "Не присваивать последующий ручной выбор старому изменению",
    },
  });
  hub.state.behavior.dropNextCharacteristicUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");

  currentCharacteristicValue(hub, setting.ref).doubleValue = 24;
  const conflict = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.equal(conflict.structuredContent.manual_change_observed, true);

  currentCharacteristicValue(hub, setting.ref).doubleValue = setting.requested;
  const writesAfterManualChange = hub.requests.filter(
    ({ characteristic }) => characteristic?.update,
  ).length;
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  for (const tool of [
    "get_native_change",
    "apply_native_change",
    "restore_native_change",
  ]) {
    const result = await secondClient.callTool({
      name: tool,
      arguments: { change_ref: prepared.structuredContent.change_ref },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.equal(result.structuredContent.status, "conflict", tool);
    assert.equal(
      result.structuredContent.conflict_reason,
      "manual_change",
      tool,
    );
    assert.equal(result.structuredContent.manual_change_observed, true, tool);
    assert.equal(
      result.structuredContent.verification.result,
      "requested_value_observed",
      tool,
    );
    assert.equal(
      result.structuredContent.recovered_after_uncertain_write,
      undefined,
      tool,
    );
  }
  assert.deepEqual(currentCharacteristicValue(hub, setting.ref), {
    [setting.kind]: setting.requested,
  });
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    writesAfterManualChange,
  );
  currentCharacteristicValue(hub, setting.ref).doubleValue = setting.baseline;
  const baselineObserved = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(baselineObserved.structuredContent.status, "restored");
  assert.equal(
    baselineObserved.structuredContent.verification.result,
    "baseline_value_observed",
  );
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    writesAfterManualChange,
  );
});

test("a confirmed climate change loses restore ownership after an observed manual value", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[0];
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: setting.requested,
      reason: "Сохранить ручной выбор после подтверждённого применения",
    },
  });
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  currentCharacteristicValue(hub, setting.ref).doubleValue = 24;
  const conflict = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.manual_change_observed, true);
  currentCharacteristicValue(hub, setting.ref).doubleValue = setting.requested;
  const writesAfterManualChange = hub.requests.filter(
    ({ characteristic }) => characteristic?.update,
  ).length;
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const refusedRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refusedRestore.structuredContent.status, "conflict");
  assert.equal(
    refusedRestore.structuredContent.conflict_reason,
    "manual_change",
  );
  assert.equal(refusedRestore.structuredContent.manual_change_observed, true);
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    writesAfterManualChange,
  );
});

test("an uncertain climate change cannot claim another applied change", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[0];
  const firstClient = await startClient(t, hub, stateDirectory);
  const first = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: setting.requested,
      reason: "Сохранить границу владения первого изменения",
    },
  });
  hub.state.behavior.dropNextCharacteristicUpdate = true;
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  currentCharacteristicValue(hub, setting.ref).doubleValue = 24;
  const firstConflict = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  assert.equal(firstConflict.structuredContent.status, "conflict");

  const second = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: setting.requested,
      reason: "Явно применить новое изменение после ручного выбора",
    },
  });
  const secondApplied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: second.structuredContent.change_ref },
  });
  assert.equal(secondApplied.structuredContent.status, "applied");
  const writesAfterSecondApply = hub.requests.filter(
    ({ characteristic }) => characteristic?.update,
  ).length;
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const observedFirst = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  assert.equal(observedFirst.structuredContent.status, "conflict");
  assert.equal(
    observedFirst.structuredContent.conflict_reason,
    "manual_change",
  );
  assert.equal(observedFirst.structuredContent.manual_change_observed, true);
  const refusedRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  assert.equal(refusedRestore.structuredContent.status, "conflict");
  assert.deepEqual(currentCharacteristicValue(hub, setting.ref), {
    [setting.kind]: setting.requested,
  });
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    writesAfterSecondApply,
  );
});

test("an observed manual option change cannot regain restore ownership", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_option",
      target_ref: motionCharacteristicRef,
      option_key: characteristicOptionKeys.switchOffTime,
      value: 10,
      reason: "Не присваивать ручную настройку старому изменению",
    },
  });
  hub.state.behavior.dropNextCharacteristicSetOptions = true;
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const option = hub.state.characteristicOptions.find(
    ({ key }) => key === characteristicOptionKeys.switchOffTime,
  );
  option.value = { doubleValue: 99 };
  const conflict = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  option.value = { doubleValue: 10 };
  const writesAfterManualChange = hub.requests.filter(
    ({ characteristic }) => characteristic?.setOptions,
  ).length;
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  for (const tool of ["get_native_change", "restore_native_change"]) {
    const result = await secondClient.callTool({
      name: tool,
      arguments: { change_ref: prepared.structuredContent.change_ref },
    });
    assert.equal(result.structuredContent.status, "conflict", tool);
    assert.equal(
      result.structuredContent.conflict_reason,
      "manual_change",
      tool,
    );
    assert.equal(result.structuredContent.manual_change_observed, true, tool);
  }
  assert.deepEqual(option.value, { doubleValue: 10 });
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.setOptions)
      .length,
    writesAfterManualChange,
  );
});

test("a published manual option conflict remains unowned in the new runtime", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const fixture = JSON.parse(
    await readFile(
      path.join(
        projectRoot,
        "test/fixtures/published-option-manual-conflict.json",
      ),
      "utf8",
    ),
  );
  const fingerprint = createHash("sha256")
    .update(`${hub.url}\0${serial}`)
    .digest("hex");
  const change = fixture.change;
  await writeFile(
    path.join(
      stateDirectory,
      `automation-changes-${fingerprint.slice(0, 24)}.json`,
    ),
    `${JSON.stringify(
      {
        version: 1,
        hub_fingerprint: fingerprint,
        changes: { [change.id]: change },
      },
      null,
      2,
    )}\n`,
  );
  const option = hub.state.characteristicOptions.find(
    ({ key }) => key === characteristicOptionKeys.switchOffTime,
  );
  option.value = { doubleValue: 10 };
  const client = await startClient(t, hub, stateDirectory);
  const changeRef = `spruthub-change://native/${change.id}`;
  const writesBefore = hub.requests.filter(
    ({ characteristic }) => characteristic?.setOptions,
  ).length;

  for (const tool of [
    "get_native_change",
    "apply_native_change",
    "restore_native_change",
  ]) {
    const result = await client.callTool({
      name: tool,
      arguments: { change_ref: changeRef },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.equal(result.structuredContent.status, "conflict", tool);
    assert.equal(
      result.structuredContent.conflict_reason,
      "manual_change",
      tool,
    );
    assert.equal(result.structuredContent.manual_change_observed, true, tool);
  }
  assert.deepEqual(option.value, { doubleValue: 10 });
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.setOptions)
      .length,
    writesBefore,
  );
});

test("a published sent option that became not-owned never regains write ownership", async (t) => {
  const fixture = JSON.parse(
    await readFile(
      path.join(
        projectRoot,
        "test/fixtures/published-option-not-owned-after-restore.json",
      ),
      "utf8",
    ),
  );
  for (const observed of [
    { label: "third value", value: 99, status: "conflict" },
    { label: "requested value", value: 10, status: "conflict" },
    { label: "baseline value", value: 180, status: "restored" },
  ]) {
    await t.test(observed.label, async (t) => {
      const { hub, stateDirectory } = await setup(t);
      const fingerprint = createHash("sha256")
        .update(`${hub.url}\0${serial}`)
        .digest("hex");
      const change = structuredClone(fixture.change);
      await writeFile(
        path.join(
          stateDirectory,
          `automation-changes-${fingerprint.slice(0, 24)}.json`,
        ),
        `${JSON.stringify(
          {
            version: 1,
            hub_fingerprint: fingerprint,
            changes: { [change.id]: change },
          },
          null,
          2,
        )}\n`,
      );
      const option = hub.state.characteristicOptions.find(
        ({ key }) => key === characteristicOptionKeys.switchOffTime,
      );
      option.value = { doubleValue: observed.value };
      const changeRef = `spruthub-change://native/${change.id}`;
      const writesBefore = hub.requests.filter(
        ({ characteristic }) => characteristic?.setOptions,
      ).length;

      for (let process = 0; process < 2; process += 1) {
        const client = await startClient(t, hub, stateDirectory);
        for (const tool of [
          "get_native_change",
          "restore_native_change",
          "apply_native_change",
        ]) {
          const result = await client.callTool({
            name: tool,
            arguments: { change_ref: changeRef },
          });
          assert.equal(result.isError, undefined, result.content[0]?.text);
          assert.equal(result.structuredContent.status, observed.status, tool);
          assert.equal(result.structuredContent.native_write_sent, true, tool);
          assert.equal(
            result.structuredContent.manual_change_observed,
            true,
            tool,
          );
          if (observed.status === "conflict") {
            assert.equal(
              result.structuredContent.conflict_reason,
              "manual_change",
              tool,
            );
          }
        }
        await client.close();
      }
      assert.deepEqual(option.value, { doubleValue: observed.value });
      assert.equal(
        hub.requests.filter(({ characteristic }) => characteristic?.setOptions)
          .length,
        writesBefore,
      );
    });
  }
});

test("a published sent option without manual evidence remains not-owned", async (t) => {
  const fixture = JSON.parse(
    await readFile(
      path.join(
        projectRoot,
        "test/fixtures/published-option-not-owned-without-manual-evidence.json",
      ),
      "utf8",
    ),
  );
  for (const observed of [
    { label: "requested value", value: 10 },
    { label: "baseline value", value: 180 },
  ]) {
    await t.test(observed.label, async (t) => {
      const { hub, stateDirectory } = await setup(t);
      const fingerprint = createHash("sha256")
        .update(`${hub.url}\0${serial}`)
        .digest("hex");
      const change = structuredClone(fixture.change);
      await writeFile(
        path.join(
          stateDirectory,
          `automation-changes-${fingerprint.slice(0, 24)}.json`,
        ),
        `${JSON.stringify(
          {
            version: 1,
            hub_fingerprint: fingerprint,
            changes: { [change.id]: change },
          },
          null,
          2,
        )}\n`,
      );
      const option = hub.state.characteristicOptions.find(
        ({ key }) => key === characteristicOptionKeys.switchOffTime,
      );
      option.value = { doubleValue: observed.value };
      const changeRef = `spruthub-change://native/${change.id}`;
      const writesBefore = hub.requests.filter(
        ({ characteristic }) => characteristic?.setOptions,
      ).length;
      const results = [];

      for (let process = 0; process < 2; process += 1) {
        const client = await startClient(t, hub, stateDirectory);
        for (const tool of [
          "get_native_change",
          "restore_native_change",
          "apply_native_change",
        ]) {
          const result = await client.callTool({
            name: tool,
            arguments: { change_ref: changeRef },
          });
          results.push({ tool, result });
        }
        await client.close();
      }
      assert.deepEqual(option.value, { doubleValue: observed.value });
      assert.equal(
        hub.requests.filter(({ characteristic }) => characteristic?.setOptions)
          .length,
        writesBefore,
      );
      for (const { tool, result } of results) {
        assert.equal(result.isError, undefined, result.content[0]?.text);
        assert.equal(result.structuredContent.status, "not_owned", tool);
        assert.equal(result.structuredContent.native_write_sent, true, tool);
        assert.equal(result.structuredContent.conflict_reason, undefined, tool);
        assert.equal(
          result.structuredContent.manual_change_observed,
          undefined,
          tool,
        );
      }
    });
  }
});

test("a readable command stays non-restorable and is not retried after an unknown apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const contract = await firstClient.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
    },
  });
  assert.equal(contract.structuredContent.contract.type, "On");
  assert.equal(contract.structuredContent.restore_supported, false);
  assert.equal(contract.structuredContent.physical_effect_reversible, false);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
      value: true,
      reason: "Проверить неизвестный исход команды",
    },
  });
  hub.state.behavior.dropNextCharacteristicUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    1,
  );
  const restore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restore.isError, true);
  assert.equal(restore.structuredContent.error.code, "restore_unsupported");
});

test("a climate setting is not resent after an unknown apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[0];
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: setting.requested,
      reason: "Не повторять климатическую команду после потери ответа",
    },
  });
  hub.state.behavior.dropNextCharacteristicUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    1,
  );
  assert.deepEqual(currentCharacteristicValue(hub, setting.ref), {
    [setting.kind]: setting.baseline,
  });
});

test("a climate baseline is not resent after an unknown restore", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const setting = climateSettings[0];
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: setting.ref,
      value: setting.requested,
      reason: "Не повторять возврат после потери ответа",
    },
  });
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  hub.state.behavior.dropNextCharacteristicUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.write_intent.direction, "restore");
  const writesAfterUnknownRestore = hub.requests.filter(
    ({ characteristic }) => characteristic?.update,
  ).length;
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(repeated.structuredContent.write_intent.direction, "restore");
  assert.deepEqual(currentCharacteristicValue(hub, setting.ref), {
    [setting.kind]: setting.requested,
  });
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    writesAfterUnknownRestore,
  );
});

test("a lost characteristic response is reconciled without another command", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
      value: true,
      reason: "Включить лампу",
    },
  });
  hub.state.behavior.closeAfterCharacteristicUpdate = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, false);
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    1,
  );
});

function installLivingRoomLights(hub) {
  hub.state.rooms.push({ id: 3, order: 3, name: "Гостиная", visible: true });
  for (const [id, name] of [
    [40, "Люстра"],
    [41, "Торшер"],
    [42, "Бра"],
  ]) {
    hub.state.accessories.push({
      id,
      roomId: 3,
      name,
      online: true,
      services: [
        {
          aId: id,
          sId: 13,
          name: "Свет",
          type: "Lightbulb",
          characteristics: [
            {
              aId: id,
              sId: 13,
              cId: 15,
              control: {
                name: "Включена",
                type: "On",
                read: true,
                write: true,
                value: { boolValue: true },
              },
            },
            {
              aId: id,
              sId: 13,
              cId: 16,
              control: {
                name: "Яркость",
                type: "Brightness",
                read: true,
                write: true,
                minValue: 0,
                maxValue: 100,
                minStep: 1,
                value: { intValue: 70 },
              },
            },
          ],
        },
      ],
    });
  }
  const lamp = (id) => ({
    on: `${homeRef}/accessory/${id}/service/13/characteristic/15`,
    brightness: `${homeRef}/accessory/${id}/service/13/characteristic/16`,
  });
  return { chandelier: lamp(40), floor: lamp(41), sconce: lamp(42) };
}

function livingRoomOff(lights) {
  return [lights.floor, lights.chandelier, lights.sconce].map(({ on }) => ({
    target_ref: on,
    value: false,
  }));
}

async function sendDeviceCommands(
  client,
  commands,
  reason = "Выключить весь свет в гостиной",
) {
  return client.callTool({
    name: "send_device_commands",
    arguments: { home_ref: homeRef, commands, reason },
  });
}

function deviceCommandUpdates(hub, ref) {
  const updates = hub.requests
    .filter(({ characteristic }) => characteristic?.update)
    .map(({ characteristic }) => characteristic.update);
  if (ref === undefined) return updates;
  const [, aId, sId, cId] =
    /\/accessory\/(\d+)\/service\/(\d+)\/characteristic\/(\d+)$/
      .exec(ref)
      .map(Number);
  return updates.filter(
    (update) => update.aId === aId && update.sId === sId && update.cId === cId,
  );
}

function offUpdate(aId) {
  return { aId, sId: 13, cId: 15, control: { value: { boolValue: false } } };
}

function commandOutcome({
  target_ref,
  name,
  type,
  requested,
  status,
  sent,
  observed_value,
  restore_supported,
}) {
  return {
    target_ref,
    name,
    type,
    requested,
    status,
    sent,
    observed_value,
    restore_supported,
  };
}

test("device commands turn off several lamps in one call and journal each command", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const lights = installLivingRoomLights(hub);
  const client = await startClient(t, hub, stateDirectory);

  const sent = await sendDeviceCommands(client, livingRoomOff(lights));
  assert.equal(sent.isError, undefined, sent.content[0]?.text);
  assert.equal(sent.structuredContent.status, "ok");
  assert.deepEqual(sent.structuredContent.summary, {
    total: 3,
    applied: 3,
    already_desired: 0,
    uncertain: 0,
    conflict: 0,
    rejected: 0,
    not_sent: 0,
  });
  const { results } = sent.structuredContent;
  assert.deepEqual(
    results.map(commandOutcome),
    [
      ["Торшер", lights.floor.on],
      ["Люстра", lights.chandelier.on],
      ["Бра", lights.sconce.on],
    ].map(([name, ref]) => ({
      target_ref: ref,
      name: `${name} / Свет`,
      type: "On",
      requested: false,
      status: "applied",
      sent: true,
      observed_value: false,
      restore_supported: false,
    })),
  );
  for (const { change_ref: changeRef } of results) {
    assert.match(changeRef, /^spruthub-change:\/\/native\/[a-f0-9]{24}$/);
  }
  assert.equal(new Set(results.map(({ change_ref }) => change_ref)).size, 3);

  assert.deepEqual(deviceCommandUpdates(hub), [
    offUpdate(41),
    offUpdate(40),
    offUpdate(42),
  ]);
  for (const { on, brightness } of Object.values(lights)) {
    assert.deepEqual(currentCharacteristicValue(hub, on), { boolValue: false });
    assert.deepEqual(currentCharacteristicValue(hub, brightness), {
      intValue: 70,
    });
  }

  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, limit: 50 },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.deepEqual(
    history.structuredContent.changes
      .map(({ change_ref, operation, recorded_status }) => ({
        change_ref,
        operation,
        recorded_status,
      }))
      .sort((left, right) => left.change_ref.localeCompare(right.change_ref)),
    results
      .map(({ change_ref }) => ({
        change_ref,
        operation: "characteristic_value",
        recorded_status: "applied",
      }))
      .sort((left, right) => left.change_ref.localeCompare(right.change_ref)),
  );
  const detail = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: results[0].change_ref },
  });
  assert.equal(detail.isError, undefined, detail.content[0]?.text);
  assert.equal(detail.structuredContent.status, "applied");
  assert.equal(detail.structuredContent.target_ref, lights.floor.on);
  assert.equal(
    detail.structuredContent.reason,
    "Выключить весь свет в гостиной",
  );
});

test("device commands skip an already chosen setting and still deliver an equal lamp command", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const lights = installLivingRoomLights(hub);
  const [temperature] = climateSettings;
  currentCharacteristicValue(hub, lights.floor.on).boolValue = false;
  const client = await startClient(t, hub, stateDirectory);

  const sent = await sendDeviceCommands(
    client,
    [
      { target_ref: temperature.ref, value: temperature.baseline },
      { target_ref: lights.floor.on, value: false },
      { target_ref: lights.chandelier.on, value: false },
    ],
    "Выключить свет, в гостиной оставить 21 градус",
  );
  assert.equal(sent.isError, undefined, sent.content[0]?.text);
  assert.equal(sent.structuredContent.status, "ok");
  const [setpoint, floor, chandelier] = sent.structuredContent.results;
  assert.deepEqual(
    { ...commandOutcome(setpoint), change_ref: setpoint.change_ref },
    {
      target_ref: temperature.ref,
      name: "Лампа / Климат офиса",
      type: "TargetTemperature",
      requested: temperature.baseline,
      status: "already_desired",
      sent: false,
      observed_value: temperature.baseline,
      restore_supported: false,
      change_ref: null,
    },
  );
  // A lamp command of unknown semantics is delivered even when the hub
  // already shows the requested value, to resynchronize the actuator.
  assert.equal(floor.status, "applied");
  assert.equal(floor.sent, true);
  assert.equal(chandelier.status, "applied");
  assert.deepEqual(deviceCommandUpdates(hub), [offUpdate(41), offUpdate(40)]);
  assert.deepEqual(sent.structuredContent.summary, {
    total: 3,
    applied: 2,
    already_desired: 1,
    uncertain: 0,
    conflict: 0,
    rejected: 0,
    not_sent: 0,
  });
});

test("a setpoint sent as a device command stays restorable", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installClimateFixture(hub);
  const [temperature] = climateSettings;
  const client = await startClient(t, hub, stateDirectory);

  const sent = await sendDeviceCommands(
    client,
    [{ target_ref: temperature.ref, value: temperature.requested }],
    "Сделать теплее",
  );
  assert.equal(sent.isError, undefined, sent.content[0]?.text);
  const [setpoint] = sent.structuredContent.results;
  assert.equal(setpoint.status, "applied");
  assert.equal(setpoint.restore_supported, true);
  assert.deepEqual(currentCharacteristicValue(hub, temperature.ref), {
    doubleValue: temperature.requested,
  });

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: setpoint.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(currentCharacteristicValue(hub, temperature.ref), {
    doubleValue: temperature.baseline,
  });
});

test("one invalid device command rejects the whole call before any write", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const lights = installLivingRoomLights(hub);
  const readOnlyRef = `${homeRef}/accessory/34/service/13/characteristic/17`;
  const client = await startClient(t, hub, stateDirectory);

  const rejected = await sendDeviceCommands(client, [
    { target_ref: lights.floor.on, value: false },
    { target_ref: lights.chandelier.brightness, value: 101 },
    { target_ref: readOnlyRef, value: false },
    { target_ref: lights.sconce.on, value: "off" },
  ]);
  assert.equal(rejected.isError, true);
  assert.equal(
    rejected.structuredContent.error.code,
    "invalid_device_commands",
  );
  const invalid = rejected.structuredContent.invalid_commands;
  assert.deepEqual(
    invalid.map(({ index, target_ref, code }) => ({ index, target_ref, code })),
    [
      {
        index: 1,
        target_ref: lights.chandelier.brightness,
        code: "invalid_native_value",
      },
      { index: 2, target_ref: readOnlyRef, code: "insufficient_rights" },
      {
        index: 3,
        target_ref: lights.sconce.on,
        code: "invalid_native_value",
      },
    ],
  );
  assert.deepEqual(invalid[0].contract, {
    type: "Brightness",
    kind: "intValue",
    min: 0,
    max: 100,
    step: 1,
  });
  assert.deepEqual(invalid[2].contract, { type: "On", kind: "boolValue" });
  for (const item of invalid) {
    assert.equal(typeof item.message, "string");
  }

  assert.deepEqual(deviceCommandUpdates(hub), []);
  for (const { on } of Object.values(lights)) {
    assert.deepEqual(currentCharacteristicValue(hub, on), { boolValue: true });
  }
  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef },
  });
  assert.deepEqual(history.structuredContent.changes, []);
});

test("duplicate or foreign-home device commands are rejected before any hub request", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const lights = installLivingRoomLights(hub);
  const client = await startClient(t, hub, stateDirectory);
  const requestsBefore = hub.requests.length;

  const duplicate = await sendDeviceCommands(client, [
    { target_ref: lights.floor.on, value: false },
    { target_ref: lights.chandelier.on, value: false },
    { target_ref: lights.floor.on, value: true },
  ]);
  assert.equal(duplicate.isError, true);
  assert.equal(
    duplicate.structuredContent.error.code,
    "invalid_device_commands",
  );
  assert.deepEqual(
    duplicate.structuredContent.invalid_commands.map(
      ({ index, target_ref, code }) => ({ index, target_ref, code }),
    ),
    [{ index: 2, target_ref: lights.floor.on, code: "duplicate_target" }],
  );

  const foreignRef =
    "spruthub://hub/other-home/accessory/41/service/13/characteristic/15";
  const foreign = await sendDeviceCommands(client, [
    { target_ref: lights.floor.on, value: false },
    { target_ref: foreignRef, value: false },
  ]);
  assert.equal(foreign.isError, true);
  assert.deepEqual(
    foreign.structuredContent.invalid_commands.map(
      ({ index, target_ref, code }) => ({ index, target_ref, code }),
    ),
    [{ index: 1, target_ref: foreignRef, code: "unsupported_home_write" }],
  );

  assert.equal(hub.requests.length, requestsBefore);
});

test("a lost device command response is not resent by a repeated call until its outcome is known", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const lights = installLivingRoomLights(hub);
  const firstClient = await startClient(t, hub, stateDirectory);
  hub.state.behavior.dropNextCharacteristicUpdate = true;

  const first = await sendDeviceCommands(firstClient, livingRoomOff(lights));
  assert.equal(first.isError, undefined, first.content[0]?.text);
  assert.equal(first.structuredContent.status, "incomplete");
  assert.deepEqual(
    first.structuredContent.results.map(({ status, sent }) => ({
      status,
      sent,
    })),
    [
      { status: "uncertain", sent: true },
      { status: "applied", sent: true },
      { status: "applied", sent: true },
    ],
  );
  const lost = first.structuredContent.results[0];
  assert.equal(lost.observed_value, true);
  assert.deepEqual(lost.next, {
    tool: "get_native_change",
    arguments: { change_ref: lost.change_ref },
  });
  assert.equal(deviceCommandUpdates(hub, lights.floor.on).length, 1);
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await sendDeviceCommands(
    secondClient,
    livingRoomOff(lights),
  );
  assert.equal(repeated.isError, undefined, repeated.content[0]?.text);
  const [floor, chandelier, sconce] = repeated.structuredContent.results;
  assert.deepEqual(
    {
      status: floor.status,
      sent: floor.sent,
      change_ref: floor.change_ref,
      reason: floor.reason,
      observed_value: floor.observed_value,
      next: floor.next,
    },
    {
      status: "uncertain",
      sent: false,
      change_ref: lost.change_ref,
      reason: "earlier_command_unresolved",
      observed_value: true,
      next: lost.next,
    },
  );
  assert.equal(chandelier.status, "applied");
  assert.equal(sconce.status, "applied");
  assert.equal(deviceCommandUpdates(hub, lights.floor.on).length, 1);
  assert.equal(deviceCommandUpdates(hub).length, 5);

  // The lamp reports the requested value late: the earlier command is
  // reconciled by readback and the new request is sent as a new intent.
  currentCharacteristicValue(hub, lights.floor.on).boolValue = false;
  const afterReport = await sendDeviceCommands(secondClient, [
    { target_ref: lights.floor.on, value: false },
  ]);
  assert.equal(afterReport.isError, undefined, afterReport.content[0]?.text);
  const [resent] = afterReport.structuredContent.results;
  assert.equal(resent.status, "applied");
  assert.equal(resent.sent, true);
  assert.notEqual(resent.change_ref, lost.change_ref);
  const earlier = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: lost.change_ref },
  });
  assert.equal(earlier.structuredContent.status, "applied");
  assert.equal(deviceCommandUpdates(hub, lights.floor.on).length, 2);
});

test("a different command to a lamp with an uncertain earlier command is sent", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const lights = installLivingRoomLights(hub);
  const client = await startClient(t, hub, stateDirectory);
  hub.state.behavior.dropNextCharacteristicUpdate = true;
  const first = await sendDeviceCommands(client, [
    { target_ref: lights.floor.on, value: false },
  ]);
  assert.equal(first.structuredContent.results[0].status, "uncertain");

  const turnedOn = await sendDeviceCommands(
    client,
    [{ target_ref: lights.floor.on, value: true }],
    "Всё-таки включить торшер",
  );
  assert.equal(turnedOn.isError, undefined, turnedOn.content[0]?.text);
  const [floor] = turnedOn.structuredContent.results;
  assert.equal(floor.status, "applied");
  assert.equal(floor.sent, true);
  assert.deepEqual(deviceCommandUpdates(hub, lights.floor.on), [
    offUpdate(41),
    { aId: 41, sId: 13, cId: 15, control: { value: { boolValue: true } } },
  ]);
});

test("a rejected device command does not stop the remaining commands", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const lights = installLivingRoomLights(hub);
  const client = await startClient(t, hub, stateDirectory);
  hub.state.behavior.rejectNextCharacteristicUpdate = true;

  const sent = await sendDeviceCommands(client, livingRoomOff(lights));
  assert.equal(sent.isError, undefined, sent.content[0]?.text);
  assert.equal(sent.structuredContent.status, "incomplete");
  const [floor, chandelier, sconce] = sent.structuredContent.results;
  assert.equal(floor.status, "rejected");
  assert.equal(floor.sent, true);
  assert.equal(floor.error.code, "request_rejected");
  assert.equal(chandelier.status, "applied");
  assert.equal(sconce.status, "applied");
  assert.deepEqual(currentCharacteristicValue(hub, lights.floor.on), {
    boolValue: true,
  });
  assert.deepEqual(currentCharacteristicValue(hub, lights.sconce.on), {
    boolValue: false,
  });
  assert.equal(sent.structuredContent.summary.rejected, 1);

  const detail = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: floor.change_ref },
  });
  assert.equal(detail.structuredContent.status, "not_applied");
});

test("apply revalidates the current characteristic contract and BLOCK bindings", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const brightnessRef = `${homeRef}/accessory/34/service/13/characteristic/16`;
  const characteristicChange = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: brightnessRef,
      value: 30,
      reason: "Изменить яркость",
    },
  });
  hub.state.accessories[1].services[0].characteristics.find(
    ({ cId }) => cId === 16,
  ).control.maxValue = 25;

  const rejectedCharacteristic = await client.callTool({
    name: "apply_native_change",
    arguments: {
      change_ref: characteristicChange.structuredContent.change_ref,
    },
  });
  assert.equal(rejectedCharacteristic.isError, true);
  assert.equal(
    hub.requests.some(({ characteristic }) => characteristic?.update),
    false,
  );

  const data = blockData();
  delete data.vendorConfiguration;
  const blockChange = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Проверка topology drift",
      description: "Не применять при изменившейся привязке",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить свежую привязку",
    },
  });
  hub.state.accessories[1].services[0].type = "Outlet";

  const rejectedBlock = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: blockChange.structuredContent.change_ref },
  });
  assert.equal(rejectedBlock.isError, true);
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create),
    false,
  );
});

test("versioned BLOCK contract prepares different supported compositions", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "block_create" },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.equal(contract.structuredContent.status, "ok");
  assert.equal(contract.structuredContent.contract.version, "2026-09-24");
  assert.equal(
    contract.structuredContent.contract.source.frontend_sha256,
    "81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8",
  );
  assert.deepEqual(contract.structuredContent.contract.supported.target_types, [
    "if",
    "service",
    "delay",
    "scenario",
  ]);

  const nestedData = blockData({ nested: true });
  delete nestedData.vendorConfiguration;
  nestedData.targets[0].then[1].index = 2;
  const simpleData = blockData();
  delete simpleData.vendorConfiguration;
  for (const [name, data] of [
    ["Вложенное условие", nestedData],
    ["Сброс таймера", simpleData],
  ]) {
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_create",
        target_ref: homeRef,
        name,
        description: "Проверенная нативная композиция",
        active: false,
        on_start: false,
        sync: false,
        data,
        reason: "Подготовить BLOCK",
      },
    });
    assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
    assert.equal(prepared.structuredContent.status, "prepared");
    assert.equal(prepared.structuredContent.operation, "block_create");
    assert.equal(prepared.structuredContent.native_write_sent, false);
    assert.equal(prepared.structuredContent.diff.configuration.from, null);
    assert.equal(prepared.structuredContent.diff.configuration.to.name, name);
    assert.equal(
      prepared.structuredContent.diff.configuration.to.type,
      "BLOCK",
    );
    assert.deepEqual(
      prepared.structuredContent.diff.configuration.to.data,
      data,
    );
    assert.match(
      prepared.structuredContent.diff.configuration.to.desc,
      /sprut-agent:native:[a-f0-9]{24}/,
    );
  }
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );
});

test("prepared BLOCK changes preserve typed branch commands and their preparation observations", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const scheduledData = dailyIntervalBlockData({
    inside: "false",
    outside: "true",
  });
  scheduledData.targets[0].then.push(
    setAction({ cId: 18, hc: "TargetMode", value: "home" }),
  );
  hub.state.accessories[1].services[0].characteristics.find(
    ({ cId }) => cId === 18,
  ).control.value = { stringValue: null };

  const preparedCreate = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Ночной режим с явными командами",
      description: "Показать будущие записи до применения",
      active: true,
      on_start: false,
      sync: false,
      data: scheduledData,
      reason: "Отличить сохранение настройки от повторной записи",
    },
  });
  assert.equal(
    preparedCreate.isError,
    undefined,
    preparedCreate.content[0]?.text,
  );
  assert.equal(preparedCreate.structuredContent.native_write_sent, false);
  assert.match(
    preparedCreate.structuredContent.block_action_preview.snapshot.captured_at,
    /^\d{4}-\d{2}-\d{2}T/,
  );
  assert.deepEqual(
    preparedCreate.structuredContent.block_action_preview.snapshot,
    {
      source: "accessory_read_during_preparation",
      captured_at:
        preparedCreate.structuredContent.block_action_preview.snapshot
          .captured_at,
      fresh: true,
    },
  );
  assert.deepEqual(
    preparedCreate.structuredContent.block_action_preview.actions,
    [
      {
        configuration_pointer: "/targets/0/then/0/characteristics/0",
        characteristic_ref: characteristicRef,
        service_type: "Lightbulb",
        characteristic_type: "On",
        command: {
          kind: "boolValue",
          value: false,
          execution: "write_if_action_runs",
        },
        observation: {
          status: "available",
          kind: "boolValue",
          value: false,
        },
        comparison_to_observation: "equal",
        branch: {
          when: "condition_true",
          condition_pointer: "/targets/0/if",
          coverage: { status: "undisclosed", reason: "inapplicable_form" },
        },
      },
      {
        configuration_pointer: "/targets/0/then/1/characteristics/0",
        characteristic_ref: `${serviceRef}/characteristic/18`,
        service_type: "Lightbulb",
        characteristic_type: "TargetMode",
        command: {
          kind: "stringValue",
          value: "home",
          execution: "write_if_action_runs",
        },
        observation: { status: "unavailable" },
        comparison_to_observation: "unknown",
        branch: {
          when: "condition_true",
          condition_pointer: "/targets/0/if",
          coverage: { status: "undisclosed", reason: "inapplicable_form" },
        },
      },
      {
        configuration_pointer: "/targets/0/else/0/characteristics/0",
        characteristic_ref: characteristicRef,
        service_type: "Lightbulb",
        characteristic_type: "On",
        command: {
          kind: "boolValue",
          value: true,
          execution: "write_if_action_runs",
        },
        observation: {
          status: "available",
          kind: "boolValue",
          value: false,
        },
        comparison_to_observation: "different",
        branch: {
          when: "condition_false",
          condition_pointer: "/targets/0/if",
          coverage: { status: "undisclosed", reason: "inapplicable_form" },
        },
      },
    ],
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );

  const capturedPreview = structuredClone(
    preparedCreate.structuredContent.block_action_preview,
  );
  hub.state.characteristic.control.value.boolValue = true;
  hub.state.accessories[1].services[0].characteristics.find(
    ({ cId }) => cId === 18,
  ).control.value = { stringValue: "away" };
  const accessoryReadsBeforeRestart = hub.requests.filter(
    ({ accessory }) => accessory?.get,
  ).length;
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const persisted = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: preparedCreate.structuredContent.change_ref },
  });
  assert.deepEqual(persisted.structuredContent.block_action_preview, {
    ...capturedPreview,
    snapshot: { ...capturedPreview.snapshot, fresh: false },
  });
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.get).length,
    accessoryReadsBeforeRestart,
    "reading history must not refresh the saved preparation observation",
  );

  const updatedData = blockData({ delay: 90_000 });
  const preparedUpdate = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: updatedData,
      reason: "Показать команды существующего BLOCK",
    },
  });
  assert.equal(
    preparedUpdate.isError,
    undefined,
    preparedUpdate.content[0]?.text,
  );
  assert.deepEqual(
    preparedUpdate.structuredContent.block_action_preview.actions.map(
      ({ configuration_pointer, command, comparison_to_observation }) => ({
        configuration_pointer,
        command,
        comparison_to_observation,
      }),
    ),
    [
      {
        configuration_pointer: "/targets/0/then/0/characteristics/0",
        command: {
          kind: "boolValue",
          value: true,
          execution: "write_if_action_runs",
        },
        comparison_to_observation: "equal",
      },
      {
        configuration_pointer: "/targets/0/then/1/targets/0/characteristics/0",
        command: {
          kind: "boolValue",
          value: false,
          execution: "write_if_action_runs",
        },
        comparison_to_observation: "different",
      },
    ],
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.update),
    false,
    "preparing the update must not write BLOCK data",
  );
});

test("prepared BLOCK observations preserve offline availability beside cached false and zero values", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const accessory = hub.state.accessories.find(({ id }) => id === 34);
  accessory.online = false;
  accessory.services[0].characteristics.find(
    ({ cId }) => cId === 16,
  ).control.value = { intValue: 0 };
  const data = dailyIntervalBlockData({ inside: "false", outside: "true" });
  data.targets[0].then.push(
    setAction({ cId: 16, hc: "Brightness", value: "0" }),
  );
  const firstClient = await startClient(t, hub, stateDirectory);

  const direct = await firstClient.callTool({
    name: "get_entity",
    arguments: { entity_ref: characteristicRef },
  });
  assert.equal(direct.isError, undefined, direct.content[0]?.text);
  assert.equal(direct.structuredContent.entity.available, false);
  assert.equal(direct.structuredContent.entity.current_value.value, false);

  const preparedOffline = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Offline preview",
      description: "Сохранить доступность вместе с cached значениями",
      active: true,
      on_start: false,
      sync: false,
      data,
      reason: "Не выдавать cached значения за текущее состояние",
    },
  });
  assert.equal(
    preparedOffline.isError,
    undefined,
    preparedOffline.content[0]?.text,
  );
  const offlineObservations =
    preparedOffline.structuredContent.block_action_preview.actions
      .filter(({ characteristic_type }) =>
        ["On", "Brightness"].includes(characteristic_type),
      )
      .map(({ observation, comparison_to_observation }) => ({
        observation,
        comparison_to_observation,
      }));
  assert.deepEqual(offlineObservations, [
    {
      observation: { status: "unavailable", kind: "boolValue", value: false },
      comparison_to_observation: "unknown",
    },
    {
      observation: { status: "unavailable", kind: "intValue", value: 0 },
      comparison_to_observation: "unknown",
    },
    {
      observation: { status: "unavailable", kind: "boolValue", value: false },
      comparison_to_observation: "unknown",
    },
  ]);

  const capturedOffline = structuredClone(
    preparedOffline.structuredContent.block_action_preview,
  );
  const accessoryReadsBeforeRestart = hub.requests.filter(
    ({ accessory: request }) => request?.get,
  ).length;
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const persisted = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: preparedOffline.structuredContent.change_ref },
  });
  assert.deepEqual(persisted.structuredContent.block_action_preview, {
    ...capturedOffline,
    snapshot: { ...capturedOffline.snapshot, fresh: false },
  });
  assert.equal(
    hub.requests.filter(({ accessory: request }) => request?.get).length,
    accessoryReadsBeforeRestart,
    "reading after restart must preserve rather than refresh source availability",
  );

  accessory.online = true;
  const preparedOnline = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Online preview",
      description: "Сравнить те же false и zero у доступного источника",
      active: true,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить контраст доступности без потери значений",
    },
  });
  assert.equal(
    preparedOnline.isError,
    undefined,
    preparedOnline.content[0]?.text,
  );
  assert.deepEqual(
    preparedOnline.structuredContent.block_action_preview.actions
      .filter(({ characteristic_type }) =>
        ["On", "Brightness"].includes(characteristic_type),
      )
      .map(({ observation, comparison_to_observation }) => ({
        observation,
        comparison_to_observation,
      })),
    [
      {
        observation: { status: "available", kind: "boolValue", value: false },
        comparison_to_observation: "equal",
      },
      {
        observation: { status: "available", kind: "intValue", value: 0 },
        comparison_to_observation: "equal",
      },
      {
        observation: { status: "available", kind: "boolValue", value: false },
        comparison_to_observation: "different",
      },
    ],
  );
});

test("prepared BLOCK preview names extra enum values covered by else", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installWorkModeAccessory(hub);
  const firstClient = await startClient(t, hub, stateDirectory);
  const dayElseData = rootIfBlockData({
    when: conditionGroup(workModeEquals(0)),
    elseValue: "false",
  });
  const getsBeforeDayElse = accessoryGetIds(hub).length;

  const dayElse = await prepareBlockCreate(firstClient, {
    name: "Днём включить, иначе выключить",
    data: dayElseData,
    reason: "Показать, что else покрывает не только ночь",
  });
  const dayOn = previewAction(
    dayElse,
    "/targets/0/then/0/characteristics/0",
    true,
  );
  const extraOff = previewAction(
    dayElse,
    "/targets/0/else/0/characteristics/0",
    false,
  );
  assert.deepEqual(dayOn.branch, {
    when: "condition_true",
    condition_pointer: "/targets/0/if",
    coverage: {
      status: "known_enum",
      source_ref: workModeRef,
      comparison: "=",
      compared: workModeDay,
      values: [workModeDay],
    },
  });
  assert.deepEqual(extraOff.branch, {
    when: "condition_false",
    condition_pointer: "/targets/0/if",
    coverage: {
      status: "known_enum",
      source_ref: workModeRef,
      comparison: "=",
      compared: workModeDay,
      values: [workModeEvening, workModeNight, workModeOff],
    },
  });
  assert.deepEqual(
    extraOff.branch.coverage.values.map(({ value }) => value).sort(),
    [1, 2, 3],
  );
  assert.equal(
    extraOff.branch.coverage.values.some(
      (item) => item.key === "EVENING" && item.name === "Вечер",
    ),
    true,
    "else OFF must name the extra known mode that a day/night pair never asked to command",
  );
  assert.equal(
    dayElse.structuredContent.diff.configuration.to.data.targets[0].else[0]
      .characteristics[0].value,
    "false",
  );
  const dayElseGets = accessoryGetIds(hub).slice(getsBeforeDayElse);
  assert.deepEqual(
    [...new Set(dayElseGets)].sort((left, right) => left - right),
    [34, 50],
  );
  assert.equal(
    dayElseGets.length,
    new Set(dayElseGets).size,
    "preview must reuse the validation accessory reads instead of fetching the enum again",
  );

  const orLeaf = await prepareBlockCreate(firstClient, {
    name: "Тот же день через OR из одного листа",
    data: rootIfBlockData({
      when: conditionGroup(workModeEquals(0), "OR"),
      elseValue: "false",
    }),
    reason: "Нормализованный одиночный OR совпадает с AND",
  });
  assert.deepEqual(
    previewAction(orLeaf, "/targets/0/else/0/characteristics/0", false).branch,
    extraOff.branch,
  );

  const directLeaf = await prepareBlockCreate(firstClient, {
    name: "Тот же день прямой characteristic",
    data: rootIfBlockData({
      when: workModeEquals(0),
      elseValue: "false",
    }),
    reason: "Обёртка одиночного листа не меняет покрытие",
  });
  assert.deepEqual(
    previewAction(directLeaf, "/targets/0/else/0/characteristics/0", false)
      .branch,
    extraOff.branch,
  );
  assert.equal(
    directLeaf.structuredContent.diff.configuration.to.data.targets[0].if.mode,
    "AND",
  );

  const explicitBranches = await prepareBlockCreate(firstClient, {
    name: "Отдельные ветви дня и ночи",
    data: {
      targets: [
        everyIf({
          when: conditionGroup(workModeEquals(0)),
          thenActions: [setAction({ value: "true" })],
        }),
        everyIf({
          when: conditionGroup(workModeEquals(2, false)),
          thenActions: [setAction({ value: "false" })],
        }),
      ],
    },
    reason: "Не приписывать командам остальные режимы",
  });
  const explicitOn = previewAction(
    explicitBranches,
    "/targets/0/then/0/characteristics/0",
    true,
  );
  const explicitOff = previewAction(
    explicitBranches,
    "/targets/1/then/0/characteristics/0",
    false,
  );
  assert.deepEqual(explicitOn.branch.coverage.values, [workModeDay]);
  assert.deepEqual(explicitOff.branch.coverage.values, [workModeNight]);
  assert.equal(
    explicitBranches.structuredContent.block_action_preview.actions.some(
      (action) =>
        action.branch.coverage.values?.some((item) =>
          [1, 3].includes(item.value),
        ),
    ),
    false,
    "separate day and night branches must not attach commands to evening or off",
  );

  const remaining = await prepareBlockCreate(firstClient, {
    name: "Ночью выключить, в остальных включить",
    data: rootIfBlockData({
      when: conditionGroup(workModeEquals(2)),
      thenValue: "false",
      elseValue: "true",
    }),
    reason: "Явный else по остальным остаётся возможным",
  });
  assert.deepEqual(
    previewAction(remaining, "/targets/0/then/0/characteristics/0", false)
      .branch.coverage.values,
    [workModeNight],
  );
  assert.deepEqual(
    previewAction(remaining, "/targets/0/else/0/characteristics/0", true).branch
      .coverage.values,
    [workModeDay, workModeEvening, workModeOff],
  );

  const modeElse = await prepareBlockCreate(firstClient, {
    name: "Строковый режим лампы",
    data: rootIfBlockData({
      when: conditionGroup({
        type: "characteristic",
        aId: 34,
        sId: 13,
        cId: 18,
        hs: "Lightbulb",
        hc: "TargetMode",
        trigger: true,
        cond: "=",
        value: "home",
        timeCond: "",
        time: 0,
      }),
      elseValue: "false",
    }),
    reason: "Покрытие берётся у прочитанного enum, не у домашней сигнализации",
  });
  const modeOff = previewAction(
    modeElse,
    "/targets/0/else/0/characteristics/0",
    false,
  );
  assert.deepEqual(modeOff.branch.coverage, {
    status: "known_enum",
    source_ref: `${homeRef}/accessory/34/service/13/characteristic/18`,
    comparison: "=",
    compared: {
      kind: "stringValue",
      value: "home",
      key: "home",
      name: "Дома",
    },
    values: [
      { kind: "stringValue", value: "away", key: "away", name: "Вне дома" },
    ],
  });
  assert.equal(
    modeOff.branch.coverage.values.some((item) =>
      [0, 1, 2, 3].includes(item.value),
    ),
    false,
  );

  const capturedPreview = structuredClone(
    dayElse.structuredContent.block_action_preview,
  );
  hub.state.accessories.find(
    ({ id }) => id === 50,
  ).services[0].characteristics[0].control.validValues = [
    { key: "DAY", name: "День", value: { intValue: 0 } },
    { key: "NIGHT", name: "Ночь", value: { intValue: 2 } },
  ];
  const getsBeforeRestart = accessoryGetIds(hub).length;
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const persisted = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: dayElse.structuredContent.change_ref },
  });
  assert.deepEqual(persisted.structuredContent.block_action_preview, {
    ...capturedPreview,
    snapshot: { ...capturedPreview.snapshot, fresh: false },
  });
  assert.deepEqual(
    previewAction(persisted, "/targets/0/else/0/characteristics/0", false)
      .branch.coverage.values,
    [workModeEvening, workModeNight, workModeOff],
  );
  assert.equal(accessoryGetIds(hub).length, getsBeforeRestart);
});

test("prepared BLOCK preview leaves unknown and nested condition domains undisclosed", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installWorkModeAccessory(hub);
  const client = await startClient(t, hub, stateDirectory);

  const unknown = await prepareBlockCreate(client, {
    name: "Булево условие без enum",
    data: rootIfBlockData({
      when: conditionGroup(characteristicCondition()),
      elseValue: "false",
    }),
    reason: "Отсутствующий домен не выдавать за пустой",
  });
  const unknownOff = previewAction(
    unknown,
    "/targets/0/else/0/characteristics/0",
    false,
  );
  assert.deepEqual(unknownOff.branch, {
    when: "condition_false",
    condition_pointer: "/targets/0/if",
    coverage: { status: "undisclosed", reason: "unknown_domain" },
  });
  assert.equal("values" in unknownOff.branch.coverage, false);

  const compound = await prepareBlockCreate(client, {
    name: "Составное условие дня и движения",
    data: rootIfBlockData({
      when: {
        type: "condition",
        mode: "AND",
        conditions: [
          workModeEquals(0),
          characteristicCondition({ trigger: false }),
        ],
      },
      elseValue: "false",
    }),
    reason: "Не угадывать дополнение составного условия",
  });
  const compoundOff = previewAction(
    compound,
    "/targets/0/else/0/characteristics/0",
    false,
  );
  assert.deepEqual(compoundOff.branch.coverage, {
    status: "undisclosed",
    reason: "compound_condition",
  });
  assert.equal("values" in compoundOff.branch.coverage, false);
  assert.equal(
    compound.structuredContent.diff.configuration.to.data.targets[0].if
      .conditions.length,
    2,
  );

  const nested = await prepareBlockCreate(client, {
    name: "Вложенное условие движения днём",
    data: {
      targets: [
        everyIf({
          when: conditionGroup(workModeEquals(0)),
          thenActions: [
            everyIf({
              when: conditionGroup(characteristicCondition({ trigger: false })),
              thenActions: [setAction({ value: "true" })],
            }),
          ],
        }),
      ],
    },
    reason: "Не игнорировать родительское ограничение",
  });
  const nestedOn = previewAction(
    nested,
    "/targets/0/then/0/then/0/characteristics/0",
    true,
  );
  assert.deepEqual(nestedOn.branch, {
    when: "condition_true",
    condition_pointer: "/targets/0/then/0/if",
    parent_condition_pointers: ["/targets/0/if"],
    coverage: { status: "undisclosed", reason: "nested_condition" },
  });
  assert.equal("values" in nestedOn.branch.coverage, false);

  const scheduled = await prepareBlockCreate(client, {
    name: "Интервал без enum",
    data: dailyIntervalBlockData({ inside: "true", outside: "false" }),
    reason: "Не раскрывать расписание как enum",
  });
  assert.deepEqual(
    previewAction(scheduled, "/targets/0/else/0/characteristics/0", false)
      .branch.coverage,
    { status: "undisclosed", reason: "inapplicable_form" },
  );
});

test("daily interval contract lets a client repair cron before preparation", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);

  const contract = await firstClient.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "block_create" },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.equal(contract.structuredContent.contract.version, "2026-09-24");
  assert.deepEqual(
    contract.structuredContent.contract.supported.daily_interval,
    {
      local_time: "HH:mm",
      start_and_end: "distinct",
      crosses_midnight: true,
      native_trigger: true,
      cron: {
        format: "0 MM HH ? * * *",
        fields: {
          MM: "minute_0_to_59",
          HH: "hour_0_to_23",
        },
        seconds: 0,
        mode: "NONE",
        offset: 0,
      },
      native_shape: {
        type: "interval",
        start: {
          type: "cron",
          mode: "NONE",
          cron: "0 MM HH ? * * *",
          offset: 0,
        },
        end: {
          type: "cron",
          mode: "NONE",
          cron: "0 MM HH ? * * *",
          offset: 0,
        },
        trigger: true,
      },
      boundaries: {
        start: "enter_interval",
        end: "leave_interval",
        clock: "selected_hub_local_wall_clock",
      },
      branch_semantics: {
        sole_interval_condition: "start_then_end_else",
        compound_condition:
          "boundary_rechecks_complete_condition_tree_then_selects_result_branch",
      },
    },
  );

  const initiallyInvalid = dailyIntervalBlockData();
  initiallyInvalid.targets[0].if.conditions[0].start.cron = "0 30 22 * * *";
  const rejected = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Исправляемая форма interval",
      description: "Проверить исправление формы cron по публичному контракту",
      active: true,
      on_start: false,
      sync: false,
      data: initiallyInvalid,
      reason: "Исправить неподдержанную форму до записи",
    },
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, "invalid_block_data");
  assert.equal(
    rejected.structuredContent.error.action,
    "get_native_change_contract",
  );
  assert.match(rejected.structuredContent.error.message, /0 MM HH \? \* \* \*/);

  initiallyInvalid.targets[0].if.conditions[0].start.cron =
    contract.structuredContent.contract.supported.daily_interval.native_shape.start.cron
      .replace("MM", "30")
      .replace("HH", "22");
  const corrected = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Исправляемая форма interval",
      description: "Проверить исправление формы cron по публичному контракту",
      active: true,
      on_start: false,
      sync: false,
      data: initiallyInvalid,
      reason: "Подготовить поддержанную форму после исправления",
    },
  });
  assert.equal(corrected.isError, undefined, corrected.content[0]?.text);
  assert.equal(corrected.structuredContent.status, "prepared");
  assert.equal(corrected.structuredContent.native_write_sent, false);
});

test("a client can assemble a supported BLOCK from the public contract without a sample scenario", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.scenarios = [];
  const client = await startClient(t, hub, stateDirectory);
  const brightnessRef = `${homeRef}/accessory/34/service/13/characteristic/16`;
  const modeRef = `${homeRef}/accessory/34/service/13/characteristic/18`;
  const motionServiceRef = `${homeRef}/accessory/32/service/13`;

  const contractResult = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "block_create" },
  });
  assert.equal(
    contractResult.isError,
    undefined,
    contractResult.content[0]?.text,
  );
  const contract = contractResult.structuredContent.contract;

  const entityRefs = [
    motionServiceRef,
    serviceRef,
    motionCharacteristicRef,
    characteristicRef,
  ];
  const [motionService, lampService, motion, lampOn] = await Promise.all(
    entityRefs.map((entity_ref) =>
      client.callTool({ name: "get_entity", arguments: { entity_ref } }),
    ),
  );
  for (const result of [motionService, lampService, motion, lampOn]) {
    assert.equal(result.isError, undefined, result.content[0]?.text);
  }
  assert.equal(
    contract.supported.characteristic_conditions.boolean.includes("="),
    true,
  );

  const autoOffAfterSeconds = 120;
  nativeDelayTimeFromContract(contract, { seconds: autoOffAfterSeconds });
  const data = assembleSupportedBlockFromContract(contract, {
    targets: [
      assembleIfFromContract(contract, {
        when: assembleConditionFromContract(contract, [
          assembleIntervalFromContract(contract, {
            start: "22:30",
            end: "06:15",
            trigger: true,
          }),
          assembleCharacteristicFromContract(contract, {
            ref: motionCharacteristicRef,
            service: motionService,
            characteristic: motion,
            trigger: false,
            cond: "=",
            value: true,
          }),
        ]),
        thenActions: [
          assembleServiceSetFromContract(contract, {
            ref: characteristicRef,
            service: lampService,
            characteristic: lampOn,
            value: true,
          }),
        ],
        elseActions: [
          assembleDelayFromContract(contract, {
            afterSeconds: autoOffAfterSeconds,
            targets: [
              assembleServiceSetFromContract(contract, {
                ref: characteristicRef,
                service: lampService,
                characteristic: lampOn,
                value: false,
              }),
            ],
          }),
        ],
      }),
    ],
  });

  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Ночной свет по движению",
      description:
        "Включать лампу ночью при движении и выключать вне этого условия, не трогая яркость",
      active: true,
      on_start: false,
      sync: false,
      data,
      reason: "Собрать поддержанный BLOCK по публичному контракту",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.equal(prepared.structuredContent.native_write_sent, false);
  assert.deepEqual(
    preparedDelayTimes(prepared.structuredContent.diff.configuration.to.data),
    [120_000],
  );

  const actions = prepared.structuredContent.block_action_preview.actions;
  assert.equal(actions.length, 2);
  const nightOn = actions.find(({ command }) => command.value === true);
  const delayedOff = actions.find(({ command }) => command.value === false);
  assert.deepEqual(
    {
      ref: nightOn.characteristic_ref,
      type: nightOn.characteristic_type,
      service: nightOn.service_type,
      kind: nightOn.command.kind,
      value: nightOn.command.value,
    },
    {
      ref: characteristicRef,
      type: lampOn.structuredContent.entity.type,
      service: lampService.structuredContent.entity.type,
      kind: "boolValue",
      value: true,
    },
  );
  assert.match(nightOn.configuration_pointer, /\/then\//);
  assert.equal(/\/else\//.test(nightOn.configuration_pointer), false);
  assert.deepEqual(
    {
      ref: delayedOff.characteristic_ref,
      type: delayedOff.characteristic_type,
      value: delayedOff.command.value,
    },
    {
      ref: characteristicRef,
      type: lampOn.structuredContent.entity.type,
      value: false,
    },
  );
  assert.match(delayedOff.configuration_pointer, /\/else\//);
  assert.match(delayedOff.configuration_pointer, /\/targets\//);
  assert.equal(
    actions.some(({ characteristic_ref: ref }) =>
      [brightnessRef, modeRef].includes(ref),
    ),
    false,
    "neighboring Brightness and TargetMode must stay unwritten",
  );

  const guessed = structuredClone(data);
  guessed.targets[0].conditions = guessed.targets[0].if.conditions;
  delete guessed.targets[0].if;
  const rejected = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Угаданная форма if",
      description: "condition/conditions вместо опубликованного if",
      active: true,
      on_start: false,
      sync: false,
      data: guessed,
      reason: "Не отправлять неподдержанную native форму",
    },
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, "invalid_block_data");
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );

  const liveDerived = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Уже проверенная interval-форма",
      description: "Существующая live-derived форма остаётся допустимой",
      active: true,
      on_start: false,
      sync: false,
      data: dailyIntervalBlockData(),
      reason: "Не отвергать ранее принятую native форму",
    },
  });
  assert.equal(liveDerived.isError, undefined, liveDerived.content[0]?.text);
  assert.equal(liveDerived.structuredContent.status, "prepared");
});

test("daily interval BLOCK completes create, find, update, readback, and restore without device writes", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const overnightData = dailyIntervalBlockData();

  const preparedCreate = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Ночной режим света",
      description:
        "Снижать освещение ночью и возвращать дневное значение утром",
      active: true,
      on_start: false,
      sync: false,
      data: overnightData,
      reason: "Настроить ежедневный ночной режим",
    },
  });
  assert.equal(
    preparedCreate.isError,
    undefined,
    preparedCreate.content[0]?.text,
  );
  assert.equal(preparedCreate.structuredContent.status, "prepared");
  assert.deepEqual(
    preparedCreate.structuredContent.diff.configuration.to.data,
    overnightData,
  );

  const created = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: preparedCreate.structuredContent.change_ref },
  });
  assert.equal(created.isError, undefined, created.content[0]?.text);
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(created.structuredContent.configuration_matches, true);
  assert.deepEqual(
    JSON.parse(
      hub.state.scenarios.find(
        ({ index }) => index === created.structuredContent.scenario_index,
      ).data,
    ),
    withRuntimeBlockFields(overnightData),
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const found = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: characteristicRef },
  });
  assert.equal(found.isError, undefined, found.content[0]?.text);
  assert.equal(found.structuredContent.changes.length, 1);
  assert.equal(
    found.structuredContent.changes[0].change_ref,
    preparedCreate.structuredContent.change_ref,
  );
  assert.equal(
    found.structuredContent.changes[0].target_refs.includes(
      created.structuredContent.scenario_ref,
    ),
    true,
  );

  const observed = await secondClient.callTool({
    name: found.structuredContent.changes[0].next.tool,
    arguments: found.structuredContent.changes[0].next.arguments,
  });
  assert.equal(observed.structuredContent.status, "applied");
  assert.equal(observed.structuredContent.configuration_matches, true);
  const unrelatedSourceHistory = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: motionCharacteristicRef },
  });
  assert.deepEqual(unrelatedSourceHistory.structuredContent.changes, []);

  const unsafePause = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: created.structuredContent.scenario_ref,
      action_pointer: "/targets/0",
      duration_seconds: 60,
      reason: "Не прятать регистрацию временного триггера в паузу",
    },
  });
  assert.equal(unsafePause.isError, true);
  assert.equal(
    unsafePause.structuredContent.error.code,
    "unsupported_pause_trigger_scope",
  );

  const daytimeData = dailyIntervalBlockData({
    start: [6, 15],
    end: [22, 30],
    inside: "false",
    outside: "true",
  });
  const preparedUpdate = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: created.structuredContent.scenario_ref,
      data: daytimeData,
      reason: "Изменить границы и явные значения режима",
    },
  });
  assert.equal(
    preparedUpdate.isError,
    undefined,
    preparedUpdate.content[0]?.text,
  );
  const updated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: preparedUpdate.structuredContent.change_ref },
  });
  assert.equal(updated.structuredContent.status, "applied");
  assert.equal(updated.structuredContent.configuration_matches, true);

  const appliedDaytimeData = hub.state.scenarios.find(
    ({ index }) => index === created.structuredContent.scenario_index,
  ).data;
  const manualEdit = JSON.parse(appliedDaytimeData);
  manualEdit.targets[0].if.conditions[0].end.cron = "0 45 22 ? * * *";
  hub.state.scenarios.find(
    ({ index }) => index === created.structuredContent.scenario_index,
  ).data = JSON.stringify(manualEdit);
  const protectedManualEdit = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: preparedUpdate.structuredContent.change_ref },
  });
  assert.equal(protectedManualEdit.structuredContent.status, "conflict");
  assert.equal(
    protectedManualEdit.structuredContent.conflict_reason,
    "manual_change",
  );
  hub.state.scenarios.find(
    ({ index }) => index === created.structuredContent.scenario_index,
  ).data = appliedDaytimeData;

  const restoredUpdate = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: preparedUpdate.structuredContent.change_ref },
  });
  assert.equal(restoredUpdate.structuredContent.status, "restored");
  assert.deepEqual(
    JSON.parse(
      hub.state.scenarios.find(
        ({ index }) => index === created.structuredContent.scenario_index,
      ).data,
    ),
    withRuntimeBlockFields(overnightData),
  );

  const removed = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: preparedCreate.structuredContent.change_ref },
  });
  assert.equal(removed.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(
      ({ index }) => index === created.structuredContent.scenario_index,
    ),
    false,
  );
  assert.equal(
    hub.requests.some(({ characteristic }) => characteristic?.update),
    false,
    "removing the schedule must not write a prior physical value",
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
    "the next dialog must update the found owned scenario, not create a duplicate",
  );
});

test("daily interval BLOCK rejects ambiguous or unsupported schedules before send", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const cases = [
    {
      name: "equal edges",
      mutate: (data) => {
        data.targets[0].if.conditions[0].end = dailyCron(22, 30);
      },
    },
    {
      name: "non-daily calendar",
      mutate: (data) => {
        data.targets[0].if.conditions[0].start.cron = "0 30 22 ? * MON *";
      },
    },
    {
      name: "sunset mode",
      mutate: (data) => {
        data.targets[0].if.conditions[0].start.mode = "SUNSET";
      },
    },
    {
      name: "offset",
      mutate: (data) => {
        data.targets[0].if.conditions[0].start.offset = 15;
      },
    },
    {
      name: "not a trigger",
      mutate: (data) => {
        data.targets[0].if.conditions[0].trigger = false;
      },
    },
    {
      name: "second interval",
      mutate: (data) => {
        data.targets[0].if.conditions.push({
          type: "interval",
          start: dailyCron(8, 0),
          end: dailyCron(9, 0),
          trigger: false,
        });
      },
    },
  ];

  for (const testCase of cases) {
    const data = dailyIntervalBlockData();
    testCase.mutate(data);
    const result = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_create",
        target_ref: homeRef,
        name: testCase.name,
        description: "Не сохранять неподдержанную форму расписания",
        active: true,
        on_start: false,
        sync: false,
        data,
        reason: "Проверить границу daily interval",
      },
    });
    assert.equal(result.isError, true, testCase.name);
    assert.equal(
      result.structuredContent.error.code,
      "invalid_block_data",
      testCase.name,
    );
  }
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );
});

test("weekday, one-date and sunset time triggers are created, read back and removed without device writes", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const contract = (
    await client.callTool({
      name: "get_native_change_contract",
      arguments: { operation: "block_create" },
    })
  ).structuredContent.contract;

  // «По будням в 7:00», «25 сентября 2026 в 9:00», «через 30 минут после заката».
  const weekdays = assembleTimeTriggerFromContract(contract, "days_at_time", {
    MM: 0,
    HH: 7,
    DAYS: "MON,TUE,WED,THU,FRI",
  });
  const oneDate = assembleTimeTriggerFromContract(contract, "one_date", {
    MM: 0,
    HH: 9,
    D: 25,
    M: 9,
    YYYY: 2026,
  });
  const afterSunset = assembleTimeTriggerFromContract(contract, "sun", {
    mode: "SUNSET",
    DAYS: "*",
    offsetMinutes: 30,
  });
  assert.deepEqual(
    [weekdays, oneDate, afterSunset],
    [
      {
        type: "cron",
        mode: "NONE",
        cron: "0 0 7 ? * MON,TUE,WED,THU,FRI *",
        offset: 0,
      },
      { type: "cron", mode: "NONE", cron: "0 0 9 25 9 ? 2026", offset: 0 },
      { type: "cron", mode: "SUNSET", cron: "0 0 0 ? * * *", offset: 30 },
    ],
  );
  const data = {
    targets: [
      everyIf({ when: conditionGroup(weekdays), thenActions: [setAction()] }),
      everyIf({
        when: conditionGroup(oneDate),
        thenActions: [setAction({ cId: 16, hc: "Brightness", value: "80" })],
      }),
      everyIf({
        when: conditionGroup(afterSunset),
        thenActions: [setAction({ cId: 18, hc: "TargetMode", value: "home" })],
      }),
    ],
  };

  const prepared = await prepareBlockCreate(client, {
    name: "Свет по расписанию",
    data,
    reason: "По будням в 7:00, завтра в 9:00 и после заката",
  });
  assert.deepEqual(prepared.structuredContent.diff.configuration.to.data, data);
  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.isError, undefined, created.content[0]?.text);
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(created.structuredContent.configuration_matches, true);
  const createdIndex = created.structuredContent.scenario_index;
  assert.deepEqual(
    scenarioData(hub, createdIndex),
    withRuntimeBlockFields(data),
  );

  const removed = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(removed.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === createdIndex),
    false,
  );
  assert.equal(
    hub.requests.some(({ characteristic }) => characteristic?.update),
    false,
  );
});

test("an existing BLOCK with a sunrise trigger is updated, read back and restored", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const manual = {
    targets: [
      everyIf({
        when: conditionGroup({
          type: "cron",
          mode: "SUNRISE",
          cron: "0 0 0 ? * * *",
          offset: -10,
        }),
        thenActions: [setAction({ value: "false" })],
      }),
    ],
  };
  hub.state.scenarios[0].data = JSON.stringify(withRuntimeBlockFields(manual));

  const read = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: scenarioRef, include: ["configuration"] },
  });
  assert.equal(read.isError, undefined, read.content[0]?.text);
  const edited = structuredClone(
    read.structuredContent.entity.configuration.value,
  );
  edited.targets[0].if.conditions[0].cron = "0 0 0 ? * SAT,SUN *";
  edited.targets[0].if.conditions[0].offset = 20;
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: edited,
      reason: "По выходным выключать свет через 20 минут после восхода",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.configuration_matches, true);
  const stored = scenarioData(hub, "existing-block");
  assert.deepEqual(stored.targets[0].if.conditions[0], {
    type: "cron",
    blockId: 3,
    mode: "SUNRISE",
    cron: "0 0 0 ? * SAT,SUN *",
    offset: 20,
  });

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(
    scenarioData(hub, "existing-block"),
    withRuntimeBlockFields(manual),
  );
  assert.equal(
    hub.requests.some(({ characteristic }) => characteristic?.update),
    false,
  );
});

test("time triggers outside the published forms are refused with a repairable reason before send", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const cases = [
    ["numeric days", { mode: "NONE", cron: "0 0 7 ? * 2-6 *", offset: 0 }],
    ["day range", { mode: "NONE", cron: "0 0 7 ? * MON-FRI *", offset: 0 }],
    ["repeated day", { mode: "NONE", cron: "0 0 7 ? * MON,MON *", offset: 0 }],
    ["no such date", { mode: "NONE", cron: "0 0 9 30 2 ? 2027", offset: 0 }],
    ["date without year", { mode: "NONE", cron: "0 0 9 25 9 ? *", offset: 0 }],
    ["clock time offset", { mode: "NONE", cron: "0 0 7 ? * * *", offset: 15 }],
    [
      "sunset clock time",
      { mode: "SUNSET", cron: "0 30 18 ? * * *", offset: 0 },
    ],
    [
      "sunset far offset",
      { mode: "SUNSET", cron: "0 0 0 ? * * *", offset: 721 },
    ],
    ["unknown mode", { mode: "NOON", cron: "0 0 12 ? * * *", offset: 0 }],
  ];
  const results = [];
  for (const [name, trigger] of cases) {
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_create",
        target_ref: homeRef,
        name,
        description: "Не сохранять неподдержанное расписание",
        active: true,
        on_start: false,
        sync: false,
        data: {
          targets: [
            everyIf({
              when: conditionGroup({ type: "cron", ...trigger }),
              thenActions: [setAction()],
            }),
          ],
        },
        reason: "Проверить границу временного trigger",
      },
    });
    results.push({
      name,
      code: prepared.structuredContent?.error?.code,
      repairable: /time trigger/.test(
        prepared.structuredContent?.error?.message ?? "",
      ),
    });
  }
  assert.deepEqual(
    results,
    cases.map(([name]) => ({
      name,
      code: "invalid_block_data",
      repairable: true,
    })),
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );
});

function installButton(hub) {
  installEnumAccessory(hub, {
    id: 60,
    name: "Кнопка",
    hs: "StatelessProgrammableSwitch",
    hc: "ProgrammableSwitchEvent",
    values: [
      { key: "SINGLE", name: "Одно нажатие", value: 0 },
      { key: "DOUBLE", name: "Двойное нажатие", value: 1 },
      { key: "LONG", name: "Долгое нажатие", value: 2 },
    ],
  });
  hub.state.accessories.find(
    ({ id }) => id === 60,
  ).services[0].characteristics[0].control.write = false;
}

function buttonPress(value) {
  return enumEquals({
    aId: 60,
    hs: "StatelessProgrammableSwitch",
    hc: "ProgrammableSwitchEvent",
    value,
  });
}

function lampAction(action) {
  return {
    type: "service",
    aId: 34,
    sId: 13,
    hs: "Lightbulb",
    characteristics: [action],
  };
}

function installAllOffScenario(hub) {
  hub.state.scenarios.push({
    index: "all-off",
    name: "Всё выключить",
    desc: "",
    active: true,
    onStart: false,
    sync: false,
    type: "BLOCK",
    data: JSON.stringify({ targets: [setAction({ value: "false" })] }),
  });
}

test("a button toggles and steps a lamp and another trigger runs a scenario; created, updated and restored", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installButton(hub);
  installAllOffScenario(hub);
  const client = await startClient(t, hub, stateDirectory);
  const contract = (
    await client.callTool({
      name: "get_native_change_contract",
      arguments: { operation: "block_create" },
    })
  ).structuredContent.contract;
  const serviceChildren = publishedChild(
    publishedBlockNode(contract, "service"),
    "characteristics",
    "array",
  ).types;
  assert.deepEqual(
    ["set", "toggle", "inc", "dec"].filter((type) =>
      serviceChildren.includes(type),
    ),
    ["set", "toggle", "inc", "dec"],
  );
  assert.equal(
    publishedChild(
      publishedBlockNode(contract, "root"),
      "targets",
      "array",
    ).types.includes("scenario"),
    true,
  );
  assert.deepEqual(publishedBlockNode(contract, "scenario").constants, {
    mode: "FIRE",
  });

  const data = {
    targets: [
      everyIf({
        when: conditionGroup(buttonPress(0)),
        thenActions: [lampAction({ type: "toggle", cId: 15, hc: "On" })],
      }),
      everyIf({
        when: conditionGroup(buttonPress(1)),
        thenActions: [
          lampAction({ type: "inc", cId: 16, hc: "Brightness", value: "10" }),
        ],
      }),
      everyIf({
        when: conditionGroup(buttonPress(2)),
        thenActions: [
          lampAction({ type: "dec", cId: 16, hc: "Brightness", value: "10" }),
        ],
      }),
      everyIf({
        when: conditionGroup({ ...characteristicCondition(), value: "false" }),
        thenActions: [{ type: "scenario", index: "all-off", mode: "FIRE" }],
      }),
    ],
  };

  const prepared = await prepareBlockCreate(client, {
    name: "Кнопка у двери",
    data,
    reason:
      "Нажатие переключает свет, двойное прибавляет яркость на 10, долгое убавляет; без движения запустить «Всё выключить»",
  });
  assert.deepEqual(prepared.structuredContent.diff.configuration.to.data, data);
  const preview = prepared.structuredContent.block_action_preview.actions;
  assert.deepEqual(
    preview.map(
      ({ configuration_pointer, command, comparison_to_observation }) => ({
        configuration_pointer,
        command,
        comparison_to_observation,
      }),
    ),
    [
      {
        configuration_pointer: "/targets/0/then/0/characteristics/0",
        command: {
          operation: "toggle",
          kind: "boolValue",
          execution: "write_if_action_runs",
        },
        comparison_to_observation: "not_applicable",
      },
      {
        configuration_pointer: "/targets/1/then/0/characteristics/0",
        command: {
          operation: "inc",
          step: 10,
          kind: "intValue",
          execution: "write_if_action_runs",
        },
        comparison_to_observation: "not_applicable",
      },
      {
        configuration_pointer: "/targets/2/then/0/characteristics/0",
        command: {
          operation: "dec",
          step: 10,
          kind: "intValue",
          execution: "write_if_action_runs",
        },
        comparison_to_observation: "not_applicable",
      },
    ],
  );

  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.isError, undefined, created.content[0]?.text);
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(created.structuredContent.configuration_matches, true);
  const createdIndex = created.structuredContent.scenario_index;
  assert.deepEqual(
    scenarioData(hub, createdIndex),
    withRuntimeBlockFields(data),
  );

  const run = await prepareScenarioRun(
    client,
    created.structuredContent.scenario_ref,
    "Кнопка у двери",
  );
  assert.equal(run.targets_known, false);
  assert.equal(run.effect.predicted, false);
  assert.equal(run.effect.reasons.includes("targets_unknown"), true);

  const read = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: created.structuredContent.scenario_ref,
      include: ["configuration"],
    },
  });
  const edited = structuredClone(
    read.structuredContent.entity.configuration.value,
  );
  edited.targets[1].then[0].characteristics[0].value = "20";
  const preparedUpdate = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: created.structuredContent.scenario_ref,
      data: edited,
      reason: "Прибавлять яркость на 20",
    },
  });
  assert.equal(
    preparedUpdate.isError,
    undefined,
    preparedUpdate.content[0]?.text,
  );
  const updated = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: preparedUpdate.structuredContent.change_ref },
  });
  assert.equal(updated.structuredContent.status, "applied");
  assert.equal(updated.structuredContent.configuration_matches, true);
  assert.equal(
    scenarioData(hub, createdIndex).targets[1].then[0].characteristics[0].value,
    "20",
  );

  const restoredUpdate = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: preparedUpdate.structuredContent.change_ref },
  });
  assert.equal(restoredUpdate.structuredContent.status, "restored");
  assert.deepEqual(
    scenarioData(hub, createdIndex),
    withRuntimeBlockFields(data),
  );
  const removed = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(removed.structuredContent.status, "restored");
  assert.equal(
    hub.requests.some(
      ({ characteristic, scenario }) => characteristic?.update || scenario?.run,
    ),
    false,
  );
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "all-off"),
    true,
  );
});

test("relative actions and scenario runs outside the contract are refused before send", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  installButton(hub);
  installAllOffScenario(hub);
  const client = await startClient(t, hub, stateDirectory);
  // Each refusal must say what to repair, not only that the data is invalid.
  const cases = [
    [
      "toggle a number",
      lampAction({ type: "toggle", cId: 16, hc: "Brightness" }),
      /toggle .*boolean/,
    ],
    [
      "step a switch",
      lampAction({ type: "inc", cId: 15, hc: "On", value: "1" }),
      /inc .*numeric/,
    ],
    [
      "zero step",
      lampAction({ type: "inc", cId: 16, hc: "Brightness", value: "0" }),
      /inc step must be a positive number/,
    ],
    [
      "negative step",
      lampAction({ type: "dec", cId: 16, hc: "Brightness", value: "-5" }),
      /dec step must be a positive number/,
    ],
    [
      "no step",
      lampAction({ type: "inc", cId: 16, hc: "Brightness" }),
      /inc action is incomplete/,
    ],
    [
      "copy another value",
      lampAction({
        type: "from",
        cId: 16,
        hc: "Brightness",
        from_aId: 32,
        from_sId: 13,
        from_cId: 15,
      }),
      /node type from\b/,
    ],
    [
      "missing scenario",
      { type: "scenario", index: "no-such-scenario", mode: "FIRE" },
      /no-such-scenario/,
    ],
    [
      "activate a scenario",
      { type: "scenario", index: "all-off", mode: "ACTIVATE" },
      /FIRE/,
    ],
  ];
  const results = [];
  for (const [name, target, reason] of cases) {
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_create",
        target_ref: homeRef,
        name,
        description: "Не сохранять неподдержанное действие",
        active: true,
        on_start: false,
        sync: false,
        data: {
          targets: [
            everyIf({
              when: conditionGroup(buttonPress(0)),
              thenActions: [target],
            }),
          ],
        },
        reason: "Проверить границу действий",
      },
    });
    results.push({
      name,
      code: prepared.structuredContent?.error?.code,
      explained: reason.test(prepared.structuredContent?.error?.message ?? ""),
    });
  }

  const selfRun = structuredClone(blockData());
  selfRun.targets[0].then.push({
    type: "scenario",
    index: "existing-block",
    mode: "FIRE",
  });
  const selfRunUpdate = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: selfRun,
      reason: "Сценарий не должен запускать сам себя",
    },
  });
  results.push({
    name: "run itself",
    code: selfRunUpdate.structuredContent?.error?.code,
    explained: /itself/.test(
      selfRunUpdate.structuredContent?.error?.message ?? "",
    ),
  });

  assert.deepEqual(
    results,
    [...cases.map(([name]) => name), "run itself"].map((name) => ({
      name,
      code: "invalid_block_data",
      explained: true,
    })),
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );
});

test("block_data_update wraps a single characteristic if predicate into a condition group before write", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const scheduled = dailyIntervalBlockData();
  hub.state.scenarios[0].data = JSON.stringify(scheduled);
  const leaf = characteristicCondition();
  const nestedLeaf = characteristicCondition({ trigger: false });
  const requested = singleCharacteristicPredicateBlockData({
    predicate: leaf,
    nestedPredicate: nestedLeaf,
  });
  const expected = structuredClone(requested);
  expected.targets[0].if = conditionGroup(leaf);
  expected.targets[0].then[1].if = conditionGroup(nestedLeaf);

  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requested,
      reason: "Заменить расписание одним условием характеристики",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.deepEqual(prepared.structuredContent.diff.data.from, scheduled);
  assert.deepEqual(prepared.structuredContent.diff.data.to, expected);
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
    "preparation must not write the unwrapped leaf",
  );

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.configuration_matches, true);
  const updates = hub.requests.filter(({ scenario }) => scenario?.update);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].scenario.update.index, "existing-block");
  assert.deepEqual(JSON.parse(updates[0].scenario.update.data), expected);
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.delete),
    false,
  );
  assert.equal(hub.state.scenarios[0].index, "existing-block");
  assert.equal(hub.state.scenarios[0].name, "Существующий BLOCK");
  assert.equal(hub.state.scenarios[0].desc, "Ручная конфигурация");
  assert.equal(hub.state.scenarios[0].active, false);
  assert.equal(hub.state.scenarios[0].onStart, false);
  assert.equal(hub.state.scenarios[0].sync, false);
  assert.equal(hub.state.scenarios[0].vendorTopLevel, "preserve-me");

  const readback = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: scenarioRef, include: ["configuration"] },
  });
  assert.equal(readback.isError, undefined, readback.content[0]?.text);
  assert.equal(readback.structuredContent.entity.name, "Существующий BLOCK");
  assert.equal(
    readback.structuredContent.entity.description,
    "Ручная конфигурация",
  );
  assert.equal(readback.structuredContent.entity.active, false);
  assert.equal(readback.structuredContent.entity.on_start, false);
  const value = readback.structuredContent.entity.configuration.value;
  assert.equal(value.targets[0].if.type, "condition");
  assert.equal(value.targets[0].if.mode, "AND");
  assert.equal(value.targets[0].if.conditions.length, 1);
  assert.equal(value.targets[0].if.conditions[0].type, "characteristic");
  assert.equal(value.targets[0].if.conditions[0].aId, leaf.aId);
  assert.equal(value.targets[0].else[0].characteristics[0].value, "false");
  assert.equal(value.targets[0].then[1].if.type, "condition");
  assert.equal(value.targets[0].then[1].if.mode, "AND");
  assert.equal(
    value.targets[0].then[1].if.conditions[0].type,
    "characteristic",
  );
  assert.equal(value.targets[1].if.type, "condition");
  assert.equal(value.targets[1].if.mode, "OR");
  assert.equal(value.targets[1].if.conditions[0].type, "characteristic");

  const repeated = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: expected,
      reason: "Повторно записать уже каноническую группу",
    },
  });
  assert.equal(repeated.isError, undefined, repeated.content[0]?.text);
  assert.deepEqual(repeated.structuredContent.diff.data.to, expected);
  const repeatedApply = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: repeated.structuredContent.change_ref },
  });
  assert.equal(repeatedApply.structuredContent.status, "applied");
  assert.deepEqual(
    JSON.parse(
      hub.requests.filter(({ scenario }) => scenario?.update).at(-1).scenario
        .update.data,
    ),
    expected,
  );

  const orGroup = {
    targets: [
      everyIf({
        when: conditionGroup(characteristicCondition(), "OR"),
        thenActions: [setAction()],
        elseActions: [setAction({ value: "false" })],
      }),
    ],
  };
  const preparedOr = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: orGroup,
      reason: "Сохранить одиночный OR без повторной обёртки",
    },
  });
  assert.equal(preparedOr.isError, undefined, preparedOr.content[0]?.text);
  assert.deepEqual(preparedOr.structuredContent.diff.data.to, orGroup);
  const appliedOr = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: preparedOr.structuredContent.change_ref },
  });
  assert.equal(appliedOr.structuredContent.status, "applied");
  const sentOr = JSON.parse(
    hub.requests.filter(({ scenario }) => scenario?.update).at(-1).scenario
      .update.data,
  );
  assert.equal(sentOr.targets[0].if.type, "condition");
  assert.equal(sentOr.targets[0].if.mode, "OR");
  assert.equal(sentOr.targets[0].if.conditions.length, 1);
  assert.equal(sentOr.targets[0].if.conditions[0].type, "characteristic");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create || scenario?.delete)
      .length,
    0,
  );

  const unknown = structuredClone(orGroup);
  unknown.targets[0].if = { type: "code", code: "return true;" };
  const rejectedUnknown = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: unknown,
      reason: "Не чинить неизвестный узел условия",
    },
  });
  assert.equal(rejectedUnknown.isError, true);
  assert.equal(
    rejectedUnknown.structuredContent.error.code,
    "invalid_block_data",
  );
  assert.equal(
    rejectedUnknown.structuredContent.error.message,
    "Unsupported BLOCK data at root.targets[0].if: node type code is not supported by this contract; allowed here: condition, characteristic.",
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    3,
    "an unknown if predicate must not be rewritten and sent",
  );
});

test("BLOCK preparation rejects delay index zero before any scenario write", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const results = [];

  for (const operation of ["block_create", "block_data_update"]) {
    const data = blockData();
    if (operation === "block_create") delete data.vendorConfiguration;
    data.targets[0].then[1].index = 0;
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation,
        target_ref: operation === "block_create" ? homeRef : scenarioRef,
        ...(operation === "block_create"
          ? {
              name: "BLOCK с неисполняемым таймером",
              description: "Не записывать delay index=0",
              active: false,
              on_start: false,
              sync: false,
            }
          : {}),
        data,
        reason: "Отклонить неисполняемый таймер до записи",
      },
    });
    results.push({
      operation,
      isError: prepared.isError,
      code: prepared.structuredContent?.error?.code,
      message: prepared.structuredContent?.error?.message,
    });
  }

  assert.deepEqual(
    results,
    ["block_create", "block_data_update"].map((operation) => ({
      operation,
      isError: true,
      code: "invalid_block_data",
      message:
        "Unsupported BLOCK data at root.targets[0].then[1]: RESET delay index must be a positive unique integer; time must be a positive integer.",
    })),
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );

  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "block_create" },
  });
  assert.deepEqual(contract.structuredContent.contract.supported.delay_index, {
    type: "integer",
    minimum: 1,
    unique: true,
  });
});

test("BLOCK grammar rejects known nodes in unsupported child slots before send", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const cases = [
    [
      "set in root.targets",
      (data) => {
        data.targets.push({ type: "set", cId: 15, hc: "On", value: "true" });
      },
    ],
    [
      "characteristic in if.then",
      (data) => {
        data.targets[0].then.unshift(
          characteristicCondition({ trigger: false }),
        );
      },
    ],
    [
      "set in condition.conditions",
      (data) => {
        data.targets[0].if.conditions.push({
          type: "set",
          cId: 15,
          hc: "On",
          value: "true",
        });
      },
    ],
    [
      "characteristic in delay.targets",
      (data) => {
        data.targets[0].then[1].targets.push(
          characteristicCondition({ trigger: false }),
        );
      },
    ],
    [
      "single object in if.then",
      (data) => {
        Reflect.set(data.targets[0], "then", data.targets[0].then[0]);
      },
    ],
  ];
  const results = [];

  for (const [name, mutate] of cases) {
    const data = blockData({ nested: true });
    delete data.vendorConfiguration;
    mutate(data);
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_create",
        target_ref: homeRef,
        name: `Неверная позиция: ${name}`,
        description: "Не отправлять неподдержанный BLOCK",
        active: false,
        on_start: false,
        sync: false,
        data,
        reason: "Проверить грамматику BLOCK",
      },
    });
    results.push({
      name,
      isError: prepared.isError,
      code: prepared.structuredContent?.error?.code,
    });
    if (!prepared.isError) {
      await client.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
    }
  }

  assert.deepEqual(
    results,
    cases.map(([name]) => ({
      name,
      isError: true,
      code: "invalid_block_data",
    })),
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );
});

test("an existing BLOCK with a node outside the contract names that node type and stays unsent", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const cases = [
    {
      type: "notify",
      add: (data) => {
        data.targets[0].then.push({
          type: "notify",
          text: "Свет включён",
          mode: "PUSH",
        });
      },
    },
    {
      type: "http",
      add: (data) => {
        data.targets.push({
          type: "http",
          url: "http://example.invalid/hook",
          method: "GET",
        });
      },
    },
    {
      type: "code",
      add: (data) => {
        data.targets.push({ type: "code", code: "log.info('manual');" });
      },
    },
    {
      type: "code",
      add: (data) => {
        data.targets[0].if.conditions.push({
          type: "code",
          code: "return global.guestMode !== true;",
        });
      },
    },
  ];
  const results = [];

  for (const testCase of cases) {
    const manual = blockData();
    delete manual.vendorConfiguration;
    testCase.add(manual);
    hub.state.scenarios[0].data = JSON.stringify(
      withRuntimeBlockFields(manual),
    );
    const read = await client.callTool({
      name: "get_entity",
      arguments: { entity_ref: scenarioRef, include: ["configuration"] },
    });
    assert.equal(read.isError, undefined, read.content[0]?.text);
    const edited = structuredClone(
      read.structuredContent.entity.configuration.value,
    );
    edited.targets[0].then[1].time = 120_000;
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_data_update",
        target_ref: scenarioRef,
        data: edited,
        reason: "Выключать свет через две минуты",
      },
    });
    results.push({
      isError: prepared.isError,
      code: prepared.structuredContent?.error?.code,
      namesType: new RegExp(`node type ${testCase.type}\\b`).test(
        prepared.structuredContent?.error?.message ?? "",
      ),
    });
  }

  assert.deepEqual(
    results,
    cases.map(() => ({
      isError: true,
      code: "invalid_block_data",
      namesType: true,
    })),
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );
});

test("BLOCK create survives a lost response and restores only an unchanged result", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData({ nested: true });
  delete data.vendorConfiguration;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Вложенный свет",
      description: "Два условия и RESET",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Создать нативный BLOCK",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  hub.state.behavior.closeAfterCreate = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, false);
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);
  assert.equal(applied.structuredContent.configuration_matches, true);
  const creates = hub.requests.filter(({ scenario }) => scenario?.create);
  assert.equal(creates.length, 1);
  assert.deepEqual(
    {
      active: creates[0].scenario.create.active,
      onStart: creates[0].scenario.create.onStart,
      sync: creates[0].scenario.create.sync,
      type: creates[0].scenario.create.type,
    },
    { active: false, onStart: false, sync: false, type: "BLOCK" },
  );
  assert.match(
    creates[0].scenario.create.desc,
    /sprut-agent:native:[a-f0-9]{24}/,
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );

  const scenario = hub.state.scenarios.find(
    ({ index }) => index === applied.structuredContent.scenario_index,
  );
  const appliedData = scenario.data;
  scenario.data = JSON.stringify({
    ...JSON.parse(scenario.data),
    manual: true,
  });
  const conflict = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.equal(
    hub.requests.filter(({ scenario: request }) => request?.delete).length,
    0,
  );

  scenario.data = appliedData;
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(
      ({ index }) => index === applied.structuredContent.scenario_index,
    ),
    false,
  );
  assert.equal(
    hub.requests.filter(({ scenario: request }) => request?.delete).length,
    1,
  );
});

test("BLOCK create restore confirms real SprutHub not-found after restart without another delete", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "BLOCK с реальным not-found",
      description: "Подтвердить удаление полным каталогом",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить восстановление после рестарта",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const scenarioListsBeforeRestore = hub.requests.filter(
    ({ scenario }) => scenario?.list,
  ).length;
  const unrelatedScenarioReadsBeforeRestore = hub.requests.filter(
    ({ scenario }) => scenario?.get?.index === "existing-block",
  ).length;
  hub.state.behavior.missingScenarioGetAsNotFoundError = true;

  const restored = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(recovered.structuredContent.status, "restored");
  assert.equal(recovered.structuredContent.verification.fresh, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
  assert.ok(
    hub.requests.filter(({ scenario }) => scenario?.list).length -
      scenarioListsBeforeRestore >=
      2,
    "restore and post-restart observations must use fresh full catalogs",
  );
  assert.equal(
    hub.requests.filter(
      ({ scenario }) => scenario?.get?.index === "existing-block",
    ).length,
    unrelatedScenarioReadsBeforeRestore,
    "marker lookup must not read unrelated scenario configurations",
  );
});

test("scenario get rejection needs a valid catalog absence before it changes lifecycle state", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "BLOCK с проверкой каталога",
      description: "Не считать произвольный отказ отсутствием",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить отрицательные исходы чтения",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const writesBeforeReads = hub.requests.filter(
    ({ scenario }) => scenario?.create || scenario?.update || scenario?.delete,
  ).length;

  hub.state.behavior.rejectScenarioGetAsInternalError = true;
  const presentButRejected = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.rejectScenarioGetAsInternalError = false;

  const createdIndex = applied.structuredContent.scenario_index;
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== createdIndex,
  );
  hub.state.behavior.missingScenarioGetAsNotFoundError = true;
  hub.state.behavior.invalidNextScenarioList = true;
  const missingWithInvalidCatalog = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  for (const observation of [presentButRejected, missingWithInvalidCatalog]) {
    assert.equal(observation.isError, undefined, observation.content[0]?.text);
    assert.equal(observation.structuredContent.status, "applied");
    assert.equal(observation.structuredContent.verification.fresh, false);
    assert.equal(
      "configuration_matches" in observation.structuredContent,
      false,
    );
  }
  assert.equal(
    hub.requests.filter(
      ({ scenario }) =>
        scenario?.create || scenario?.update || scenario?.delete,
    ).length,
    writesBeforeReads,
  );
});

test("a BLOCK action pause expires on the hub after the MCP client stops", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const actionPointer = "/targets/0/then/1";
  const contract = await firstClient.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
    },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.equal(contract.structuredContent.contract.duration.unit, "seconds");
  assert.equal(
    contract.structuredContent.contract.expiration.includes(
      "next ordinary trigger",
    ),
    true,
  );
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
      action_pointer: actionPointer,
      duration_seconds: 1,
      reason: "Временно не выключать свет",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.deepEqual(prepared.structuredContent.pause_effect, {
    status: "not_started",
    action_pointer: actionPointer,
    duration_seconds: 1,
    starts_on_first_apply: true,
  });

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.pause_effect.status, "active");
  const deadline = Date.parse(
    applied.structuredContent.pause_effect.expires_at,
  );
  assert.ok(deadline > Date.now());

  const nativeData = JSON.parse(hub.state.scenarios[0].data);
  assert.deepEqual(nativeData.vendorConfiguration, { preserved: true });
  const preservedOn = structuredClone(nativeData.targets[0].then[0]);
  delete preservedOn.blockId;
  delete preservedOn.characteristics[0].blockId;
  assert.deepEqual(preservedOn, setAction());
  assert.equal(
    independentlyEnabledPausedAction(nativeData, actionPointer, deadline - 1),
    undefined,
  );
  assert.equal(
    independentlyEnabledPausedAction(nativeData, actionPointer, deadline).time,
    60_000,
  );

  await firstClient.close();
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, deadline - Date.now() + 25)),
  );
  const secondClient = await startClient(t, hub, stateDirectory);
  const afterDeadline = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(afterDeadline.structuredContent.status, "applied");
  assert.equal(afterDeadline.structuredContent.pause_effect.status, "expired");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
    "read-only reconciliation must not clean the inert wrapper",
  );

  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef },
  });
  assert.equal(history.structuredContent.changes[0].recorded_status, "applied");
  assert.equal(history.structuredContent.changes[0].effect_status, "expired");

  const currentWithManualEdit = JSON.parse(hub.state.scenarios[0].data);
  blockNodeAtPointer(currentWithManualEdit, actionPointer).then[0].time =
    55_000;
  currentWithManualEdit.targets[0].then.unshift(setAction());
  const ordinary = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: currentWithManualEdit,
      reason: "Изменить другое обычное значение BLOCK",
    },
  });
  assert.equal(ordinary.isError, undefined, ordinary.content[0]?.text);
  assert.equal(
    blockNodeAtPointer(
      ordinary.structuredContent.diff.data.to,
      "/targets/0/then/2",
    ).type,
    "delay",
  );
  await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: ordinary.structuredContent.change_ref },
  });
  assert.equal(
    blockNodeAtPointer(
      JSON.parse(hub.state.scenarios[0].data),
      "/targets/0/then/2",
    ).time,
    55_000,
  );

  const completed = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(completed.structuredContent.status, "completed");
  assert.equal(completed.structuredContent.pause_effect.status, "expired");
  const completedHistory = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, limit: 20 },
  });
  const completedSummary = completedHistory.structuredContent.changes.find(
    ({ change_ref: changeRef }) =>
      changeRef === prepared.structuredContent.change_ref,
  );
  assert.equal(completedSummary.recorded_status, "completed");
  assert.equal(completedSummary.effect_status, "expired");
  assert.equal(
    completedSummary.completed_by_change_ref,
    ordinary.structuredContent.change_ref,
  );
  const completedRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(completedRestore.structuredContent.status, "completed");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    2,
    "restoring a pause already removed by owned cleanup must not write",
  );
});

test("a repeated BLOCK action pause keeps one wrapper and one absolute window", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const actionPointer = "/targets/0/then/1";
  const first = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
      action_pointer: actionPointer,
      duration_seconds: 120,
      reason: "Первое временное исключение",
    },
  });
  hub.state.behavior.closeAfterScenarioUpdate = true;
  const recovered = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  const firstExpiry = recovered.structuredContent.pause_effect.expires_at;
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(recovered.structuredContent.native_acknowledged, false);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeatedApply = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  assert.equal(
    repeatedApply.structuredContent.pause_effect.expires_at,
    firstExpiry,
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );

  const second = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
      action_pointer: actionPointer,
      duration_seconds: 180,
      reason: "Продлить новым поручением",
    },
  });
  const secondApplied = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: second.structuredContent.change_ref },
  });
  assert.equal(secondApplied.structuredContent.status, "applied");
  const current = JSON.parse(hub.state.scenarios[0].data);
  assert.equal(blockNodeAtPointer(current, actionPointer).type, "if");
  assert.equal(
    blockNodeAtPointer(current, `${actionPointer}/then/0`).type,
    "delay",
  );

  const oldStatus = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  assert.equal(oldStatus.structuredContent.status, "superseded");
  assert.equal(oldStatus.structuredContent.pause_effect.status, "superseded");

  const staleRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  assert.equal(staleRestore.structuredContent.status, "superseded");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    2,
    "the older restore must not cancel the newer window",
  );

  const manuallyEdited = JSON.parse(hub.state.scenarios[0].data);
  blockNodeAtPointer(manuallyEdited, `${actionPointer}/then/0`).time = 50_000;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: second.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(
    blockNodeAtPointer(JSON.parse(hub.state.scenarios[0].data), actionPointer)
      .time,
    50_000,
  );
});

test("a repeated pause through its visible action keeps ownership after an ordinary position shift", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const actionPointer = "/targets/0/then/1";
  const first = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
      action_pointer: actionPointer,
      duration_seconds: 120,
      reason: "Первое временное исключение",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });

  for (const overlappingPointer of [
    "/targets/0",
    `${actionPointer}/then/0/targets/0`,
  ]) {
    const overlap = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_action_pause",
        target_ref: scenarioRef,
        action_pointer: overlappingPointer,
        duration_seconds: 180,
        reason: "Не расширять пересекающуюся временную область",
      },
    });
    assert.equal(overlap.isError, true);
    assert.equal(overlap.structuredContent.error.code, "pause_scope_overlap");
    assert.equal(overlap.structuredContent.owned_pause_pointer, actionPointer);
    assert.equal(
      overlap.structuredContent.owned_action_pointer,
      `${actionPointer}/then/0`,
    );
  }

  const equivalentScenarioRef =
    "spruthub://hub/%6Eative-change-test-hub/scenario/existing%2Dblock";
  const second = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: equivalentScenarioRef,
      action_pointer: `${actionPointer}/then/0`,
      duration_seconds: 180,
      reason: "Повторить просьбу из нового диалога",
    },
  });
  assert.equal(second.isError, undefined, second.content[0]?.text);
  assert.equal(second.structuredContent.action_pointer, actionPointer);
  assert.equal(
    second.structuredContent.replaces_change_ref,
    first.structuredContent.change_ref,
  );
  let restoreStateDirectory;
  hub.state.behavior.afterUpdate = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };
  const secondApplied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: second.structuredContent.change_ref },
  });
  assert.equal(secondApplied.structuredContent.status, "applied");
  assert.deepEqual(secondApplied.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_native_change",
  });
  assert.equal(
    JSON.stringify(hub.state.scenarios[0].data).match(
      /sprut-agent:block-action-pause/g,
    )?.length,
    1,
  );
  await client.close();
  await restoreStateDirectory();
  const recoveredClient = await startClient(t, hub, stateDirectory);
  const recoveredSecond = await recoveredClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: second.structuredContent.change_ref },
  });
  assert.equal(recoveredSecond.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    2,
  );

  const history = await recoveredClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, limit: 20 },
  });
  const firstHistory = history.structuredContent.changes.find(
    ({ change_ref: changeRef }) =>
      changeRef === first.structuredContent.change_ref,
  );
  const secondHistory = history.structuredContent.changes.find(
    ({ change_ref: changeRef }) =>
      changeRef === second.structuredContent.change_ref,
  );
  assert.equal(firstHistory.recorded_status, "superseded");
  assert.equal(firstHistory.effect_status, "superseded");
  assert.equal(
    secondHistory.replaces_change_ref,
    first.structuredContent.change_ref,
  );

  const shifted = JSON.parse(hub.state.scenarios[0].data);
  shifted.targets[0].then.unshift(setAction());
  blockNodeAtPointer(shifted, "/targets/0/then/2/then/0").time = 50_000;
  const ordinary = await recoveredClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: shifted,
      reason: "Добавить соседнее действие и изменить исходную задержку",
    },
  });
  assert.equal(ordinary.isError, undefined, ordinary.content[0]?.text);
  const ordinaryApplied = await recoveredClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: ordinary.structuredContent.change_ref },
  });
  assert.equal(ordinaryApplied.structuredContent.status, "applied");

  const shiftedPause = await recoveredClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: second.structuredContent.change_ref },
  });
  assert.equal(shiftedPause.structuredContent.status, "applied");
  assert.equal(
    shiftedPause.structuredContent.action_pointer,
    "/targets/0/then/2",
  );

  const restored = await recoveredClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: second.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  const restoredData = JSON.parse(hub.state.scenarios[0].data);
  assert.equal(
    blockNodeAtPointer(restoredData, "/targets/0/then/2").time,
    50_000,
  );
  assert.equal(
    JSON.stringify(restoredData).includes("sprut-agent:block-action-pause"),
    false,
  );
  const oldAfterRestore = await recoveredClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  assert.equal(oldAfterRestore.structuredContent.status, "superseded");
});

test("a rejected pause remains not applied and cannot write an expired controller", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
      action_pointer: "/targets/0/then/1",
      duration_seconds: 1,
      reason: "Не принимать отказ за применённую паузу",
    },
  });
  hub.state.behavior.rejectNextScenarioUpdate = true;
  const rejected = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  const status = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(status.structuredContent.status, "not_applied");
  assert.equal(status.structuredContent.pause_effect.status, "not_applied");
  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, limit: 20 },
  });
  const summary = history.structuredContent.changes.find(
    ({ change_ref: changeRef }) =>
      changeRef === prepared.structuredContent.change_ref,
  );
  assert.equal(summary.recorded_status, "not_applied");
  assert.equal(summary.effect_status, "not_applied");
  await new Promise((resolve) => setTimeout(resolve, 1_025));
  const expiredRetry = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(expiredRetry.isError, undefined, expiredRetry.content[0]?.text);
  assert.equal(expiredRetry.structuredContent.status, "not_applied");
  assert.equal(
    expiredRetry.structuredContent.pause_effect.status,
    "not_applied",
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
});

test("a rejected pause retries the same absolute window before it expires", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
      action_pointer: "/targets/0/then/1",
      duration_seconds: 120,
      reason: "Повторить явно отклонённое временное исключение",
    },
  });
  hub.state.behavior.rejectNextScenarioUpdate = true;
  const rejected = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  const rejectedStatus = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const originalDeadline =
    rejectedStatus.structuredContent.pause_effect.expires_at;

  const retried = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(retried.isError, undefined, retried.content[0]?.text);
  assert.equal(retried.structuredContent.status, "applied");
  assert.equal(
    retried.structuredContent.pause_effect.expires_at,
    originalDeadline,
  );
  const updates = hub.requests.filter(({ scenario }) => scenario?.update);
  assert.equal(updates.length, 2);
  const retryData = JSON.parse(updates[1].scenario.update.data);
  assert.equal(
    blockNodeAtPointer(retryData, "/targets/0/then/1").if.conditions[0].code,
    `return Date.now() >= ${Date.parse(originalDeadline)}; /* sprut-agent:block-action-pause:${prepared.structuredContent.change_ref.split("/").at(-1)} */`,
  );
});

test("restoring an unapplied action pause does not accuse a controller change or cancel later apply", async (t) => {
  await t.test(
    "prepare without apply, restore across restart, then explicit apply",
    async (t) => {
      const { hub, stateDirectory } = await setup(t);
      const client = await startClient(t, hub, stateDirectory);
      const actionPointer = "/targets/0/then/1";
      const originalData = hub.state.scenarios[0].data;
      const prepared = await client.callTool({
        name: "prepare_native_change",
        arguments: {
          operation: "block_action_pause",
          target_ref: scenarioRef,
          action_pointer: actionPointer,
          duration_seconds: 120,
          reason: "Подготовить временную паузу без записи",
        },
      });
      assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
      assert.equal(prepared.structuredContent.status, "prepared");
      assert.equal(prepared.structuredContent.native_write_sent, false);
      const writesBeforeRestore = scenarioWriteCount(hub);

      const restored = await client.callTool({
        name: "restore_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assertUnappliedPauseRestore(restored, {
        tool: "restore_native_change",
        hub,
        writesBefore: writesBeforeRestore,
        originalData,
      });

      const observed = await client.callTool({
        name: "get_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assertUnappliedPauseRestore(observed, {
        tool: "get_native_change",
        hub,
        writesBefore: writesBeforeRestore,
        originalData,
      });

      await client.close();
      const recoveredClient = await startClient(t, hub, stateDirectory);
      const restoredAgain = await recoveredClient.callTool({
        name: "restore_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assertUnappliedPauseRestore(restoredAgain, {
        tool: "restore_native_change after restart",
        hub,
        writesBefore: writesBeforeRestore,
        originalData,
      });

      const applied = await recoveredClient.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(applied.isError, undefined, applied.content[0]?.text);
      assert.equal(applied.structuredContent.status, "applied");
      assert.ok(
        scenarioWriteCount(hub) > writesBeforeRestore,
        "later apply of the same draft must still write",
      );
      assert.equal(
        JSON.stringify(hub.state.scenarios[0].data).includes(
          "sprut-agent:block-action-pause",
        ),
        true,
      );

      const restoredApplied = await recoveredClient.callTool({
        name: "restore_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(restoredApplied.structuredContent.status, "restored");
      assert.equal(
        JSON.stringify(hub.state.scenarios[0].data).includes(
          "sprut-agent:block-action-pause",
        ),
        false,
      );
      assert.equal(
        blockNodeAtPointer(
          JSON.parse(hub.state.scenarios[0].data),
          actionPointer,
        ).time,
        60_000,
      );
    },
  );

  await t.test(
    "a matching foreign wrapper is not taken as this unsent draft",
    async (t) => {
      const { hub, stateDirectory } = await setup(t);
      const client = await startClient(t, hub, stateDirectory);
      const actionPointer = "/targets/0/then/1";
      const prepared = await client.callTool({
        name: "prepare_native_change",
        arguments: {
          operation: "block_action_pause",
          target_ref: scenarioRef,
          action_pointer: actionPointer,
          duration_seconds: 120,
          reason: "Не присваивать чужой контроллер неприменённому черновику",
        },
      });
      assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
      const changeId = prepared.structuredContent.change_ref.split("/").at(-1);
      const forged = JSON.parse(hub.state.scenarios[0].data);
      const originalAction = structuredClone(
        blockNodeAtPointer(forged, actionPointer),
      );
      forged.targets[0].then[1] = {
        type: "if",
        mode: "EVERY",
        if: {
          type: "condition",
          mode: "AND",
          conditions: [
            {
              type: "code",
              code: `return Date.now() >= ${Date.now() + 120_000}; /* sprut-agent:block-action-pause:${changeId} */`,
            },
          ],
        },
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
        then: [originalAction],
        else: [],
        then_delay: 0,
        else_delay: 0,
      };
      hub.state.scenarios[0].data = JSON.stringify(forged);
      const forgedData = hub.state.scenarios[0].data;
      const writesBefore = scenarioWriteCount(hub);

      const restored = await client.callTool({
        name: "restore_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assertUnappliedPauseRestore(restored, {
        tool: "restore against a matching foreign wrapper",
        hub,
        writesBefore,
        originalData: forgedData,
      });
      assert.equal(
        JSON.stringify(hub.state.scenarios[0].data).includes(
          `sprut-agent:block-action-pause:${changeId}`,
        ),
        true,
        "unsent draft must not delete a coincidental matching controller",
      );
    },
  );

  await t.test(
    "a later manual edit or missing target does not write through the unsent draft",
    async (t) => {
      const { hub, stateDirectory } = await setup(t);
      const client = await startClient(t, hub, stateDirectory);
      const actionPointer = "/targets/0/then/1";
      const originalData = hub.state.scenarios[0].data;
      const editedDraft = await client.callTool({
        name: "prepare_native_change",
        arguments: {
          operation: "block_action_pause",
          target_ref: scenarioRef,
          action_pointer: actionPointer,
          duration_seconds: 120,
          reason: "Не затирать ручную правку неприменённым черновиком",
        },
      });
      assert.equal(
        editedDraft.isError,
        undefined,
        editedDraft.content[0]?.text,
      );
      const writesBeforeEditRestore = scenarioWriteCount(hub);
      const editedRestore = await client.callTool({
        name: "restore_native_change",
        arguments: { change_ref: editedDraft.structuredContent.change_ref },
      });
      assertUnappliedPauseRestore(editedRestore, {
        tool: "restore before a manual BLOCK edit",
        hub,
        writesBefore: writesBeforeEditRestore,
        originalData,
      });
      const edited = JSON.parse(originalData);
      blockNodeAtPointer(edited, actionPointer).time = 90_000;
      hub.state.scenarios[0].data = JSON.stringify(edited);
      const writesBeforeManual = scenarioWriteCount(hub);
      const manualApply = await client.callTool({
        name: "apply_native_change",
        arguments: { change_ref: editedDraft.structuredContent.change_ref },
      });
      assert.equal(manualApply.structuredContent.status, "conflict");
      assert.equal(
        manualApply.structuredContent.conflict_reason,
        "baseline_changed",
      );
      assert.equal(scenarioWriteCount(hub), writesBeforeManual);
      assert.equal(
        blockNodeAtPointer(
          JSON.parse(hub.state.scenarios[0].data),
          actionPointer,
        ).time,
        90_000,
      );

      hub.state.scenarios[0].data = originalData;
      const missingDraft = await client.callTool({
        name: "prepare_native_change",
        arguments: {
          operation: "block_action_pause",
          target_ref: scenarioRef,
          action_pointer: actionPointer,
          duration_seconds: 120,
          reason: "Не создавать чужой BLOCK из неприменённого черновика",
        },
      });
      assert.equal(
        missingDraft.isError,
        undefined,
        missingDraft.content[0]?.text,
      );
      const writesBeforeMissingRestore = scenarioWriteCount(hub);
      const preparedMissingRestore = await client.callTool({
        name: "restore_native_change",
        arguments: { change_ref: missingDraft.structuredContent.change_ref },
      });
      assertUnappliedPauseRestore(preparedMissingRestore, {
        tool: "restore before the target BLOCK disappeared",
        hub,
        writesBefore: writesBeforeMissingRestore,
        originalData,
      });
      hub.state.scenarios = [];
      const writesBeforeMissing = scenarioWriteCount(hub);
      const missingRestore = await client.callTool({
        name: "restore_native_change",
        arguments: { change_ref: missingDraft.structuredContent.change_ref },
      });
      assertUnappliedPauseRestore(missingRestore, {
        tool: "restore after the target BLOCK disappeared",
        hub,
        writesBefore: writesBeforeMissing,
        scenariosBefore: 0,
      });
      const missingApply = await client.callTool({
        name: "apply_native_change",
        arguments: { change_ref: missingDraft.structuredContent.change_ref },
      });
      assert.equal(missingApply.structuredContent.status, "conflict");
      assert.equal(hub.state.scenarios.length, 0);
      assert.equal(scenarioWriteCount(hub), writesBeforeMissing);
    },
  );

  await t.test(
    "a saved apply conflict is not reopened by restore after the baseline returns",
    async (t) => {
      const { hub, stateDirectory } = await setup(t);
      const client = await startClient(t, hub, stateDirectory);
      const actionPointer = "/targets/0/then/1";
      const originalData = hub.state.scenarios[0].data;
      const prepared = await client.callTool({
        name: "prepare_native_change",
        arguments: {
          operation: "block_action_pause",
          target_ref: scenarioRef,
          action_pointer: actionPointer,
          duration_seconds: 120,
          reason: "Не открывать запись после отказа из-за ручной правки",
        },
      });
      assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
      const edited = JSON.parse(originalData);
      blockNodeAtPointer(edited, actionPointer).time = 90_000;
      hub.state.scenarios[0].data = JSON.stringify(edited);
      const writesBeforeApply = scenarioWriteCount(hub);

      const applied = await client.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(applied.structuredContent.status, "conflict");
      assert.equal(
        applied.structuredContent.conflict_reason,
        "baseline_changed",
      );
      assert.equal(scenarioWriteCount(hub), writesBeforeApply);

      const restored = await client.callTool({
        name: "restore_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(restored.structuredContent.status, "conflict");
      assert.equal(
        restored.structuredContent.conflict_reason,
        "baseline_changed",
      );
      assert.equal(scenarioWriteCount(hub), writesBeforeApply);
      assert.equal(
        blockNodeAtPointer(
          JSON.parse(hub.state.scenarios[0].data),
          actionPointer,
        ).time,
        90_000,
      );

      const observed = await client.callTool({
        name: "get_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(observed.structuredContent.status, "conflict");
      assert.equal(
        observed.structuredContent.conflict_reason,
        "baseline_changed",
      );

      hub.state.scenarios[0].data = originalData;
      const retried = await client.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(retried.structuredContent.status, "conflict");
      assert.equal(
        retried.structuredContent.conflict_reason,
        "baseline_changed",
      );
      assert.equal(scenarioWriteCount(hub), writesBeforeApply);
      assert.equal(hub.state.scenarios[0].data, originalData);
    },
  );
});

test("BLOCK update restore preserves an active pause and records its explicit removal", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const pause = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
      action_pointer: "/targets/0/then/1",
      duration_seconds: 120,
      reason: "Временно остановить RESET",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: pause.structuredContent.change_ref },
  });
  const changed = JSON.parse(hub.state.scenarios[0].data);
  blockNodeAtPointer(changed, "/targets/0/then/1/then/0").time = 90_000;
  const ordinary = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: changed,
      reason: "Изменить задержку во время паузы",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: ordinary.structuredContent.change_ref },
  });

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: ordinary.structuredContent.change_ref },
  });

  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  const current = JSON.parse(hub.state.scenarios[0].data);
  assert.equal(
    JSON.stringify(current).match(/sprut-agent:block-action-pause/g)?.length,
    1,
  );
  assert.equal(
    blockNodeAtPointer(current, "/targets/0/then/1/then/0").time,
    60_000,
  );
  const active = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: pause.structuredContent.change_ref },
  });
  assert.equal(active.structuredContent.status, "applied");
  assert.equal(active.structuredContent.pause_effect.status, "active");

  current.targets[0].then[1] = structuredClone(
    current.targets[0].then[1].then[0],
  );
  const removal = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: current,
      reason: "Явно закончить временное исключение обычной правкой",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: removal.structuredContent.change_ref },
  });
  const removed = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: pause.structuredContent.change_ref },
  });
  assert.equal(removed.structuredContent.status, "restored");
  assert.equal(removed.structuredContent.pause_effect.status, "restored");
  assert.equal(
    removed.structuredContent.restored_by_change_ref,
    removal.structuredContent.change_ref,
  );
  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, limit: 20 },
  });
  const removedSummary = history.structuredContent.changes.find(
    ({ change_ref: changeRef }) =>
      changeRef === pause.structuredContent.change_ref,
  );
  assert.equal(removedSummary.recorded_status, "restored");
  assert.equal(removedSummary.effect_status, "restored");
  assert.equal(
    removedSummary.restored_by_change_ref,
    removal.structuredContent.change_ref,
  );
  assert.equal(
    JSON.stringify(hub.state.scenarios[0].data).includes(
      "sprut-agent:block-action-pause",
    ),
    false,
  );
});

test("BLOCK update restore does not revive a pause that expired after the update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const pause = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
      action_pointer: "/targets/0/then/1",
      duration_seconds: 1,
      reason: "Коротко остановить RESET",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: pause.structuredContent.change_ref },
  });
  const changed = JSON.parse(hub.state.scenarios[0].data);
  blockNodeAtPointer(changed, "/targets/0/then/1/then/0").time = 90_000;
  const ordinary = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: changed,
      reason: "Изменить задержку до истечения паузы",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: ordinary.structuredContent.change_ref },
  });
  await new Promise((resolve) => setTimeout(resolve, 1_025));

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: ordinary.structuredContent.change_ref },
  });

  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  const restoredData = JSON.parse(hub.state.scenarios[0].data);
  assert.equal(restoredData.targets[0].then[1].time, 60_000);
  assert.equal(
    JSON.stringify(restoredData).includes("sprut-agent:block-action-pause"),
    false,
  );
  const completed = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: pause.structuredContent.change_ref },
  });
  assert.equal(completed.structuredContent.status, "completed");
  assert.equal(completed.structuredContent.pause_effect.status, "expired");
  assert.equal(
    completed.structuredContent.completed_by_change_ref,
    ordinary.structuredContent.change_ref,
  );
});

test("a manually changed pause deadline is neither reported nor restored as owned", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const pause = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
      action_pointer: "/targets/0/then/1",
      duration_seconds: 120,
      reason: "Не присваивать вручную изменённый срок",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: pause.structuredContent.change_ref },
  });
  const edited = JSON.parse(hub.state.scenarios[0].data);
  const controller = blockNodeAtPointer(edited, "/targets/0/then/1");
  controller.if.conditions[0].code = controller.if.conditions[0].code.replace(
    />= (\d+);/,
    (_match, deadline) => `>= ${Number(deadline) + 60_000};`,
  );
  hub.state.scenarios[0].data = JSON.stringify(edited);

  const status = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: pause.structuredContent.change_ref },
  });
  assert.equal(status.structuredContent.status, "conflict");
  assert.equal(
    status.structuredContent.conflict_reason,
    "pause_controller_changed",
  );
  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: pause.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "conflict");
  assert.equal(
    restored.structuredContent.conflict_reason,
    "pause_controller_changed",
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
  assert.equal(
    JSON.stringify(hub.state.scenarios[0].data).includes(
      "sprut-agent:block-action-pause",
    ),
    true,
  );
});

test("BLOCK action pause rejects non-actions and preserves an edited controller", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const triggerSubgraph = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
      action_pointer: "/targets/0",
      duration_seconds: 60,
      reason: "Не переносить регистрацию триггера внутрь паузы",
    },
  });
  assert.equal(triggerSubgraph.isError, true);
  assert.equal(
    triggerSubgraph.structuredContent.error.code,
    "unsupported_pause_trigger_scope",
  );
  assert.deepEqual(
    triggerSubgraph.structuredContent.suggested_action_pointers,
    ["/targets/0/then/0", "/targets/0/then/1"],
  );

  const rootActionData = blockData();
  rootActionData.targets.push(setAction());
  hub.state.scenarios[0].data = JSON.stringify(rootActionData);
  const rootAction = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
      action_pointer: "/targets/1",
      duration_seconds: 60,
      reason: "Разрешить самостоятельное действие без вложенного триггера",
    },
  });
  assert.equal(rootAction.isError, undefined, rootAction.content[0]?.text);
  hub.state.scenarios[0].data = JSON.stringify(blockData());

  for (const actionPointer of [
    "/targets/0/if/conditions/0",
    "/targets/0/then/1/time",
    "/targets/9",
  ]) {
    const refused = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_action_pause",
        target_ref: scenarioRef,
        action_pointer: actionPointer,
        duration_seconds: 60,
        reason: "Недопустимый указатель",
      },
    });
    assert.equal(refused.isError, true);
    assert.equal(
      refused.structuredContent.error.code,
      "invalid_action_pointer",
    );
  }

  const pause = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_action_pause",
      target_ref: scenarioRef,
      action_pointer: "/targets/0/then/1",
      duration_seconds: 60,
      reason: "Проверить владение контейнером",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: pause.structuredContent.change_ref },
  });
  const forged = JSON.parse(hub.state.scenarios[0].data);
  const forgedController = blockNodeAtPointer(forged, "/targets/0/then/1");
  forgedController.if.conditions[0].code =
    forgedController.if.conditions[0].code.replace(
      />= \d+;/,
      ">= 9999999999999;",
    );
  const refusedCode = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: forged,
      reason: "Не разрешать произвольный срок под старым маркером",
    },
  });
  assert.equal(refusedCode.isError, true);
  assert.equal(refusedCode.structuredContent.error.code, "invalid_block_data");

  const duplicated = JSON.parse(hub.state.scenarios[0].data);
  duplicated.targets.push(
    structuredClone(blockNodeAtPointer(duplicated, "/targets/0/then/1")),
  );
  const refusedDuplicate = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: duplicated,
      reason: "Не принимать дублированный маркер за владение",
    },
  });
  assert.equal(refusedDuplicate.isError, true);
  assert.equal(
    refusedDuplicate.structuredContent.error.code,
    "invalid_block_data",
  );

  const edited = JSON.parse(hub.state.scenarios[0].data);
  blockNodeAtPointer(edited, "/targets/0/then/1").else = [setAction()];
  hub.state.scenarios[0].data = JSON.stringify(edited);
  const refusedRestore = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: pause.structuredContent.change_ref },
  });
  assert.equal(refusedRestore.structuredContent.status, "conflict");
  assert.equal(
    refusedRestore.structuredContent.conflict_reason,
    "pause_controller_changed",
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
});

test("BLOCK data update verifies readback and restores its complete baseline", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const requestedData = blockData({ delay: 45_000 });
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requestedData,
      reason: "Уменьшить RESET delay",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.equal(prepared.structuredContent.diff.data.changed, true);
  assert.deepEqual(prepared.structuredContent.diff.data.from, blockData());
  assert.deepEqual(prepared.structuredContent.diff.data.to, requestedData);
  assert.equal(prepared.structuredContent.restore_supported, true);

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, true);
  assert.equal(applied.structuredContent.configuration_matches, true);
  const updates = hub.requests.filter(({ scenario }) => scenario?.update);
  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0].scenario.update).sort(), [
    "data",
    "index",
  ]);
  assert.equal(updates[0].scenario.update.index, "existing-block");
  assert.equal(hub.state.scenarios[0].name, "Существующий BLOCK");
  assert.equal(hub.state.scenarios[0].vendorTopLevel, "preserve-me");

  const appliedData = hub.state.scenarios[0].data;
  hub.state.scenarios[0].data = JSON.stringify({
    ...JSON.parse(appliedData),
    manual: "keep",
  });
  const conflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );

  hub.state.scenarios[0].data = appliedData;
  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.configuration_matches, true);
  const restoredData = JSON.parse(hub.state.scenarios[0].data);
  assert.equal(restoredData.targets[0].then[1].time, 60_000);
  assert.deepEqual(restoredData.vendorConfiguration, { preserved: true });
});

test("BLOCK target move and restore accept rooms recalculated by SprutHub", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.rooms.push({ id: 3, order: 3, name: "Гостиная", visible: true });
  for (const [id, roomId, name] of [
    [36, 2, "Свет мастерской"],
    [38, 3, "Свет гостиной"],
  ]) {
    hub.state.accessories.push({
      id,
      roomId,
      name,
      online: true,
      services: [
        {
          aId: id,
          sId: 13,
          name: "Свет",
          type: "Lightbulb",
          characteristics: [
            {
              aId: id,
              sId: 13,
              cId: 15,
              control: {
                name: "Включена",
                type: "On",
                read: true,
                write: true,
                value: { boolValue: false },
              },
            },
          ],
        },
      ],
    });
  }
  const baselineData = blockData();
  baselineData.targets[0].then[0].aId = 36;
  baselineData.targets[0].then[1].targets[0].aId = 36;
  hub.state.scenarios[0].data = JSON.stringify(baselineData);
  hub.state.scenarios[0].rooms = [1, 2];
  hub.state.behavior.recalculateBlockRooms = true;
  const requestedData = structuredClone(baselineData);
  requestedData.targets[0].then[0].aId = 38;
  requestedData.targets[0].then[1].targets[0].aId = 38;

  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requestedData,
      reason: "Перенести правило на свет гостиной",
    },
  });
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.deepEqual(hub.state.scenarios[0].rooms, [1, 3]);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const afterRestart = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(afterRestart.structuredContent.status, "applied");
  assert.equal(afterRestart.structuredContent.configuration_matches, true);

  hub.state.scenarios[0].onStart = true;
  const manualConflict = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(manualConflict.structuredContent.status, "conflict");
  assert.equal(
    manualConflict.structuredContent.conflict_reason,
    "manual_change",
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );

  hub.state.scenarios[0].onStart = false;
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.configuration_matches, true);
  assert.deepEqual(hub.state.scenarios[0].rooms, [1, 2]);
  assert.equal(
    JSON.parse(hub.state.scenarios[0].data).targets[0].then[0].aId,
    36,
  );
});

test("BLOCK target class change stays applied when SprutHub projects rooms, icons, and error", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.rooms.push(
    { id: 8, order: 8, name: "Коридор", visible: true },
    { id: 14, order: 14, name: "Климат", visible: true },
  );
  hub.state.accessories.push(
    boundAccessory({
      id: 40,
      roomId: 14,
      name: "Термостат",
      service: {
        sId: 13,
        name: "Термостат",
        type: "Thermostat",
        cId: 15,
        characteristicName: "Режим",
        characteristicType: "TargetHeatingCoolingState",
        value: { intValue: 1 },
      },
    }),
    boundAccessory({
      id: 41,
      roomId: 8,
      name: "Охрана",
      service: {
        sId: 13,
        name: "Охрана",
        type: "SecuritySystem",
        cId: 15,
        characteristicName: "Режим",
        characteristicType: "TargetSecuritySystemState",
        value: { intValue: 1 },
      },
    }),
  );
  const thermostatAction = setAction({
    aId: 40,
    hs: "Thermostat",
    hc: "TargetHeatingCoolingState",
    value: "1",
  });
  const securityAction = setAction({
    aId: 41,
    hs: "SecuritySystem",
    hc: "TargetSecuritySystemState",
    value: "1",
  });
  const baselineData = blockData();
  // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
  baselineData.targets[0].then = [thermostatAction];
  hub.state.scenarios[0].data = JSON.stringify(baselineData);
  hub.state.scenarios[0].rooms = [1, 14];
  hub.state.scenarios[0].iconsIf = ["MotionSensor"];
  hub.state.scenarios[0].iconsThen = ["Thermostat"];
  hub.state.scenarios[0].error = false;
  hub.state.scenarios[0].order = 4;
  hub.state.behavior.projectBlockDerivedFields = true;
  const requestedData = structuredClone(baselineData);
  // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
  requestedData.targets[0].then = [thermostatAction, securityAction];

  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requestedData,
      reason: "Добавить охрану к климатическому правилу",
    },
  });
  hub.state.behavior.closeAfterScenarioUpdate = true;
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.configuration_matches, true);
  assert.equal(applied.structuredContent.native_acknowledged, false);
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);
  assert.deepEqual(hub.state.scenarios[0].rooms, [1, 8, 14]);
  assert.deepEqual(hub.state.scenarios[0].iconsThen, [
    "Thermostat",
    "SecuritySystem",
  ]);
  assert.equal(hub.state.scenarios[0].error, true);
  assert.equal(hub.state.scenarios[0].order, 11);
  assert.equal(hub.state.scenarios[0].bundleId, "hub-ui");
  assert.equal(
    JSON.parse(hub.state.scenarios[0].data).targets[0].then[1].aId,
    41,
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const afterRestart = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(afterRestart.structuredContent.status, "applied");
  assert.equal(afterRestart.structuredContent.configuration_matches, true);

  hub.state.scenarios[0].onStart = true;
  const manualConflict = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(manualConflict.structuredContent.status, "conflict");
  assert.equal(
    manualConflict.structuredContent.conflict_reason,
    "manual_change",
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );

  const repeatedConflict = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeatedConflict.structuredContent.status, "conflict");
  assert.equal(
    repeatedConflict.structuredContent.conflict_reason,
    "manual_change",
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
    "a previous conflict must not restore without proven ownership",
  );

  hub.state.scenarios[0].onStart = false;
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.configuration_matches, true);
  assert.deepEqual(
    JSON.parse(hub.state.scenarios[0].data).targets[0].then.map(
      ({ aId }) => aId,
    ),
    [40],
  );
  assert.deepEqual(hub.state.scenarios[0].rooms, [1, 14]);
  assert.deepEqual(hub.state.scenarios[0].iconsThen, ["Thermostat"]);
});

function nativeChangeJournalFile(stateDirectory, hubUrl) {
  const fingerprint = createHash("sha256")
    .update(`${hubUrl}\0${serial}`)
    .digest("hex");
  return path.join(
    stateDirectory,
    `automation-changes-${fingerprint.slice(0, 24)}.json`,
  );
}

function rewriteJournalChangeAsUnprovenConflict(change) {
  delete change.applied_snapshot;
  change.status = "conflict";
  change.conflict_reason = "manual_change";
  change.configuration_matches = false;
  const projections = {
    rooms: [14],
    iconsIf: ["MotionSensor"],
    iconsThen: ["Thermostat"],
    error: false,
    order: 4,
    bundleId: "hub-ui",
  };
  change.baseline_snapshot = { ...change.baseline_snapshot, ...projections };
  change.requested_snapshot = {
    ...change.requested_snapshot,
    ...projections,
    rooms: [1, 8, 14],
    iconsThen: ["Thermostat", "SecuritySystem"],
  };
}

function assertUnprovenBlockConflict(
  result,
  { tool, hub, writesBefore, verificationResult = "requested_configuration" },
) {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(result.structuredContent.status, "conflict", tool);
  assert.equal(result.structuredContent.conflict_reason, "manual_change", tool);
  assert.equal(result.structuredContent.configuration_matches, false, tool);
  assert.equal(result.structuredContent.restore_supported, false, tool);
  assert.equal(
    result.structuredContent.verification.result,
    verificationResult,
    tool,
  );
  assert.deepEqual(
    result.structuredContent.next,
    {
      tool: "get_native_change_contract",
      arguments: {
        operation: "block_data_update",
        target_ref: scenarioRef,
      },
    },
    tool,
  );
  assert.match(
    result.structuredContent.limitations.join("\n"),
    /no proven applied snapshot/i,
    tool,
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    writesBefore,
    `${tool} must not send a BLOCK write without proven ownership`,
  );
}

async function inspectUnprovenBlockConflict(
  client,
  changeRef,
  hub,
  writesBefore,
) {
  for (const tool of [
    "get_native_change",
    "restore_native_change",
    "apply_native_change",
  ]) {
    const result = await client.callTool({
      name: tool,
      arguments: { change_ref: changeRef },
    });
    assertUnprovenBlockConflict(result, { tool, hub, writesBefore });
  }
}

function assertUnprovenLogicConflict(
  result,
  { tool, hub, writesBefore, targetRef },
) {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(result.structuredContent.status, "conflict", tool);
  assert.equal(result.structuredContent.conflict_reason, "manual_change", tool);
  assert.equal(result.structuredContent.configuration_matches, false, tool);
  assert.equal(result.structuredContent.restore_supported, false, tool);
  assert.equal(
    result.structuredContent.verification.result,
    "requested_logic_source",
    tool,
  );
  assert.equal(result.structuredContent.diff.source.exact_match, true, tool);
  assert.deepEqual(
    result.structuredContent.next,
    {
      tool: "get_native_change_contract",
      arguments: {
        operation: "logic_source_update",
        target_ref: targetRef,
      },
    },
    tool,
  );
  assert.match(
    result.structuredContent.limitations.join("\n"),
    /no proven applied snapshot/i,
    tool,
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create || scenario?.update)
      .length,
    writesBefore,
    `${tool} must not send a LOGIC write without proven ownership`,
  );
}

async function inspectUnprovenLogicConflict(
  client,
  changeRef,
  hub,
  writesBefore,
  targetRef,
) {
  let last;
  for (const tool of [
    "get_native_change",
    "restore_native_change",
    "apply_native_change",
  ]) {
    last = await client.callTool({
      name: tool,
      arguments: { change_ref: changeRef },
    });
    assertUnprovenLogicConflict(last, { tool, hub, writesBefore, targetRef });
  }
  return last;
}

test("BLOCK conflict without an applied snapshot does not treat a requested match as applied", async (t) => {
  await t.test(
    "a foreign edit during write then matching revert keeps conflict without a write",
    async (t) => {
      const { hub, stateDirectory } = await setup(t);
      const client = await startClient(t, hub, stateDirectory);
      const requestedData = blockData({ delay: 45_000 });
      const prepared = await client.callTool({
        name: "prepare_native_change",
        arguments: {
          operation: "block_data_update",
          target_ref: scenarioRef,
          data: requestedData,
          reason: "Проверить конфликт без applied snapshot",
        },
      });
      const baselineData = hub.state.scenarios[0].data;
      let requestedRuntime;
      hub.state.behavior.afterUpdate = () => {
        const scenario = hub.state.scenarios[0];
        requestedRuntime = scenario.data;
        const edited = JSON.parse(scenario.data);
        edited.targets[0].then[1].time = 99_000;
        scenario.data = JSON.stringify(edited);
      };

      const applied = await client.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(applied.structuredContent.status, "conflict");
      assert.equal(applied.structuredContent.conflict_reason, "manual_change");
      const writesAfterApply = hub.requests.filter(
        ({ scenario }) => scenario?.update,
      ).length;
      assert.equal(writesAfterApply, 1);
      const journalAfterConflict = JSON.parse(
        await readFile(
          nativeChangeJournalFile(stateDirectory, hub.url),
          "utf8",
        ),
      );
      const changeId = prepared.structuredContent.change_ref.slice(
        "spruthub-change://native/".length,
      );
      assert.equal(
        "applied_snapshot" in journalAfterConflict.changes[changeId],
        false,
      );

      hub.state.scenarios[0].data = requestedRuntime;
      await inspectUnprovenBlockConflict(
        client,
        prepared.structuredContent.change_ref,
        hub,
        writesAfterApply,
      );

      await client.close();
      const restarted = await startClient(t, hub, stateDirectory);
      await inspectUnprovenBlockConflict(
        restarted,
        prepared.structuredContent.change_ref,
        hub,
        writesAfterApply,
      );

      hub.state.scenarios[0].data = baselineData;
      const baselineResult = await restarted.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assertUnprovenBlockConflict(baselineResult, {
        tool: "apply_native_change",
        hub,
        writesBefore: writesAfterApply,
        verificationResult: "requested_configuration_missing",
      });
      assert.equal(hub.state.scenarios[0].data, baselineData);
    },
  );

  await t.test(
    "a saved 0.1.17 conflict with projected rooms and icons stays unrestorable",
    async (t) => {
      const { hub, stateDirectory } = await setup(t);
      const firstClient = await startClient(t, hub, stateDirectory);
      const prepared = await firstClient.callTool({
        name: "prepare_native_change",
        arguments: {
          operation: "block_data_update",
          target_ref: scenarioRef,
          data: blockData({ delay: 45_000 }),
          reason: "Сохранить старую conflict-запись без applied snapshot",
        },
      });
      const applied = await firstClient.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(applied.structuredContent.status, "applied");
      const writesAfterApply = hub.requests.filter(
        ({ scenario }) => scenario?.update,
      ).length;
      await firstClient.close();

      const journalFile = nativeChangeJournalFile(stateDirectory, hub.url);
      const journal = JSON.parse(await readFile(journalFile, "utf8"));
      const changeId = prepared.structuredContent.change_ref.slice(
        "spruthub-change://native/".length,
      );
      rewriteJournalChangeAsUnprovenConflict(journal.changes[changeId]);
      await writeFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`);

      const secondClient = await startClient(t, hub, stateDirectory);
      await inspectUnprovenBlockConflict(
        secondClient,
        prepared.structuredContent.change_ref,
        hub,
        writesAfterApply,
      );
      assert.equal(
        JSON.parse(hub.state.scenarios[0].data).targets[0].then[1].time,
        45_000,
      );
    },
  );
});

test("BLOCK apply does not overwrite a manual revert after a proven apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const baselineData = hub.state.scenarios[0].data;
  const requestedData = blockData({ delay: 45_000 });
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requestedData,
      reason: "Не затирать ручной откат повторным apply",
    },
  });
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  const writesAfterApply = hub.requests.filter(
    ({ scenario }) => scenario?.update,
  ).length;
  assert.equal(writesAfterApply, 1);
  assert.equal(
    JSON.parse(hub.state.scenarios[0].data).targets[0].then[1].time,
    45_000,
  );

  hub.state.scenarios[0].data = baselineData;
  const observed = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(observed.structuredContent.status, "conflict");
  assert.equal(observed.structuredContent.conflict_reason, "manual_change");
  assert.equal(observed.structuredContent.configuration_matches, false);
  assert.equal(observed.structuredContent.restore_supported, true);

  const refusedRestore = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refusedRestore.structuredContent.status, "conflict");
  assert.equal(
    refusedRestore.structuredContent.conflict_reason,
    "manual_change",
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    writesAfterApply,
  );

  const refusedApply = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refusedApply.isError, undefined, refusedApply.content[0]?.text);
  assert.equal(refusedApply.structuredContent.status, "conflict");
  assert.equal(refusedApply.structuredContent.conflict_reason, "manual_change");
  assert.equal(refusedApply.structuredContent.configuration_matches, false);
  assert.equal(refusedApply.structuredContent.restore_supported, true);
  assert.deepEqual(refusedApply.structuredContent.next, {
    tool: "get_native_change_contract",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
    },
  });
  assert.match(
    refusedApply.structuredContent.limitations.join("\n"),
    /already applied[\s\S]*apply will not be sent again/i,
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    writesAfterApply,
    "repeat apply must not overwrite a manual revert of a proven BLOCK change",
  );
  assert.equal(hub.state.scenarios[0].data, baselineData);
  assert.equal(
    JSON.parse(hub.state.scenarios[0].data).targets[0].then[1].time,
    60_000,
  );

  await firstClient.close();
  const restarted = await startClient(t, hub, stateDirectory);
  const refusedAfterRestart = await restarted.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refusedAfterRestart.structuredContent.status, "conflict");
  assert.equal(
    refusedAfterRestart.structuredContent.conflict_reason,
    "manual_change",
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    writesAfterApply,
  );
  assert.equal(hub.state.scenarios[0].data, baselineData);

  const contract = await restarted.callTool({
    name: refusedApply.structuredContent.next.tool,
    arguments: refusedApply.structuredContent.next.arguments,
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);

  const retried = await restarted.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requestedData,
      reason: "Новое разрешённое изменение после ручного отката",
    },
  });
  assert.equal(retried.structuredContent.status, "prepared");
  const retriedApply = await restarted.callTool({
    name: "apply_native_change",
    arguments: { change_ref: retried.structuredContent.change_ref },
  });
  assert.equal(retriedApply.isError, undefined, retriedApply.content[0]?.text);
  assert.equal(retriedApply.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    writesAfterApply + 1,
  );
  assert.equal(
    JSON.parse(hub.state.scenarios[0].data).targets[0].then[1].time,
    45_000,
  );
});

test("LOGIC conflict without an applied snapshot does not treat a requested match as applied", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const created = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "LOGIC без ложного apply",
      description: "Проверить conflict без applied snapshot",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Создать LOGIC для проверки conflict",
    },
  });
  const appliedCreate = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(
    appliedCreate.isError,
    undefined,
    appliedCreate.content[0]?.text,
  );
  assert.equal(appliedCreate.structuredContent.status, "applied");
  const scenarioTarget = appliedCreate.structuredContent.scenario_ref;
  const writesAfterCreate = hub.requests.filter(
    ({ scenario }) => scenario?.create || scenario?.update,
  ).length;

  const update = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_update",
      target_ref: scenarioTarget,
      source: secondLogicSource,
      reason: "Проверить conflict LOGIC без applied snapshot",
    },
  });
  let requestedRuntime;
  hub.state.behavior.afterUpdate = () => {
    const scenario = hub.state.scenarios.find(
      ({ index }) => index === appliedCreate.structuredContent.scenario_index,
    );
    requestedRuntime = scenario.data;
    scenario.data = `${requestedRuntime}\n// foreign edit`;
  };
  const appliedUpdate = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(appliedUpdate.structuredContent.status, "conflict");
  assert.equal(
    appliedUpdate.structuredContent.conflict_reason,
    "manual_change",
  );
  const writesAfterConflict = hub.requests.filter(
    ({ scenario }) => scenario?.create || scenario?.update,
  ).length;
  assert.equal(writesAfterConflict, writesAfterCreate + 1);
  const journalAfterConflict = JSON.parse(
    await readFile(nativeChangeJournalFile(stateDirectory, hub.url), "utf8"),
  );
  const updateId = update.structuredContent.change_ref.slice(
    "spruthub-change://native/".length,
  );
  assert.equal(
    "applied_snapshot" in journalAfterConflict.changes[updateId],
    false,
  );

  const scenario = hub.state.scenarios.find(
    ({ index }) => index === appliedCreate.structuredContent.scenario_index,
  );
  scenario.data = requestedRuntime;
  await inspectUnprovenLogicConflict(
    firstClient,
    update.structuredContent.change_ref,
    hub,
    writesAfterConflict,
    scenarioTarget,
  );

  await firstClient.close();
  const restarted = await startClient(t, hub, stateDirectory);
  const refusedAfterRestart = await inspectUnprovenLogicConflict(
    restarted,
    update.structuredContent.change_ref,
    hub,
    writesAfterConflict,
    scenarioTarget,
  );

  const contract = await restarted.callTool({
    name: refusedAfterRestart.structuredContent.next.tool,
    arguments: refusedAfterRestart.structuredContent.next.arguments,
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);

  const nextSource = secondLogicSource.replace("setValue(25)", "setValue(35)");
  const retried = await restarted.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_update",
      target_ref: scenarioTarget,
      source: nextSource,
      reason: "Новое разрешённое изменение после conflict без applied",
    },
  });
  assert.equal(retried.structuredContent.status, "prepared");
  const retriedApply = await restarted.callTool({
    name: "apply_native_change",
    arguments: { change_ref: retried.structuredContent.change_ref },
  });
  assert.equal(retriedApply.isError, undefined, retriedApply.content[0]?.text);
  assert.equal(retriedApply.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create || scenario?.update)
      .length,
    writesAfterConflict + 1,
  );

  const oldChange = await restarted.callTool({
    name: "get_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(oldChange.structuredContent.status, "conflict");
  assert.equal(oldChange.structuredContent.restore_supported, false);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create || scenario?.update)
      .length,
    writesAfterConflict + 1,
  );
});

test("BLOCK restore keeps a manual name change after apply without writing", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить защиту имени после apply",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  const writesAfterApply = hub.requests.filter(
    ({ scenario }) => scenario?.update,
  ).length;
  hub.state.scenarios[0].name = "Ручное имя после записи";

  const observed = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(observed.structuredContent.status, "conflict");
  assert.equal(observed.structuredContent.conflict_reason, "manual_change");
  assert.equal(observed.structuredContent.configuration_matches, false);

  const refused = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refused.structuredContent.status, "conflict");
  assert.equal(refused.structuredContent.conflict_reason, "manual_change");
  assert.equal(refused.structuredContent.configuration_matches, false);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    writesAfterApply,
  );
  assert.equal(hub.state.scenarios[0].name, "Ручное имя после записи");
});

test("window_option renames a BLOCK through its options window and restores after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const originalData = hub.state.scenarios[0].data;
  const before = await firstClient.callTool({
    name: "get_entity",
    arguments: { entity_ref: scenarioRef },
  });
  assert.equal(before.isError, undefined, before.content[0]?.text);
  assert.equal(before.structuredContent.entity.name, "Существующий BLOCK");
  assert.equal(
    before.structuredContent.entity.description,
    "Ручная конфигурация",
  );
  assert.equal(before.structuredContent.entity.execution_error, false);
  assert.equal(
    before.structuredContent.entity.options_window_ref,
    scenarioWindowRef,
  );
  const windowKey = decodeURIComponent(
    new URL(before.structuredContent.entity.options_window_ref).pathname
      .split("/")
      .at(-1),
  );
  assert.notEqual(windowKey, hub.state.scenarios[0].index);
  const nameOption = before.structuredContent.entity.metadata_options.find(
    ({ key }) => key === "Name",
  );
  assert.deepEqual(nameOption.native_change.next, {
    tool: "get_native_change_contract",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
    },
  });

  const nameContract = await firstClient.callTool({
    name: nameOption.native_change.next.tool,
    arguments: nameOption.native_change.next.arguments,
  });
  assert.equal(nameContract.isError, undefined, nameContract.content[0]?.text);
  assert.equal(nameContract.structuredContent.contract.input_type, "TEXT");
  assert.equal(nameContract.structuredContent.contract.kind, "stringValue");

  const renamed = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
      value: "Свет кабинета по движению",
      reason: "Переименовать правило без копирования data",
    },
  });
  assert.equal(renamed.isError, undefined, renamed.content[0]?.text);
  assert.equal(renamed.structuredContent.status, "prepared");
  assert.equal(renamed.structuredContent.target_ref, scenarioRef);
  assert.equal(renamed.structuredContent.window_ref, scenarioWindowRef);
  assert.deepEqual(renamed.structuredContent.diff.value, {
    from: "Существующий BLOCK",
    to: "Свет кабинета по движению",
    kind: "stringValue",
  });

  const appliedName = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: renamed.structuredContent.change_ref },
  });
  assert.equal(appliedName.isError, undefined, appliedName.content[0]?.text);
  assert.equal(appliedName.structuredContent.status, "applied");
  assert.equal(
    hub.requests.some(
      ({ scenario }) =>
        scenario?.update &&
        (Object.hasOwn(scenario.update, "name") ||
          Object.hasOwn(scenario.update, "desc")),
    ),
    false,
  );
  assert.deepEqual(windowUpdates(hub), [
    {
      window: {
        update: {
          windowKey,
          options: [
            {
              key: "Name",
              value: { stringValue: "Свет кабинета по движению" },
            },
          ],
        },
      },
    },
  ]);
  assert.equal(hub.state.scenarios[0].name, "Свет кабинета по движению");
  assert.equal(hub.state.scenarios[0].desc, "Ручная конфигурация");
  assert.equal(hub.state.scenarios[0].data, originalData);
  assert.equal(hub.state.scenarios[0].active, false);
  assert.equal(hub.state.scenarios[0].error, undefined);

  const cleared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Desc",
      value: "",
      reason: "Очистить пользовательское описание",
    },
  });
  assert.equal(cleared.isError, undefined, cleared.content[0]?.text);
  const appliedDesc = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: cleared.structuredContent.change_ref },
  });
  assert.equal(appliedDesc.isError, undefined, appliedDesc.content[0]?.text);
  assert.equal(appliedDesc.structuredContent.status, "applied");
  assert.equal(hub.state.scenarios[0].desc, "");
  assert.equal(hub.state.scenarios[0].data, originalData);
  assert.equal(windowUpdates(hub).at(-1).window.update.windowKey, windowKey);
  assert.deepEqual(windowUpdates(hub).at(-1).window.update.options, [
    { key: "Desc", value: { stringValue: "" } },
  ]);

  const after = await firstClient.callTool({
    name: "get_entity",
    arguments: { entity_ref: scenarioRef, include: ["configuration"] },
  });
  assert.equal(
    after.structuredContent.entity.name,
    "Свет кабинета по движению",
  );
  assert.equal(after.structuredContent.entity.description, "");
  assert.equal(after.structuredContent.entity.execution_error, false);
  assert.equal(
    after.structuredContent.entity.configuration.value.targets[0].then[1].time,
    60_000,
  );
  assert.equal(hub.state.scenarios[0].vendorTopLevel, "preserve-me");

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef },
  });
  assert.deepEqual(
    history.structuredContent.changes
      .map(({ change_ref }) => change_ref)
      .sort(),
    [
      renamed.structuredContent.change_ref,
      cleared.structuredContent.change_ref,
    ].sort(),
  );
  const windowHistory = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioWindowRef },
  });
  assert.equal(windowHistory.structuredContent.changes.length, 2);

  const restoredDesc = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: cleared.structuredContent.change_ref },
  });
  assert.equal(restoredDesc.structuredContent.status, "restored");
  assert.equal(hub.state.scenarios[0].desc, "Ручная конфигурация");
  assert.equal(hub.state.scenarios[0].name, "Свет кабинета по движению");
  const restoredName = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: renamed.structuredContent.change_ref },
  });
  assert.equal(restoredName.structuredContent.status, "restored");
  assert.equal(hub.state.scenarios[0].name, "Существующий BLOCK");
  assert.equal(hub.state.scenarios[0].desc, "Ручная конфигурация");
  assert.equal(hub.state.scenarios[0].data, originalData);
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.update),
    false,
  );
});

test("window_option renames a readable BLOCK whose data is damaged and leaves that data unsent", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const broken = JSON.parse(hub.state.scenarios[0].data);
  broken.targets[0].if.conditions[0].aId = 999;
  broken.targets[0].then[0].aId = 999;
  hub.state.scenarios[0].data = JSON.stringify(broken);
  hub.state.scenarios[0].error = true;
  const originalData = hub.state.scenarios[0].data;
  const client = await startClient(t, hub, stateDirectory);

  const dataOnly = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: broken,
      reason: "Не чинить неподдержанную форму этим срезом",
    },
  });
  assert.equal(dataOnly.isError, true);

  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
      value: "Требует ремонта",
      reason: "Только переименовать сломанное правило",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.update || scenario?.create),
    false,
  );
  assert.equal(hub.state.scenarios[0].name, "Требует ремонта");
  assert.equal(hub.state.scenarios[0].desc, "Ручная конфигурация");
  assert.equal(hub.state.scenarios[0].data, originalData);
  assert.equal(hub.state.scenarios[0].error, true);

  const entity = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: scenarioRef, include: ["configuration"] },
  });
  assert.equal(entity.structuredContent.entity.name, "Требует ремонта");
  assert.equal(entity.structuredContent.entity.execution_error, true);
  assert.equal(
    entity.structuredContent.entity.configuration.value.targets[0].if
      .conditions[0].aId,
    999,
  );

  hub.state.scenarios[0].data = "{not-json";
  const opaque = hub.state.scenarios[0].data;
  const invalidJson = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
      value: "Невалидный JSON",
      reason: "Переименовать при непрозрачном data",
    },
  });
  assert.equal(invalidJson.isError, undefined, invalidJson.content[0]?.text);
  const appliedInvalid = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: invalidJson.structuredContent.change_ref },
  });
  assert.equal(appliedInvalid.structuredContent.status, "applied");
  assert.equal(hub.state.scenarios[0].name, "Невалидный JSON");
  assert.equal(hub.state.scenarios[0].data, opaque);
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.update),
    false,
  );
});

test("block_data_update rejects metadata and flags before any write or journal entry", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const extras = [
    { name: "Новое имя" },
    { description: "Новое описание" },
    { name: "Новое имя", data: blockData({ delay: 45_000 }) },
    { active: true, data: blockData({ delay: 45_000 }) },
  ];
  for (const extra of extras) {
    const rejected = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_data_update",
        target_ref: scenarioRef,
        reason: "Не принимать metadata через data-only операцию",
        ...extra,
      },
    });
    assert.equal(rejected.isError, true, JSON.stringify(extra));
    assert.match(
      rejected.structuredContent.error.code,
      /unsupported_block_metadata|unsupported_block_flags/,
    );
    if (extra.name !== undefined || extra.description !== undefined) {
      assert.equal(
        rejected.structuredContent.next.tool,
        "get_native_change_contract",
      );
      assert.equal(
        rejected.structuredContent.next.arguments.operation,
        "window_option",
      );
      assert.equal(
        rejected.structuredContent.next.arguments.target_ref,
        scenarioRef,
      );
    }
  }
  assert.equal(
    hub.requests.some(
      ({ scenario, window }) =>
        scenario?.update || scenario?.create || window?.update,
    ),
    false,
  );
  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef },
  });
  assert.deepEqual(history.structuredContent.changes, []);
});

test("a lost BLOCK rename through window_option is recovered and a later manual rename is kept", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const originalData = hub.state.scenarios[0].data;
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
      value: "Свет по датчику",
      reason: "Переименовать без копирования data",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  hub.state.behavior.closeAfterWindowUpdate = true;
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, false);
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);
  assert.equal(hub.state.scenarios[0].name, "Свет по датчику");
  assert.equal(hub.state.scenarios[0].desc, "Ручная конфигурация");
  assert.equal(hub.state.scenarios[0].data, originalData);
  const writesAfterApply = windowUpdates(hub).length;

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef },
  });
  const persisted = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: history.structuredContent.changes[0].change_ref },
  });
  assert.equal(persisted.structuredContent.status, "applied");
  assert.equal(windowUpdates(hub).length, writesAfterApply);

  setScenarioMetadata(hub, {
    name: "Имя владельца",
    desc: "Описание владельца",
  });
  const refused = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refused.structuredContent.status, "conflict");
  assert.equal(refused.structuredContent.conflict_reason, "manual_change");
  assert.equal(windowUpdates(hub).length, writesAfterApply);
  assert.equal(hub.state.scenarios[0].name, "Имя владельца");
  assert.equal(hub.state.scenarios[0].desc, "Описание владельца");
  assert.equal(hub.state.scenarios[0].data, originalData);

  const retried = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
      value: "Свет по датчику",
      reason: "Новое разрешённое имя после ручной правки",
    },
  });
  assert.equal(retried.structuredContent.status, "prepared");
  const retriedApply = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: retried.structuredContent.change_ref },
  });
  assert.equal(retriedApply.structuredContent.status, "applied");
  assert.equal(hub.state.scenarios[0].name, "Свет по датчику");
  assert.equal(hub.state.scenarios[0].desc, "Описание владельца");
  assert.equal(hub.state.scenarios[0].data, originalData);
});

test("BLOCK description window_option keeps a proven marker and refuses a direct window bypass", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const createData = blockData();
  delete createData.vendorConfiguration;
  const created = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Свет по движению",
      description: "Старое назначение",
      active: false,
      on_start: false,
      sync: false,
      data: createData,
      reason: "Создать правило со служебным маркером",
    },
  });
  const appliedCreate = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(appliedCreate.structuredContent.status, "applied");
  const owned = hub.state.scenarios.find(
    ({ index }) => index === appliedCreate.structuredContent.scenario_index,
  );
  const marker = owned.desc.match(/\[sprut-agent:native:[a-f0-9]{24}\]/)?.[0];
  assert.equal(typeof marker, "string");
  assert.equal(owned.desc, `Старое назначение\n\n${marker}`);
  const ownedRef = appliedCreate.structuredContent.scenario_ref;
  const ownedWindowRef = `${homeRef}/window/${encodeURIComponent(owned.optionsWindow)}`;

  const renamed = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: ownedRef,
      option_key: "Desc",
      value: "Новое назначение",
      reason: "Сменить описание без копирования маркера",
    },
  });
  assert.equal(renamed.isError, undefined, renamed.content[0]?.text);
  const appliedRename = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: renamed.structuredContent.change_ref },
  });
  assert.equal(appliedRename.structuredContent.status, "applied");
  assert.equal(owned.desc, `Новое назначение\n\n${marker}`);
  assert.equal(
    windowUpdates(hub).at(-1).window.update.options[0].value.stringValue,
    `Новое назначение\n\n${marker}`,
  );

  const cleared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: ownedRef,
      option_key: "Desc",
      value: "",
      reason: "Очистить пользовательский текст и сохранить marker",
    },
  });
  const appliedClear = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: cleared.structuredContent.change_ref },
  });
  assert.equal(appliedClear.structuredContent.status, "applied");
  assert.equal(owned.desc, marker);

  const bypass = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: ownedWindowRef,
      option_key: "Desc",
      value: "Обход маркера",
      reason: "Прямой window-ref не должен обходить владельца",
    },
  });
  assert.equal(bypass.isError, true);
  assert.match(
    bypass.structuredContent.error.code,
    /unsupported_window_option|scenario_owner_required/,
  );
  assert.equal(bypass.structuredContent.next?.arguments?.target_ref, ownedRef);
  assert.equal(owned.desc, marker);

  setScenarioMetadata(hub, {
    desc: "Полезный текст\n\n[sprut-agent:native:aaaaaaaaaaaaaaaaaaaaaaaa]",
  });
  const foreign = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Desc",
      value: "Требует ремонта",
      reason: "Не присваивать чужой marker-подобный текст",
    },
  });
  const appliedForeign = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: foreign.structuredContent.change_ref },
  });
  assert.equal(appliedForeign.structuredContent.status, "applied");
  assert.equal(hub.state.scenarios[0].desc, "Требует ремонта");
  assert.equal(
    hub.state.scenarios[0].desc.includes("aaaaaaaaaaaaaaaaaaaaaaaa"),
    false,
  );
  const createRestore = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(createRestore.structuredContent.status, "conflict");
  assert.ok(
    hub.state.scenarios.some(
      ({ index }) => index === appliedCreate.structuredContent.scenario_index,
    ),
    "an index match after a later description edit must not restore create-delete rights",
  );
});

test("TEXT window_option without a verified scenario owner does not write Name", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const rejected = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioWindowRef,
      option_key: "Name",
      value: "Обход через окно",
      reason: "Не открывать TEXT без владельца-сценария",
    },
  });
  assert.equal(rejected.isError, true);
  assert.match(
    rejected.structuredContent.error.code,
    /unsupported_window_option|scenario_owner_required/,
  );
  assert.equal(
    rejected.structuredContent.next?.arguments?.operation,
    "window_option",
  );
  assert.equal(
    rejected.structuredContent.next?.arguments?.target_ref,
    scenarioRef,
  );
  assert.equal(hub.state.scenarios[0].name, "Существующий BLOCK");
  assert.equal(windowUpdates(hub).length, 0);
});

test("BLOCK metadata apply refuses a changed owner window without writing", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
      value: "После смены окна",
      reason: "Проверить связь scenario→optionsWindow",
    },
  });
  assert.equal(prepared.structuredContent.status, "prepared");
  hub.state.scenarios[0].optionsWindow = "opaque-scenario-window-other";
  const refused = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refused.structuredContent.status, "conflict");
  assert.match(
    refused.structuredContent.conflict_reason,
    /owner_window_changed|binding_changed|manual_change/,
  );
  assert.equal(hub.state.scenarios[0].name, "Существующий BLOCK");
  assert.equal(windowUpdates(hub).length, 0);
});

test("the first BLOCK rename is kept when the following description write is lost", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const renamed = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
      value: "Первое поле",
      reason: "Переименовать до сбоя второго поля",
    },
  });
  const appliedName = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: renamed.structuredContent.change_ref },
  });
  assert.equal(appliedName.structuredContent.status, "applied");
  const description = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Desc",
      value: "Второе поле",
      reason: "Описание, которое не должно примениться",
    },
  });
  hub.state.behavior.dropNextWindowUpdate = true;
  hub.state.behavior.closeAfterWindowUpdate = true;
  const lostDesc = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: description.structuredContent.change_ref },
  });
  assert.notEqual(lostDesc.structuredContent.status, "applied");
  assert.equal(hub.state.scenarios[0].name, "Первое поле");
  assert.equal(hub.state.scenarios[0].desc, "Ручная конфигурация");

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef },
  });
  assert.equal(
    history.structuredContent.changes.some(
      (change) => change.change_ref === renamed.structuredContent.change_ref,
    ),
    true,
  );
  const persistedName = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: renamed.structuredContent.change_ref },
  });
  assert.equal(persistedName.structuredContent.status, "applied");
  assert.equal(hub.state.scenarios[0].name, "Первое поле");
  assert.equal(hub.state.scenarios[0].desc, "Ручная конфигурация");
});

test("BLOCK Name and Desc prepared together restore independently", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const originalData = hub.state.scenarios[0].data;
  const originalActive = hub.state.scenarios[0].active;
  const { nameRef, descRef } = await prepareBlockNameAndDesc(firstClient, {
    name: "Свет кабинета по движению",
    desc: "Новое назначение",
    nameReason: "Переименовать на исходной конфигурации",
    descReason: "Описать на той же исходной конфигурации",
  });

  const appliedName = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: nameRef },
  });
  assert.equal(appliedName.structuredContent.status, "applied");
  const appliedDesc = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: descRef },
  });
  assert.equal(appliedDesc.structuredContent.status, "applied");
  assert.equal(hub.state.scenarios[0].name, "Свет кабинета по движению");
  assert.equal(hub.state.scenarios[0].desc, "Новое назначение");
  assert.equal(hub.state.scenarios[0].data, originalData);
  assert.equal(hub.state.scenarios[0].active, originalActive);
  const writesAfterApply = windowUpdates(hub).length;
  assert.equal(writesAfterApply, 2);

  const restoredName = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: nameRef },
  });
  assert.equal(restoredName.structuredContent.status, "restored");
  assert.equal(hub.state.scenarios[0].name, "Существующий BLOCK");
  assert.equal(hub.state.scenarios[0].desc, "Новое назначение");
  assert.equal(hub.state.scenarios[0].data, originalData);
  assert.equal(windowUpdates(hub).length, writesAfterApply + 1);
  assert.deepEqual(windowUpdates(hub).at(-1).window.update.options, [
    { key: "Name", value: { stringValue: "Существующий BLOCK" } },
  ]);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const restoredDesc = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: descRef },
  });
  assert.equal(restoredDesc.structuredContent.status, "restored");
  assert.equal(hub.state.scenarios[0].name, "Существующий BLOCK");
  assert.equal(hub.state.scenarios[0].desc, "Ручная конфигурация");
  assert.equal(hub.state.scenarios[0].data, originalData);
  assert.equal(hub.state.scenarios[0].active, originalActive);
  assert.equal(windowUpdates(hub).length, writesAfterApply + 2);
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.update),
    false,
  );
});

test("BLOCK metadata restore keeps a later data and flag edit of the same scenario", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
      value: "После паузы",
      reason: "Вернуть имя, не трогая позднюю правку data",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  const writesAfterApply = windowUpdates(hub).length;
  const edited = JSON.parse(hub.state.scenarios[0].data);
  edited.targets[0].then[1].time = 12_000;
  hub.state.scenarios[0].data = JSON.stringify(edited);
  hub.state.scenarios[0].active = true;
  hub.state.scenarios[0].onStart = true;
  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(hub.state.scenarios[0].name, "Существующий BLOCK");
  assert.equal(
    JSON.parse(hub.state.scenarios[0].data).targets[0].then[1].time,
    12_000,
  );
  assert.equal(hub.state.scenarios[0].active, true);
  assert.equal(hub.state.scenarios[0].onStart, true);
  assert.equal(windowUpdates(hub).length, writesAfterApply + 1);
  assert.deepEqual(windowUpdates(hub).at(-1).window.update.options, [
    { key: "Name", value: { stringValue: "Существующий BLOCK" } },
  ]);
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.update),
    false,
  );
});

test("an observed BLOCK name change stays unrestorable after the value matches again", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
      value: "Свет по датчику",
      reason: "Переименовать до ручной правки имени",
    },
  });
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  const writesAfterApply = windowUpdates(hub).length;
  setScenarioMetadata(hub, { name: "Имя владельца" });

  const observed = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(observed.structuredContent.status, "conflict");
  assert.equal(
    observed.structuredContent.conflict_reason,
    "value_changed_after_apply",
  );
  assert.equal(observed.structuredContent.manual_change_observed, true);

  setScenarioMetadata(hub, { name: "Свет по датчику" });
  const refused = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refused.structuredContent.status, "conflict");
  assert.equal(refused.structuredContent.conflict_reason, "manual_change");
  assert.equal(refused.structuredContent.manual_change_observed, true);
  assert.equal(windowUpdates(hub).length, writesAfterApply);
  assert.equal(hub.state.scenarios[0].name, "Свет по датчику");

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const afterRestart = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(afterRestart.structuredContent.status, "conflict");
  assert.equal(afterRestart.structuredContent.manual_change_observed, true);
  const refusedAfterRestart = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refusedAfterRestart.structuredContent.status, "conflict");
  assert.equal(
    refusedAfterRestart.structuredContent.manual_change_observed,
    true,
  );
  assert.equal(windowUpdates(hub).length, writesAfterApply);
});

test("a restored native value stays closed after get and a later requested match", async (t) => {
  for (const example of [
    {
      name: "BLOCK Name",
      setup(hub) {
        return hub;
      },
      prepare: {
        operation: "window_option",
        target_ref: scenarioRef,
        option_key: "Name",
        value: "Свет по датчику",
        reason: "Переименовать, затем вернуть исходное имя",
      },
      readCurrent(hub) {
        return hub.state.scenarios[0].name;
      },
      setCurrent(hub, value) {
        setScenarioMetadata(hub, { name: value });
      },
      requested: "Свет по датчику",
      baseline: "Существующий BLOCK",
      writes: windowUpdates,
    },
    {
      name: "TargetTemperature",
      setup: installClimateFixture,
      prepare: {
        operation: "characteristic_value",
        target_ref: climateSettings[0].ref,
        value: climateSettings[0].requested,
        reason: "Сменить уставку, затем вернуть исходную",
      },
      readCurrent(hub) {
        return currentCharacteristicValue(hub, climateSettings[0].ref)
          .doubleValue;
      },
      setCurrent(hub, value) {
        currentCharacteristicValue(hub, climateSettings[0].ref).doubleValue =
          value;
      },
      requested: climateSettings[0].requested,
      baseline: climateSettings[0].baseline,
      writes: characteristicUpdates,
    },
  ]) {
    await t.test(example.name, async (scenario) => {
      const { hub, stateDirectory } = await setup(scenario);
      example.setup(hub);
      const firstClient = await startClient(scenario, hub, stateDirectory);
      const prepared = await firstClient.callTool({
        name: "prepare_native_change",
        arguments: example.prepare,
      });
      const applied = await firstClient.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(applied.structuredContent.status, "applied");
      const restored = await firstClient.callTool({
        name: "restore_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(restored.structuredContent.status, "restored");
      const writesAfterRestore = example.writes(hub).length;

      const observed = await firstClient.callTool({
        name: "get_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(observed.structuredContent.status, "restored");
      assert.equal(
        observed.structuredContent.manual_change_observed,
        undefined,
      );
      assert.equal(example.readCurrent(hub), example.baseline);

      example.setCurrent(hub, example.requested);
      const afterManual = await firstClient.callTool({
        name: "get_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(afterManual.structuredContent.status, "restored");
      assert.equal(
        afterManual.structuredContent.manual_change_observed,
        undefined,
      );
      const refusedApply = await firstClient.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(refusedApply.structuredContent.status, "restored");
      const refusedRestore = await firstClient.callTool({
        name: "restore_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(refusedRestore.structuredContent.status, "restored");
      assert.equal(example.readCurrent(hub), example.requested);
      assert.equal(example.writes(hub).length, writesAfterRestore);

      await firstClient.close();
      const secondClient = await startClient(scenario, hub, stateDirectory);
      const afterRestart = await secondClient.callTool({
        name: "get_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(afterRestart.structuredContent.status, "restored");
      const refusedApplyAfterRestart = await secondClient.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(
        refusedApplyAfterRestart.structuredContent.status,
        "restored",
      );
      const refusedRestoreAfterRestart = await secondClient.callTool({
        name: "restore_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(
        refusedRestoreAfterRestart.structuredContent.status,
        "restored",
      );
      assert.equal(example.readCurrent(hub), example.requested);
      assert.equal(example.writes(hub).length, writesAfterRestore);
    });
  }
});

test("a fresh read error does not reopen a restored native value", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
      value: "Свет по датчику",
      reason: "Вернуть имя, затем проверить ошибку чтения",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  const writesAfterRestore = windowUpdates(hub).length;
  hub.state.behavior.failNextWindowGet = true;
  const unreadable = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(unreadable.structuredContent.status, "restored");
  assert.equal(unreadable.structuredContent.verification.fresh, false);
  assert.equal(unreadable.structuredContent.manual_change_observed, undefined);
  const refusedApply = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refusedApply.structuredContent.status, "restored");
  assert.equal(windowUpdates(hub).length, writesAfterRestore);
  assert.equal(hub.state.scenarios[0].name, "Существующий BLOCK");
});

test("pending BLOCK metadata does not complete from an old window after the owner binding changes", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
      value: "Свет по датчику",
      reason: "Переименовать до смены optionsWindow",
    },
  });
  hub.state.behavior.failWindowGetAfterUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.write_intent.direction, "apply");
  assert.equal(hub.state.scenarios[0].name, "Свет по датчику");
  const writesAfterUncertain = windowUpdates(hub).length;
  const movedWindowKey = "opaque-scenario-window-other";
  hub.state.scenarios[0].optionsWindow = movedWindowKey;
  hub.state.windows[movedWindowKey] = scenarioOptionsWindow({
    name: "Существующий BLOCK",
    desc: "Ручная конфигурация",
    windowKey: movedWindowKey,
  });

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const observed = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.notEqual(observed.structuredContent.status, "applied");
  assert.notEqual(observed.structuredContent.status, "restored");
  assert.equal(
    observed.structuredContent.conflict_reason,
    "owner_window_changed",
  );
  const refusedRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.notEqual(refusedRestore.structuredContent.status, "restored");
  assert.equal(windowUpdates(hub).length, writesAfterUncertain);
});

test("an observed deleted BLOCK create marker does not claim a later scenario at the same index", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const createData = blockData();
  delete createData.vendorConfiguration;
  const created = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Свет по движению",
      description: "Старое назначение",
      active: false,
      on_start: false,
      sync: false,
      data: createData,
      reason: "Создать правило, которое владелец удалит вручную",
    },
  });
  const appliedCreate = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(appliedCreate.structuredContent.status, "applied");
  const ownedIndex = appliedCreate.structuredContent.scenario_index;
  const owned = hub.state.scenarios.find(({ index }) => index === ownedIndex);
  const marker = owned.desc.match(/\[sprut-agent:native:[a-f0-9]{24}\]/)?.[0];
  assert.equal(typeof marker, "string");
  const ownedWindowKey = owned.optionsWindow;
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== ownedIndex,
  );
  delete hub.state.windows[ownedWindowKey];

  const observedDelete = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(observedDelete.structuredContent.status, "conflict");
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === ownedIndex),
    false,
  );

  const resurrectedWindowKey = "opaque-deleted-copied-marker-window";
  hub.state.scenarios.push({
    index: ownedIndex,
    name: "Чужой сценарий",
    desc: `Скопированный текст\n\n${marker}`,
    active: false,
    onStart: false,
    sync: false,
    type: "BLOCK",
    optionsWindow: resurrectedWindowKey,
    data: JSON.stringify(createData),
    predefined: false,
  });
  hub.state.windows[resurrectedWindowKey] = scenarioOptionsWindow({
    name: "Чужой сценарий",
    desc: `Скопированный текст\n\n${marker}`,
    windowKey: resurrectedWindowKey,
  });
  const cleared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: appliedCreate.structuredContent.scenario_ref,
      option_key: "Desc",
      value: "",
      reason: "Очистить описание после наблюдённого удаления владельца",
    },
  });
  assert.equal(cleared.isError, undefined, cleared.content[0]?.text);
  const appliedClear = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: cleared.structuredContent.change_ref },
  });
  assert.equal(appliedClear.structuredContent.status, "applied");
  const resurrected = hub.state.scenarios.find(
    ({ index }) => index === ownedIndex,
  );
  assert.equal(resurrected.desc, "");
  assert.equal(resurrected.desc.includes(marker.slice(1, -1)), false);
  assert.deepEqual(windowUpdates(hub).at(-1).window.update.options, [
    { key: "Desc", value: { stringValue: "" } },
  ]);
});

test("an observed deleted BLOCK create does not delete a later exact copy at the same index", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const createData = blockData();
  delete createData.vendorConfiguration;
  const created = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Свет по движению",
      description: "Старое назначение",
      active: false,
      on_start: false,
      sync: false,
      data: createData,
      reason: "Создать правило, которое владелец удалит и заменит копией",
    },
  });
  const appliedCreate = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(appliedCreate.structuredContent.status, "applied");
  const ownedIndex = appliedCreate.structuredContent.scenario_index;
  const owned = hub.state.scenarios.find(({ index }) => index === ownedIndex);
  const snapshot = structuredClone(owned);
  const windowSnapshot = structuredClone(
    hub.state.windows[owned.optionsWindow],
  );
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== ownedIndex,
  );
  delete hub.state.windows[owned.optionsWindow];

  const observedDelete = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(observedDelete.structuredContent.status, "conflict");
  const deletesAfterAbsence = scenarioDeletes(hub).length;

  hub.state.scenarios.push(snapshot);
  hub.state.windows[snapshot.optionsWindow] = windowSnapshot;
  const observedCopy = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(observedCopy.structuredContent.status, "applied");
  const refusedRestore = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(refusedRestore.structuredContent.status, "restored");
  assert.equal(scenarioDeletes(hub).length, deletesAfterAbsence);
  const copy = hub.state.scenarios.find(({ index }) => index === ownedIndex);
  assert.equal(copy.name, snapshot.name);
  assert.equal(copy.desc, snapshot.desc);
  assert.equal(copy.data, snapshot.data);
});

test("restore of a deleted BLOCK create does not delete a later exact copy at the same index", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const createData = blockData();
  delete createData.vendorConfiguration;
  const created = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Свет по движению",
      description: "Старое назначение",
      active: false,
      on_start: false,
      sync: false,
      data: createData,
      reason: "Создать правило, которое владелец удалит до restore",
    },
  });
  const appliedCreate = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(appliedCreate.structuredContent.status, "applied");
  const ownedIndex = appliedCreate.structuredContent.scenario_index;
  const owned = hub.state.scenarios.find(({ index }) => index === ownedIndex);
  const marker = owned.desc.match(/\[sprut-agent:native:[a-f0-9]{24}\]/)?.[0];
  assert.equal(typeof marker, "string");
  const snapshot = structuredClone(owned);
  const windowSnapshot = structuredClone(
    hub.state.windows[owned.optionsWindow],
  );
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== ownedIndex,
  );
  delete hub.state.windows[owned.optionsWindow];
  const deletesBeforeRestore = scenarioDeletes(hub).length;

  const observedRestore = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(observedRestore.structuredContent.status, "conflict");
  assert.equal(observedRestore.structuredContent.restore_supported, false);
  assert.equal(scenarioDeletes(hub).length, deletesBeforeRestore);

  hub.state.scenarios.push(snapshot);
  hub.state.windows[snapshot.optionsWindow] = windowSnapshot;
  const observedCopy = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(observedCopy.structuredContent.status, "applied");
  assert.equal(observedCopy.structuredContent.restore_supported, false);
  const refusedApply = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(refusedApply.structuredContent.status, "applied");
  assert.equal(refusedApply.structuredContent.restore_supported, false);
  const refusedRestore = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(refusedRestore.structuredContent.status, "restored");
  assert.equal(refusedRestore.structuredContent.restore_supported, false);
  assert.equal(scenarioDeletes(hub).length, deletesBeforeRestore);
  const copy = hub.state.scenarios.find(({ index }) => index === ownedIndex);
  assert.equal(copy.desc, snapshot.desc);

  const cleared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: appliedCreate.structuredContent.scenario_ref,
      option_key: "Desc",
      value: "",
      reason: "Не присваивать marker create, право которого утрачено",
    },
  });
  const appliedClear = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: cleared.structuredContent.change_ref },
  });
  assert.equal(appliedClear.structuredContent.status, "applied");
  assert.equal(copy.desc, "");
  assert.equal(copy.desc.includes(marker.slice(1, -1)), false);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const afterRestart = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(afterRestart.structuredContent.status, "applied");
  assert.equal(afterRestart.structuredContent.restore_supported, false);
  const restoreAfterRestart = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(restoreAfterRestart.structuredContent.status, "restored");
  assert.equal(scenarioDeletes(hub).length, deletesBeforeRestore);
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === ownedIndex),
    true,
  );
});

test("a marker copy at another index does not hide observed absence of a proven BLOCK create", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const createData = blockData();
  delete createData.vendorConfiguration;
  const created = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Свет по движению",
      description: "Старое назначение",
      active: false,
      on_start: false,
      sync: false,
      data: createData,
      reason: "Создать правило, копию которого сохранят под другим index",
    },
  });
  const appliedCreate = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(appliedCreate.structuredContent.status, "applied");
  const ownedIndex = appliedCreate.structuredContent.scenario_index;
  const owned = hub.state.scenarios.find(({ index }) => index === ownedIndex);
  const snapshot = structuredClone(owned);
  const windowSnapshot = structuredClone(
    hub.state.windows[owned.optionsWindow],
  );
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== ownedIndex,
  );
  delete hub.state.windows[owned.optionsWindow];
  const otherIndex = "copied-elsewhere";
  const otherWindowKey = "opaque-copied-elsewhere-window";
  hub.state.scenarios.push({
    ...structuredClone(snapshot),
    index: otherIndex,
    optionsWindow: otherWindowKey,
  });
  hub.state.windows[otherWindowKey] = scenarioOptionsWindow({
    name: snapshot.name,
    desc: snapshot.desc,
    windowKey: otherWindowKey,
  });
  const deletesBeforeObservation = scenarioDeletes(hub).length;

  const observedOther = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(observedOther.structuredContent.status, "conflict");
  assert.equal(observedOther.structuredContent.restore_supported, false);
  const refusedApply = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(refusedApply.structuredContent.status, "conflict");
  assert.equal(refusedApply.structuredContent.restore_supported, false);
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === otherIndex),
    true,
  );

  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== otherIndex,
  );
  delete hub.state.windows[otherWindowKey];
  hub.state.scenarios.push(snapshot);
  hub.state.windows[snapshot.optionsWindow] = windowSnapshot;
  const observedCopy = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(observedCopy.structuredContent.status, "applied");
  assert.equal(observedCopy.structuredContent.restore_supported, false);
  const refusedRestore = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(refusedRestore.structuredContent.status, "restored");
  assert.equal(scenarioDeletes(hub).length, deletesBeforeObservation);
  const copy = hub.state.scenarios.find(({ index }) => index === ownedIndex);
  assert.equal(copy.name, snapshot.name);
  assert.equal(copy.desc, snapshot.desc);
  assert.equal(copy.data, snapshot.data);
});

test("an observed deleted LOGIC create does not delete a later exact copy at the same index", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const created = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Яркость при включении",
      description: "Установить стартовый уровень один раз",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Создать LOGIC, который владелец удалит и заменит копией",
    },
  });
  const appliedCreate = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(appliedCreate.structuredContent.status, "applied");
  const ownedIndex = appliedCreate.structuredContent.scenario_index;
  const owned = hub.state.scenarios.find(({ index }) => index === ownedIndex);
  const snapshot = structuredClone(owned);
  const logicType = hub.state.scenarioLogicTypes[ownedIndex];
  const logicTypeSnapshot = structuredClone(
    hub.state.logicTypes.find(({ type }) => type === logicType),
  );
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== ownedIndex,
  );
  delete hub.state.scenarioLogicTypes[ownedIndex];
  hub.state.logicTypes = hub.state.logicTypes.filter(
    ({ type }) => type !== logicType,
  );
  const deletesBeforeRestore = scenarioDeletes(hub).length;

  const observedRestore = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(observedRestore.structuredContent.status, "conflict");
  assert.equal(observedRestore.structuredContent.restore_supported, false);
  assert.equal(scenarioDeletes(hub).length, deletesBeforeRestore);

  hub.state.scenarios.push(snapshot);
  hub.state.scenarioLogicTypes[ownedIndex] = logicType;
  hub.state.logicTypes.push(logicTypeSnapshot);
  const observedCopy = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(observedCopy.structuredContent.status, "applied");
  assert.equal(observedCopy.structuredContent.restore_supported, false);
  const refusedRestore = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(refusedRestore.structuredContent.status, "restored");
  assert.equal(refusedRestore.structuredContent.restore_supported, false);
  assert.equal(scenarioDeletes(hub).length, deletesBeforeRestore);
  const copy = hub.state.scenarios.find(({ index }) => index === ownedIndex);
  assert.equal(copy.data, snapshot.data);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const afterRestart = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(afterRestart.structuredContent.status, "applied");
  assert.equal(afterRestart.structuredContent.restore_supported, false);
  const restoreAfterRestart = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.notEqual(restoreAfterRestart.structuredContent.status, "restored");
  assert.equal(scenarioDeletes(hub).length, deletesBeforeRestore);
});

test("an unsaved absence observation does not claim lasting delete protection", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const createData = blockData();
  delete createData.vendorConfiguration;
  const created = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Свет по движению",
      description: "Старое назначение",
      active: false,
      on_start: false,
      sync: false,
      data: createData,
      reason: "Создать правило, чьё отсутствие не удастся сохранить",
    },
  });
  const appliedCreate = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  const ownedIndex = appliedCreate.structuredContent.scenario_index;
  const owned = hub.state.scenarios.find(({ index }) => index === ownedIndex);
  const snapshot = structuredClone(owned);
  const windowSnapshot = structuredClone(
    hub.state.windows[owned.optionsWindow],
  );
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== ownedIndex,
  );
  delete hub.state.windows[owned.optionsWindow];
  t.after(async () => {
    await chmod(stateDirectory, 0o700).catch(() => {});
  });
  await chmod(stateDirectory, 0o555);
  const deletesBeforeRestore = scenarioDeletes(hub).length;

  const unsaved = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(unsaved.structuredContent.status, "conflict");
  assert.equal(unsaved.structuredContent.restore_supported, false);
  assert.deepEqual(unsaved.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_native_change",
  });
  assert.equal(scenarioDeletes(hub).length, deletesBeforeRestore);

  await chmod(stateDirectory, 0o700);
  await client.close();
  hub.state.scenarios.push(snapshot);
  hub.state.windows[snapshot.optionsWindow] = windowSnapshot;
  const secondClient = await startClient(t, hub, stateDirectory);
  const afterRestart = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(afterRestart.structuredContent.status, "applied");
});

test("BLOCK description keeps a proven marker after a later data edit of the same create", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const createData = blockData();
  delete createData.vendorConfiguration;
  const created = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Свет по движению",
      description: "Старое назначение",
      active: false,
      on_start: false,
      sync: false,
      data: createData,
      reason: "Создать правило, чью data потом изменят",
    },
  });
  const appliedCreate = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(appliedCreate.structuredContent.status, "applied");
  const owned = hub.state.scenarios.find(
    ({ index }) => index === appliedCreate.structuredContent.scenario_index,
  );
  const marker = owned.desc.match(/\[sprut-agent:native:[a-f0-9]{24}\]/)?.[0];
  assert.equal(typeof marker, "string");
  const edited = JSON.parse(owned.data);
  edited.targets[0].then[1].time = 12_000;
  owned.data = JSON.stringify(edited);
  const observed = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(observed.structuredContent.status, "conflict");
  const cleared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: appliedCreate.structuredContent.scenario_ref,
      option_key: "Desc",
      value: "",
      reason: "Обычный conflict create не прекращает marker",
    },
  });
  const appliedClear = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: cleared.structuredContent.change_ref },
  });
  assert.equal(appliedClear.structuredContent.status, "applied");
  assert.equal(owned.desc, marker);
});

test("TEXT Name on a device window is ordinary unsupported TEXT, not a fictional BLOCK owner", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.window.options.push({
    key: "Name",
    name: "Подпись устройства",
    type: "GenericString",
    inputType: "TEXT",
    read: true,
    write: true,
    disabled: false,
    value: { stringValue: "Устройство" },
  });
  const client = await startClient(t, hub, stateDirectory);
  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: "Name",
    },
  });
  assert.equal(contract.isError, true);
  assert.equal(
    contract.structuredContent.error.code,
    "unsupported_window_option",
  );
  assert.equal(contract.structuredContent.next, undefined);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: "Name",
      value: "Не выдумывать BLOCK",
      reason: "TEXT Name устройства не является metadata сценария",
    },
  });
  assert.equal(prepared.isError, true);
  assert.equal(
    prepared.structuredContent.error.code,
    "unsupported_window_option",
  );
  assert.equal(prepared.structuredContent.next, undefined);
  assert.match(
    prepared.content[0]?.text ?? "",
    /NUMBER, CHECKBOX, and LIST|unsupported_window_option/,
  );
  assert.equal(windowUpdates(hub).length, 0);
  assert.equal(
    hub.state.window.options.find(({ key }) => key === "Name").value
      .stringValue,
    "Устройство",
  );
});

test("a restored BLOCK create marker does not claim a later scenario at the same index", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const createData = blockData();
  delete createData.vendorConfiguration;
  const created = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Свет по движению",
      description: "Старое назначение",
      active: false,
      on_start: false,
      sync: false,
      data: createData,
      reason: "Создать правило со служебным маркером",
    },
  });
  const appliedCreate = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(appliedCreate.structuredContent.status, "applied");
  const owned = hub.state.scenarios.find(
    ({ index }) => index === appliedCreate.structuredContent.scenario_index,
  );
  const marker = owned.desc.match(/\[sprut-agent:native:[a-f0-9]{24}\]/)?.[0];
  assert.equal(typeof marker, "string");
  const restoredCreate = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: created.structuredContent.change_ref },
  });
  assert.equal(restoredCreate.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(
      ({ index }) => index === appliedCreate.structuredContent.scenario_index,
    ),
    false,
  );

  const resurrectedWindowKey = "opaque-copied-marker-window";
  hub.state.scenarios.push({
    index: appliedCreate.structuredContent.scenario_index,
    name: "Чужой сценарий",
    desc: `Скопированный текст\n\n${marker}`,
    active: false,
    onStart: false,
    sync: false,
    type: "BLOCK",
    optionsWindow: resurrectedWindowKey,
    data: JSON.stringify(createData),
    predefined: false,
  });
  hub.state.windows[resurrectedWindowKey] = scenarioOptionsWindow({
    name: "Чужой сценарий",
    desc: `Скопированный текст\n\n${marker}`,
    windowKey: resurrectedWindowKey,
  });
  const resurrectedRef = appliedCreate.structuredContent.scenario_ref;
  const cleared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: resurrectedRef,
      option_key: "Desc",
      value: "",
      reason: "Очистить описание чужого сценария с скопированным token",
    },
  });
  assert.equal(cleared.isError, undefined, cleared.content[0]?.text);
  const appliedClear = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: cleared.structuredContent.change_ref },
  });
  assert.equal(appliedClear.structuredContent.status, "applied");
  const resurrected = hub.state.scenarios.find(
    ({ index }) => index === appliedCreate.structuredContent.scenario_index,
  );
  assert.equal(resurrected.desc, "");
  assert.equal(resurrected.desc.includes(marker.slice(1, -1)), false);
  assert.deepEqual(windowUpdates(hub).at(-1).window.update.options, [
    { key: "Desc", value: { stringValue: "" } },
  ]);
});

test("get_entity does not offer BLOCK Name and Desc writes on a LOGIC scenario", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const logicWindowKey = "opaque-logic-window";
  hub.state.scenarios.push({
    index: "existing-logic",
    name: "LOGIC сценарий",
    desc: "Не BLOCK",
    active: false,
    onStart: false,
    sync: false,
    type: "LOGIC",
    optionsWindow: logicWindowKey,
    data: firstLogicSource,
    predefined: false,
  });
  hub.state.windows[logicWindowKey] = scenarioOptionsWindow({
    name: "LOGIC сценарий",
    desc: "Не BLOCK",
    windowKey: logicWindowKey,
  });
  const client = await startClient(t, hub, stateDirectory);
  const logicRef = `${homeRef}/scenario/existing-logic`;
  const logicEntity = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: logicRef },
  });
  assert.equal(logicEntity.isError, undefined, logicEntity.content[0]?.text);
  assert.equal(logicEntity.structuredContent.entity.type, "LOGIC");
  assert.equal(
    logicEntity.structuredContent.entity.options_window_ref,
    undefined,
  );
  assert.equal(
    logicEntity.structuredContent.entity.metadata_options?.some(
      (option) => option.native_change?.supported === true,
    ) ?? false,
    false,
  );
  const rejected = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: logicRef,
      option_key: "Name",
      value: "Не расширять LOGIC",
      reason: "LOGIC metadata не входит в этот срез",
    },
  });
  assert.equal(rejected.isError, true);
  assert.equal(
    rejected.structuredContent.error.code,
    "unsupported_scenario_type",
  );
  assert.equal(windowUpdates(hub).length, 0);

  const blockEntity = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: scenarioRef },
  });
  assert.equal(
    blockEntity.structuredContent.entity.options_window_ref,
    scenarioWindowRef,
  );
  const nameOption = blockEntity.structuredContent.entity.metadata_options.find(
    ({ key }) => key === "Name",
  );
  assert.equal(nameOption.native_change.supported, true);
  assert.deepEqual(nameOption.native_change.next, {
    tool: "get_native_change_contract",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef,
      option_key: "Name",
    },
  });
});

test("a device NUMBER option named Name remains a writable window_option", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.window.options.push(
    {
      key: "Name",
      name: "Канал",
      type: "GenericInteger",
      inputType: "NUMBER",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: 3 },
      minValue: 0,
      maxValue: 10,
      minStep: 1,
    },
    {
      key: "Desc",
      name: "Подсветка",
      type: "GenericBoolean",
      inputType: "CHECKBOX",
      read: true,
      write: true,
      disabled: false,
      value: { boolValue: false },
    },
  );
  const client = await startClient(t, hub, stateDirectory);
  const nameContract = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: "Name",
    },
  });
  assert.equal(nameContract.isError, undefined, nameContract.content[0]?.text);
  assert.equal(nameContract.structuredContent.contract.input_type, "NUMBER");
  const renamed = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: "Name",
      value: 7,
      reason: "Записать NUMBER, ключ которого совпал с именем сценария",
    },
  });
  assert.equal(renamed.isError, undefined, renamed.content[0]?.text);
  const appliedName = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: renamed.structuredContent.change_ref },
  });
  assert.equal(appliedName.structuredContent.status, "applied");
  assert.equal(
    hub.state.window.options.find(({ key }) => key === "Name").value.intValue,
    7,
  );

  const descContract = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: "Desc",
    },
  });
  assert.equal(descContract.isError, undefined, descContract.content[0]?.text);
  assert.equal(descContract.structuredContent.contract.input_type, "CHECKBOX");
  const described = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: "Desc",
      value: true,
      reason: "Записать CHECKBOX, ключ которого совпал с описанием сценария",
    },
  });
  const appliedDesc = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: described.structuredContent.change_ref },
  });
  assert.equal(appliedDesc.structuredContent.status, "applied");
  assert.equal(
    hub.state.window.options.find(({ key }) => key === "Desc").value.boolValue,
    true,
  );
  const restoredDesc = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: described.structuredContent.change_ref },
  });
  assert.equal(restoredDesc.structuredContent.status, "restored");
  const restoredName = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: renamed.structuredContent.change_ref },
  });
  assert.equal(restoredName.structuredContent.status, "restored");
  assert.equal(
    hub.state.window.options.find(({ key }) => key === "Name").value.intValue,
    3,
  );
  assert.equal(
    hub.state.window.options.find(({ key }) => key === "Desc").value.boolValue,
    false,
  );
  assert.equal(
    hub.requests.some(
      ({ scenario }) =>
        scenario?.update || scenario?.create || scenario?.delete,
    ),
    false,
  );

  const textBypass = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: scenarioWindowRef,
      option_key: "Name",
      value: "Обход через окно",
      reason: "TEXT Name по-прежнему только через владельца",
    },
  });
  assert.equal(textBypass.isError, true);
  assert.equal(
    textBypass.structuredContent.error.code,
    "scenario_owner_required",
  );
});

test("restore preserves unknown vendor blockId and state fields", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const baseline = blockData();
  baseline.vendorConfiguration = {
    type: "if",
    blockId: "vendor-baseline",
    state: "configured",
  };
  hub.state.scenarios[0].data = JSON.stringify(baseline);
  const requested = structuredClone(baseline);
  requested.targets[0].then[1].time = 45_000;
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requested,
      reason: "Сохранить vendor configuration",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  const manuallyEdited = JSON.parse(hub.state.scenarios[0].data);
  manuallyEdited.vendorConfiguration.blockId = "manual-change";
  manuallyEdited.vendorConfiguration.state = "manual-state";
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);

  const refused = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refused.structuredContent.status, "conflict");
  assert.equal(refused.structuredContent.configuration_matches, false);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
  assert.equal(
    JSON.parse(hub.state.scenarios[0].data).vendorConfiguration.blockId,
    "manual-change",
  );
});

test("BLOCK data restore revalidates current bindings before send", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить topology drift перед restore",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.accessories[1].services[0].type = "Outlet";

  const refused = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refused.isError, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
});

test("a restored BLOCK change is terminal and recovers a lost final save", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Временный BLOCK",
      description: "Проверить восстановление журнала",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить терминальный restore",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  let restoreStateDirectory;
  hub.state.behavior.afterDelete = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const restoredWithoutSave = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restoredWithoutSave.structuredContent.status, "restored");
  assert.deepEqual(restoredWithoutSave.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_native_change",
  });
  assert.equal(
    restoredWithoutSave.structuredContent.write_intent.direction,
    "restore",
  );
  assert.equal(
    restoredWithoutSave.structuredContent.write_intent.acknowledged,
    true,
  );
  await firstClient.close();
  await restoreStateDirectory();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const repeatedApply = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const repeatedRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "restored");
  assert.equal(recovered.structuredContent.native_acknowledged, false);
  assert.equal(recovered.structuredContent.write_intent.direction, "restore");
  assert.equal(recovered.structuredContent.write_intent.phase, "reconciled");
  assert.equal(repeatedApply.structuredContent.status, "restored");
  assert.equal(repeatedRestore.structuredContent.status, "restored");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
});

test("BLOCK create recovers when its applied result cannot be saved", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "BLOCK с потерянным journal save",
      description: "Восстановить результат после рестарта",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить create recovery",
    },
  });
  let restoreStateDirectory;
  hub.state.behavior.afterCreate = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const appliedWithoutSave = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(appliedWithoutSave.structuredContent.status, "applied");
  assert.deepEqual(appliedWithoutSave.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_native_change",
  });
  await firstClient.close();
  await restoreStateDirectory();

  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: {
      home_ref: homeRef,
      entity_ref: appliedWithoutSave.structuredContent.scenario_ref,
    },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.equal(
    history.structuredContent.changes[0].change_ref,
    prepared.structuredContent.change_ref,
  );
  assert.equal(history.structuredContent.changes[0].recorded_status, "applied");
  const recovered = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(recovered.structuredContent.verification.fresh, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
});

test("BLOCK update recovers when its applied result cannot be saved", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить update recovery",
    },
  });
  let restoreStateDirectory;
  hub.state.behavior.afterUpdate = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const appliedWithoutSave = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(appliedWithoutSave.structuredContent.status, "applied");
  assert.deepEqual(appliedWithoutSave.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_native_change",
  });
  await firstClient.close();
  await restoreStateDirectory();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(recovered.structuredContent.verification.fresh, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
});

test("ACK without the requested BLOCK result stays uncertain and is not resent", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 30_000 }),
      reason: "Изменить RESET delay",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  hub.state.behavior.ignoreNextUpdate = true;
  const first = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(first.structuredContent.status, "uncertain");
  assert.equal(
    first.structuredContent.conflict_reason,
    "ack_without_requested_result",
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
});

test("a changed BLOCK baseline is preserved before any update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Изменить RESET delay",
    },
  });
  hub.state.scenarios[0].data = JSON.stringify(blockData({ delay: 55_000 }));

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(applied.structuredContent.status, "conflict");
  assert.equal(applied.structuredContent.conflict_reason, "baseline_changed");
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.update),
    false,
  );
  assert.equal(
    JSON.parse(hub.state.scenarios[0].data).targets[0].then[1].time,
    55_000,
  );

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "conflict");
  assert.equal(restored.structuredContent.conflict_reason, "baseline_changed");
  assert.equal(restored.structuredContent.restore_supported, false);
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.update),
    false,
  );
});

test("history discovers changes by home and entity after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Изменить RESET delay",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);

  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.deepEqual(history.structuredContent.changes, [
    {
      change_ref: prepared.structuredContent.change_ref,
      operation: "block_data_update",
      recorded_status: "prepared",
      target_refs: [
        scenarioRef,
        `${homeRef}/accessory/32`,
        `${homeRef}/accessory/32/service/13`,
        `${homeRef}/accessory/32/service/13/characteristic/15`,
        `${homeRef}/accessory/34`,
        `${homeRef}/accessory/34/service/13`,
        characteristicRef,
      ],
      created_at: history.structuredContent.changes[0].created_at,
      updated_at: history.structuredContent.changes[0].updated_at,
      next: {
        tool: "get_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      },
    },
  ]);
  assert.equal(history.structuredContent.truncated, false);
});

test("history finds one entity and continues through older pages without changing scope", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const catalog = await client.listTools();
  const historyTool = catalog.tools.find(
    ({ name }) => name === "list_native_changes",
  );
  assert.equal(historyTool.inputSchema.properties.limit.default, 10);
  assert.equal(historyTool.inputSchema.properties.limit.maximum, 50);
  assert.deepEqual(historyTool.inputSchema.properties.cursor, {
    type: "string",
    minLength: 1,
    description: "Opaque continuation returned by the previous matching call",
  });

  const selected = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Сохранить старое изменение выбранного сценария",
    },
  });
  assert.equal(selected.isError, undefined, selected.content[0]?.text);

  const foreignChangeRefs = [];
  for (let index = 0; index < 5; index += 1) {
    const foreign = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "window_option",
        target_ref: deviceWindowRef,
        option_key: startupOptionKey,
        value: index % 2,
        reason: `Соседнее изменение окна ${index}`,
      },
    });
    assert.equal(foreign.isError, undefined, foreign.content[0]?.text);
    foreignChangeRefs.push(foreign.structuredContent.change_ref);
  }

  const exact = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef },
  });
  assert.equal(exact.isError, undefined, exact.content[0]?.text);
  assert.deepEqual(
    exact.structuredContent.changes.map(({ change_ref }) => change_ref),
    [selected.structuredContent.change_ref],
  );
  assert.equal(exact.structuredContent.page.next_cursor, null);
  assert.equal(exact.structuredContent.next, null);

  const first = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, limit: 2 },
  });
  assert.equal(first.isError, undefined, first.content[0]?.text);
  assert.equal(first.structuredContent.changes.length, 2);
  assert.equal(first.structuredContent.page.snapshot, false);
  assert.equal(first.structuredContent.page.remaining_changes, 4);
  assert.ok(first.structuredContent.page.next_cursor);
  assert.deepEqual(first.structuredContent.next, {
    tool: "list_native_changes",
    arguments: {
      home_ref: homeRef,
      limit: 2,
      cursor: first.structuredContent.page.next_cursor,
    },
  });

  const adjacent = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 1,
      reason: "Более новое изменение после первой страницы",
    },
  });
  assert.equal(adjacent.isError, undefined, adjacent.content[0]?.text);

  const collected = first.structuredContent.changes.map(
    ({ change_ref }) => change_ref,
  );
  let next = first.structuredContent.next;
  while (next) {
    const page = await client.callTool({
      name: next.tool,
      arguments: next.arguments,
    });
    assert.equal(page.isError, undefined, page.content[0]?.text);
    collected.push(
      ...page.structuredContent.changes.map(({ change_ref }) => change_ref),
    );
    next = page.structuredContent.next;
  }
  assert.equal(collected.length, 6);
  assert.equal(new Set(collected).size, 6);
  assert.equal(collected.includes(selected.structuredContent.change_ref), true);
  assert.equal(
    collected.includes(adjacent.structuredContent.change_ref),
    false,
  );
  assert.deepEqual(
    new Set(collected),
    new Set([selected.structuredContent.change_ref, ...foreignChangeRefs]),
  );

  const changedScope = await client.callTool({
    name: "list_native_changes",
    arguments: {
      home_ref: homeRef,
      entity_ref: scenarioRef,
      limit: 2,
      cursor: first.structuredContent.page.next_cursor,
    },
  });
  assert.equal(changedScope.isError, true);
  assert.equal(changedScope.structuredContent.error.code, "invalid_cursor");
  assert.deepEqual(changedScope.structuredContent.next, {
    tool: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef, limit: 2 },
  });
});

test("history continuation does not repeat a page after its boundary change is read", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  for (let index = 0; index < 4; index += 1) {
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "window_option",
        target_ref: deviceWindowRef,
        option_key: startupOptionKey,
        value: index % 2,
        reason: `Запись истории ${index}`,
      },
    });
    assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  }

  const complete = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef },
  });
  assert.equal(complete.isError, undefined, complete.content[0]?.text);
  const expectedNextRefs = complete.structuredContent.changes
    .slice(2)
    .map(({ change_ref: changeRef }) => changeRef);

  const first = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, limit: 2 },
  });
  assert.equal(first.isError, undefined, first.content[0]?.text);
  const firstRefs = first.structuredContent.changes.map(
    ({ change_ref: changeRef }) => changeRef,
  );
  assert.deepEqual(
    firstRefs,
    complete.structuredContent.changes
      .slice(0, 2)
      .map(({ change_ref: changeRef }) => changeRef),
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  const otherCurrent = await client.callTool({
    name: first.structuredContent.changes[0].next.tool,
    arguments: first.structuredContent.changes[0].next.arguments,
  });
  assert.equal(otherCurrent.isError, undefined, otherCurrent.content[0]?.text);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const boundary = first.structuredContent.changes.at(-1);
  const current = await client.callTool({
    name: boundary.next.tool,
    arguments: boundary.next.arguments,
  });
  assert.equal(current.isError, undefined, current.content[0]?.text);

  const next = await client.callTool({
    name: first.structuredContent.next.tool,
    arguments: first.structuredContent.next.arguments,
  });
  assert.equal(next.isError, undefined, next.content[0]?.text);
  assert.deepEqual(
    next.structuredContent.changes.map(
      ({ change_ref: changeRef }) => changeRef,
    ),
    expectedNextRefs,
  );
  assert.equal(
    next.structuredContent.changes.some(({ change_ref: changeRef }) =>
      firstRefs.includes(changeRef),
    ),
    false,
  );
  assert.equal(next.structuredContent.next, null);
});

test("history cursor keeps its exact ordering boundary after the anchor is removed", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  for (let index = 0; index < 4; index += 1) {
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "window_option",
        target_ref: deviceWindowRef,
        option_key: startupOptionKey,
        value: index % 2,
        reason: `Одинаковое время истории ${index}`,
      },
    });
    assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  }

  const journalName = (await readdir(stateDirectory)).find((name) =>
    name.startsWith("automation-changes-"),
  );
  assert.ok(journalName);
  const journalPath = path.join(stateDirectory, journalName);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  for (const change of Object.values(journal.changes)) {
    change.updated_at = "2026-09-12T12:00:00.000Z";
  }
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const complete = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: deviceWindowRef },
  });
  assert.equal(complete.isError, undefined, complete.content[0]?.text);
  const completeRefs = complete.structuredContent.changes.map(
    ({ change_ref: changeRef }) => changeRef,
  );

  const first = await client.callTool({
    name: "list_native_changes",
    arguments: {
      home_ref: homeRef,
      entity_ref: deviceWindowRef,
      limit: 2,
    },
  });
  assert.equal(first.isError, undefined, first.content[0]?.text);
  assert.equal(
    first.structuredContent.next.arguments.entity_ref,
    deviceWindowRef,
  );
  const boundaryRef = first.structuredContent.changes.at(-1).change_ref;
  const boundaryId = boundaryRef.slice("spruthub-change://native/".length);
  delete journal.changes[boundaryId];
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const next = await client.callTool({
    name: first.structuredContent.next.tool,
    arguments: first.structuredContent.next.arguments,
  });
  assert.equal(next.isError, undefined, next.content[0]?.text);
  assert.deepEqual(
    next.structuredContent.changes.map(
      ({ change_ref: changeRef }) => changeRef,
    ),
    completeRefs.slice(2),
  );
  assert.equal(next.structuredContent.next, null);
});

test("history labels a saved conflict before its next tool verifies current applied state", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Отличить сохранённый конфликт от текущего состояния",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const appliedData = hub.state.scenarios[0].data;
  const manuallyEdited = JSON.parse(appliedData);
  manuallyEdited.manual = true;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const conflict = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  hub.state.scenarios[0].data = appliedData;
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const requestsBeforeHistory = hub.requests.length;
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.equal(history.structuredContent.changes.length, 1);
  const [saved] = history.structuredContent.changes;
  assert.equal(saved.recorded_status, "conflict");
  assert.equal("status" in saved, false);
  assert.equal(typeof saved.updated_at, "string");
  assert.deepEqual(saved.next, {
    tool: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(
    hub.requests.length,
    requestsBeforeHistory,
    "listing saved history must not poll the live hub",
  );

  const current = await secondClient.callTool({
    name: saved.next.tool,
    arguments: saved.next.arguments,
  });
  assert.equal(current.isError, undefined, current.content[0]?.text);
  assert.equal(current.structuredContent.status, "applied");
  assert.equal(current.structuredContent.configuration_matches, true);
  assert.equal(current.structuredContent.verification.fresh, true);
});

test("history indexes created scenarios and BLOCK bindings before and after update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const create = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Индексируемый BLOCK",
      description: "Найти после рестарта",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить историю",
    },
  });
  const created = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  const requested = blockData();
  requested.targets[0].then[0] = setAction({
    cId: 16,
    hc: "Brightness",
    value: "30",
  });
  const update = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requested,
      reason: "Сменить действие",
    },
  });
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);

  for (const [entityRef, expectedChange] of [
    [created.structuredContent.scenario_ref, create],
    [`${homeRef}/accessory/32`, create],
    [characteristicRef, update],
    [`${homeRef}/accessory/34/service/13/characteristic/16`, update],
  ]) {
    const history = await secondClient.callTool({
      name: "list_native_changes",
      arguments: { home_ref: homeRef, entity_ref: entityRef },
    });
    assert.equal(history.isError, undefined, history.content[0]?.text);
    assert.equal(
      history.structuredContent.changes.some(
        ({ change_ref }) =>
          change_ref === expectedChange.structuredContent.change_ref,
      ),
      true,
      entityRef,
    );
  }
});

test("status exposes failed fresh reads and clears stale configuration matches", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const block = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить freshness",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: block.structuredContent.change_ref },
  });
  hub.state.behavior.failNextScenarioGet = true;
  const unavailable = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: block.structuredContent.change_ref },
  });
  assert.equal(unavailable.isError, undefined, unavailable.content[0]?.text);
  assert.equal(unavailable.structuredContent.status, "applied");
  assert.equal(unavailable.structuredContent.verification.fresh, false);
  assert.equal("configuration_matches" in unavailable.structuredContent, false);

  const manuallyEdited = JSON.parse(hub.state.scenarios[0].data);
  manuallyEdited.manual = true;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const conflict = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: block.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.configuration_matches, false);
  assert.equal(conflict.structuredContent.verification.fresh, true);

  const characteristic = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
      value: true,
      reason: "Проверить freshness значения",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: characteristic.structuredContent.change_ref },
  });
  hub.state.behavior.failNextCharacteristicGet = true;
  const characteristicUnavailable = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: characteristic.structuredContent.change_ref },
  });
  assert.equal(
    characteristicUnavailable.structuredContent.verification.fresh,
    false,
  );
});

test("fresh BLOCK match recovers from an earlier conflict before restore", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить возврат к applied snapshot",
    },
  });
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  const appliedData = hub.state.scenarios[0].data;

  const manuallyEdited = JSON.parse(appliedData);
  manuallyEdited.manual = true;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const conflict = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.configuration_matches, false);

  hub.state.scenarios[0].data = appliedData;
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const matchedAgain = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(matchedAgain.isError, undefined, matchedAgain.content[0]?.text);
  assert.equal(matchedAgain.structuredContent.status, "applied");
  assert.equal(matchedAgain.structuredContent.configuration_matches, true);
  assert.equal(matchedAgain.structuredContent.verification.fresh, true);
  assert.equal("conflict_reason" in matchedAgain.structuredContent, false);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
    "get must only observe the returned applied configuration",
  );

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.configuration_matches, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    2,
  );
  assert.deepEqual(
    JSON.parse(hub.state.scenarios[0].data),
    withRuntimeBlockFields(blockData()),
  );
});

test("restored BLOCK observations keep terminal status and consistent snapshot facts", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const update = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить наблюдение restored update",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  const restoredUpdate = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(restoredUpdate.structuredContent.status, "restored");
  const restoredData = hub.state.scenarios[0].data;
  const manuallyEdited = JSON.parse(restoredData);
  manuallyEdited.manual = true;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const writesBeforeGet = hub.requests.filter(
    ({ scenario }) => scenario?.create || scenario?.update || scenario?.delete,
  ).length;

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const driftedUpdate = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(driftedUpdate.structuredContent.status, "restored");
  assert.equal(driftedUpdate.structuredContent.configuration_matches, false);
  assert.equal(driftedUpdate.structuredContent.verification.fresh, true);
  assert.equal(
    driftedUpdate.structuredContent.verification.result,
    "baseline_configuration_missing",
  );

  hub.state.scenarios[0].data = restoredData;
  const matchingUpdate = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(matchingUpdate.structuredContent.status, "restored");
  assert.equal(matchingUpdate.structuredContent.configuration_matches, true);
  assert.equal(
    matchingUpdate.structuredContent.verification.result,
    "baseline_configuration",
  );
  assert.equal(
    hub.requests.filter(
      ({ scenario }) =>
        scenario?.create || scenario?.update || scenario?.delete,
    ).length,
    writesBeforeGet,
  );

  const createData = blockData({ nested: true });
  delete createData.vendorConfiguration;
  const create = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Восстановленный create",
      description: "Проверить повторное появление",
      active: false,
      on_start: false,
      sync: false,
      data: createData,
      reason: "Проверить observation после удаления",
    },
  });
  const appliedCreate = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  const createdScenario = structuredClone(
    hub.state.scenarios.find(
      ({ index }) => index === appliedCreate.structuredContent.scenario_index,
    ),
  );
  const restoredCreate = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  assert.equal(restoredCreate.structuredContent.status, "restored");
  hub.state.scenarios.push(createdScenario);
  const writesBeforeCreateGet = hub.requests.filter(
    ({ scenario }) => scenario?.create || scenario?.update || scenario?.delete,
  ).length;

  const reappearedCreate = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  assert.equal(reappearedCreate.structuredContent.status, "restored");
  assert.equal(reappearedCreate.structuredContent.configuration_matches, false);
  assert.equal(reappearedCreate.structuredContent.verification.fresh, true);
  assert.equal(
    reappearedCreate.structuredContent.verification.result,
    "baseline_configuration_missing",
  );
  assert.equal(
    hub.requests.filter(
      ({ scenario }) =>
        scenario?.create || scenario?.update || scenario?.delete,
    ).length,
    writesBeforeCreateGet,
  );
});

test("native preparation rejects unsafe targets and values before send", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const brightnessRef = `${homeRef}/accessory/34/service/13/characteristic/16`;
  const readOnlyRef = `${homeRef}/accessory/34/service/13/characteristic/17`;
  const modeRef = `${homeRef}/accessory/34/service/13/characteristic/18`;

  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "characteristic_value", target_ref: brightnessRef },
  });
  assert.deepEqual(contract.structuredContent.contract, {
    type: "Brightness",
    kind: "intValue",
    min: 0,
    max: 100,
    step: 1,
  });

  for (const arguments_ of [
    {
      operation: "characteristic_value",
      target_ref: brightnessRef,
      value: 101,
      reason: "Недопустимый диапазон",
    },
    {
      operation: "characteristic_value",
      target_ref: readOnlyRef,
      value: false,
      reason: "Недоступная запись",
    },
    {
      operation: "characteristic_value",
      target_ref: modeRef,
      value: "vacation",
      reason: "Неизвестное enum-значение",
    },
    {
      operation: "characteristic_value",
      target_ref:
        "spruthub://hub/other-home/accessory/34/service/13/characteristic/15",
      value: true,
      reason: "Чужой дом",
    },
  ]) {
    const rejected = await client.callTool({
      name: "prepare_native_change",
      arguments: arguments_,
    });
    assert.equal(rejected.isError, true);
  }

  const unknownData = blockData();
  delete unknownData.vendorConfiguration;
  unknownData.targets[0].then[0].unsupportedAction = true;
  const unknown = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Неподдержанный BLOCK",
      description: "Не применять",
      active: false,
      on_start: false,
      sync: false,
      data: unknownData,
      reason: "Проверить схему",
    },
  });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent.error.code, "invalid_block_data");
  assert.equal(
    hub.requests.some(
      ({ characteristic, scenario }) =>
        characteristic?.update || scenario?.create || scenario?.update,
    ),
    false,
  );
});

test("a native logic assignment is configured without a duplicate and restored after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);

  const service = await firstClient.callTool({
    name: "get_entity",
    arguments: { entity_ref: serviceRef },
  });
  assert.equal(service.isError, undefined, service.content[0]?.text);
  assert.deepEqual(service.structuredContent.entity.assigned_logics, []);
  assert.deepEqual(service.structuredContent.entity.available_logic_types, [
    {
      ref: smoothLogicRef,
      type: smoothLogicType,
      name: "Плавное изменение яркости",
      description: "Плавно меняет яркость при включении света",
      assigned: false,
    },
  ]);

  const assignment = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Назначить штатное мягкое включение офисной лампы",
    },
  });
  assert.equal(assignment.isError, undefined, assignment.content[0]?.text);
  assert.equal(assignment.structuredContent.status, "prepared");
  const assigned = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: assignment.structuredContent.change_ref },
  });
  assert.equal(assigned.isError, undefined, assigned.content[0]?.text);
  assert.equal(assigned.structuredContent.status, "applied");
  assert.equal(hub.state.logics.length, 1);
  assert.equal(hub.state.logics[0].active, false);

  const logic = await firstClient.callTool({
    name: "get_entity",
    arguments: { entity_ref: smoothLogicRef, include: ["options"] },
  });
  assert.equal(logic.isError, undefined, logic.content[0]?.text);
  assert.equal(logic.structuredContent.entity.active, false);
  assert.deepEqual(
    logic.structuredContent.entity.options.map(
      ({ key, type, input_type, value, capabilities }) => ({
        key,
        type,
        input_type,
        value,
        capabilities,
      }),
    ),
    [
      {
        key: "Primary",
        type: "Group",
        input_type: "GROUP",
        value: null,
        capabilities: { read: true, write: false, disabled: false },
      },
      {
        key: smoothOptionKeys.start,
        type: "GenericInteger",
        input_type: "NUMBER",
        value: 1,
        capabilities: { read: true, write: true, disabled: false },
      },
      {
        key: smoothOptionKeys.end,
        type: "GenericInteger",
        input_type: "NUMBER",
        value: 100,
        capabilities: { read: true, write: true, disabled: false },
      },
      {
        key: smoothOptionKeys.duration,
        type: "GenericInteger",
        input_type: "NUMBER",
        value: 900,
        capabilities: { read: true, write: true, disabled: false },
      },
    ],
  );

  const changes = [];
  for (const [optionKey, value] of [
    [smoothOptionKeys.start, 1],
    [smoothOptionKeys.end, 40],
    [smoothOptionKeys.duration, 5],
  ]) {
    const prepared = await firstClient.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "logic_option",
        target_ref: smoothLogicRef,
        option_key: optionKey,
        value,
        reason: "Настроить штатное мягкое включение офисной лампы",
      },
    });
    assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
    if (prepared.structuredContent.status === "prepared") {
      const applied = await firstClient.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(applied.structuredContent.status, "applied");
      changes.push(prepared.structuredContent.change_ref);
    } else {
      assert.equal(prepared.structuredContent.status, "already_desired");
    }
  }
  const activation = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_active",
      target_ref: smoothLogicRef,
      value: true,
      reason: "Активировать настроенное штатное поведение",
    },
  });
  const activated = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: activation.structuredContent.change_ref },
  });
  assert.equal(activated.structuredContent.status, "applied");
  changes.push(activation.structuredContent.change_ref);
  assert.equal(hub.state.logics[0].active, true);
  assert.deepEqual(
    configuredSmoothLogicOptions(hub.state)
      .filter(({ value }) => value)
      .map(({ key, value }) => [key, value.intValue]),
    [
      [smoothOptionKeys.start, 1],
      [smoothOptionKeys.end, 40],
      [smoothOptionKeys.duration, 5],
    ],
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const observedAssignment = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: assignment.structuredContent.change_ref },
  });
  assert.equal(observedAssignment.structuredContent.status, "applied");
  assert.equal(
    observedAssignment.structuredContent.configuration_matches,
    false,
  );
  assert.equal(
    "conflict_reason" in observedAssignment.structuredContent,
    false,
  );
  assert.deepEqual(
    observedAssignment.structuredContent.configuration_differences,
    {
      active: { created: false, current: true },
      option_keys: [smoothOptionKeys.duration, smoothOptionKeys.end],
    },
  );
  const repeatedApply = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: assignment.structuredContent.change_ref },
  });
  assert.equal(repeatedApply.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(({ logic }) => logic?.create).length, 1);
  const repeatedAssignment = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Повторить ту же просьбу",
    },
  });
  assert.equal(repeatedAssignment.structuredContent.status, "already_desired");
  assert.equal(
    repeatedAssignment.structuredContent.owned_change_created,
    false,
  );
  const repeatedActivation = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_active",
      target_ref: smoothLogicRef,
      value: true,
      reason: "Повторить ту же просьбу",
    },
  });
  assert.equal(repeatedActivation.structuredContent.status, "already_desired");
  assert.equal(hub.requests.filter(({ logic }) => logic?.create).length, 1);

  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: smoothLogicRef },
  });
  assert.deepEqual(
    history.structuredContent.changes.map(({ operation }) => operation),
    ["logic_assignment", "logic_active", "logic_option", "logic_option"],
  );
  for (const changeRef of changes.reverse()) {
    const restored = await secondClient.callTool({
      name: "restore_native_change",
      arguments: { change_ref: changeRef },
    });
    assert.equal(restored.structuredContent.status, "restored");
  }
  const removed = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: assignment.structuredContent.change_ref },
  });
  assert.equal(removed.structuredContent.status, "restored");
  assert.deepEqual(hub.state.logics, []);
  assert.equal(hub.requests.filter(({ logic }) => logic?.delete).length, 1);
  assert.equal(
    hub.requests.some(({ scenario }) =>
      Boolean(scenario?.create || scenario?.update || scenario?.delete),
    ),
    false,
  );
});

test("an existing or manually assigned logic is not claimed for deletion", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.logics.push(assignedSmoothLogic({ active: true }));
  const firstClient = await startClient(t, hub, stateDirectory);
  const existing = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Использовать существующую штатную logic",
    },
  });
  assert.deepEqual(existing.structuredContent, {
    status: "already_desired",
    operation: "logic_assignment",
    target_ref: smoothLogicRef,
    native_write_sent: false,
    owned_change_created: false,
  });

  hub.state.logics.length = 0;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Подготовить назначение",
    },
  });
  hub.state.logics.push(assignedSmoothLogic());
  const refusedApply = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refusedApply.structuredContent.status, "conflict");
  assert.equal(
    refusedApply.structuredContent.conflict_reason,
    "baseline_changed",
  );
  assert.equal(
    hub.requests.some(({ logic }) => logic?.create),
    false,
  );
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "not_owned");
  assert.equal(hub.state.logics.length, 1);
  assert.equal(
    hub.requests.some(({ logic }) => logic?.delete),
    false,
  );
});

test("a disappeared owned logic assignment is not reclaimed after the owner recreates it", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Назначить штатную logic",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.logics.length = 0;

  const missing = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(missing.structuredContent.status, "conflict");
  assert.equal(
    missing.structuredContent.conflict_reason,
    "assignment_missing_after_creation",
  );
  assert.equal(missing.structuredContent.assignment_ownership_lost, true);

  hub.state.logics.push(assignedSmoothLogic());
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  for (const tool of [
    "get_native_change",
    "apply_native_change",
    "restore_native_change",
  ]) {
    const result = await secondClient.callTool({
      name: tool,
      arguments: { change_ref: prepared.structuredContent.change_ref },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.equal(result.structuredContent.status, "conflict", tool);
    assert.equal(
      result.structuredContent.conflict_reason,
      "assignment_reappeared_after_ownership_loss",
      tool,
    );
    assert.equal(
      result.structuredContent.assignment_ownership_lost,
      true,
      tool,
    );
  }
  assert.equal(hub.state.logics.length, 1);
  assert.equal(hub.requests.filter(({ logic }) => logic?.create).length, 1);
  assert.equal(
    hub.requests.some(({ logic }) => logic?.delete),
    false,
  );
});

test("restoring an absent owned logic stays terminal if another assignment later appears", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Назначить штатную logic",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.logics.length = 0;

  const restored = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.assignment_ownership_lost, true);
  assert.equal(
    hub.requests.some(({ logic }) => logic?.delete),
    false,
  );

  hub.state.logics.push(assignedSmoothLogic());
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const observed = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(observed.structuredContent.status, "restored");
  assert.equal(observed.structuredContent.configuration_matches, false);
  assert.equal(observed.structuredContent.assignment_ownership_lost, true);
  const repeatedRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeatedRestore.structuredContent.status, "restored");
  assert.equal(hub.state.logics.length, 1);
  assert.equal(
    hub.requests.some(({ logic }) => logic?.delete),
    false,
  );
});

test("a failed fresh logic read does not expose saved configuration differences as current", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Назначить штатную logic",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.logics[0].active = true;
  const changed = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.deepEqual(changed.structuredContent.configuration_differences, {
    active: { created: false, current: true },
  });

  hub.state.logics[0].active = false;
  hub.state.behavior.failNextLogicList = true;
  const unavailable = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(unavailable.isError, undefined, unavailable.content[0]?.text);
  assert.equal(unavailable.structuredContent.verification.fresh, false);
  assert.equal("configuration_matches" in unavailable.structuredContent, false);
  assert.equal(
    "configuration_differences" in unavailable.structuredContent,
    false,
  );
});

test("an uncertain logic create is reconciled once and configuration changes block deletion", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Назначить штатную logic",
    },
  });
  hub.state.behavior.closeAfterLogicCreate = true;
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);
  assert.equal(hub.requests.filter(({ logic }) => logic?.create).length, 1);

  hub.state.logics[0].active = true;
  const options = configuredSmoothLogicOptions(hub.state);
  delete options.find(({ key }) => key === smoothOptionKeys.start).value;
  options.find(({ key }) => key === smoothOptionKeys.end).value = {
    intValue: 55,
  };
  options.find(({ key }) => key === smoothOptionKeys.duration).type =
    "GenericDouble";
  options.find(({ key }) => key === "Primary").value = { intValue: 1 };
  options.push({
    key: "AddedOption",
    type: "GenericInteger",
    inputType: "NUMBER",
    read: true,
    write: true,
    value: { intValue: 7 },
  });
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "conflict");
  assert.equal(
    restored.structuredContent.conflict_reason,
    "configuration_changed_after_creation",
  );
  assert.deepEqual(restored.structuredContent.configuration_differences, {
    active: { created: false, current: true },
    option_keys: [
      "AddedOption",
      smoothOptionKeys.duration,
      smoothOptionKeys.end,
      "Primary",
      smoothOptionKeys.start,
    ],
  });
  assert.equal(hub.state.logics.length, 1);
  assert.equal(
    hub.requests.some(({ logic }) => logic?.delete),
    false,
  );
});

test("cosmetic logic metadata does not block deletion of an owned assignment", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  configuredSmoothLogicOptions(hub.state).find(
    ({ key }) => key === smoothOptionKeys.end,
  ).value = { intValue: 40 };
  configuredSmoothLogicOptions(hub.state).find(
    ({ key }) => key === smoothOptionKeys.duration,
  ).value = { intValue: 5 };
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Назначить штатную logic",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.deepEqual(
    configuredSmoothLogicOptions(hub.state)
      .filter(({ key }) =>
        [smoothOptionKeys.end, smoothOptionKeys.duration].includes(key),
      )
      .map(({ key, value }) => [key, value.intValue]),
    [
      [smoothOptionKeys.end, 40],
      [smoothOptionKeys.duration, 5],
    ],
  );

  Object.assign(hub.state.logics[0], {
    name: "Локализованное название",
    desc: "Локализованное описание",
    locale: "ru-RU",
    optionsWindow: "Logic/localized/window",
  });
  for (const option of configuredSmoothLogicOptions(hub.state)) {
    option.name = `Локализовано: ${option.key}`;
    option.desc = "Описание элемента управления";
    option.locale = "ru-RU";
    option.read = !option.read;
    option.write = !option.write;
    option.disabled = !option.disabled;
  }

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(hub.state.logics, []);
  assert.equal(hub.requests.filter(({ logic }) => logic?.delete).length, 1);
});

test("a lost logic option response keeps its apply direction and restores the baseline", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.logics.push(assignedSmoothLogic());
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_option",
      target_ref: smoothLogicRef,
      option_key: smoothOptionKeys.duration,
      value: 5,
      reason: "Установить длительность мягкого включения",
    },
  });
  hub.state.behavior.closeAfterLogicSetOptions = true;
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.write_intent.direction, "apply");
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);
  assert.equal(
    configuredSmoothLogicOptions(hub.state).find(
      ({ key }) => key === smoothOptionKeys.duration,
    ).value.intValue,
    5,
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.write_intent.direction, "restore");
  assert.equal(
    configuredSmoothLogicOptions(hub.state).find(
      ({ key }) => key === smoothOptionKeys.duration,
    ).value.intValue,
    900,
  );
  assert.equal(hub.requests.filter(({ logic }) => logic?.setOptions).length, 2);
});

test("logic writes require a catalogued type and a writable GenericInteger NUMBER option", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  hub.state.logicTypes.length = 0;
  const unavailable = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Не создавать вымышленный механизм",
    },
  });
  assert.equal(unavailable.isError, true);
  assert.equal(
    unavailable.structuredContent.error.code,
    "logic_type_unavailable",
  );
  assert.equal(
    hub.requests.some(({ logic }) => logic?.create),
    false,
  );

  hub.state.logicTypes.push({
    type: smoothLogicType,
    name: "Плавное изменение яркости",
    desc: "Плавно меняет яркость при включении света",
  });
  hub.state.logics.push(assignedSmoothLogic());
  configuredSmoothLogicOptions(hub.state).find(
    ({ key }) => key === smoothOptionKeys.duration,
  ).inputType = "SLIDER";
  const unsupported = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "logic_option",
      target_ref: smoothLogicRef,
      option_key: smoothOptionKeys.duration,
    },
  });
  assert.equal(unsupported.isError, true);
  assert.equal(
    unsupported.structuredContent.error.code,
    "unsupported_logic_option",
  );

  configuredSmoothLogicOptions(hub.state).find(
    ({ key }) => key === smoothOptionKeys.duration,
  ).inputType = "NUMBER";
  delete configuredSmoothLogicOptions(hub.state).find(
    ({ key }) => key === smoothOptionKeys.duration,
  ).disabled;
  hub.state.logicTypes[0].name = "api_token=logic-name-secret";
  hub.state.logicTypes[0].desc =
    "Authorization: Bearer logic-description-secret";
  const supportedWithoutDisabled = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "logic_option",
      target_ref: smoothLogicRef,
      option_key: smoothOptionKeys.duration,
    },
  });
  assert.equal(
    supportedWithoutDisabled.isError,
    undefined,
    supportedWithoutDisabled.content[0]?.text,
  );
  const assignmentContract = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
    },
  });
  assert.equal(
    assignmentContract.structuredContent.contract.name,
    "[REDACTED]",
  );
  assert.equal(
    assignmentContract.structuredContent.contract.description,
    "[REDACTED]",
  );
});

test("an accessory is renamed and moved as one owned change, then restored after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  hub.state.behavior.normalizeNextAccessoryName = true;

  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая · лампа",
      reason: "Перенести настольную лампу в мастерскую и переименовать",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.deepEqual(prepared.structuredContent.diff, {
    name: { from: "Лампа", to: "Рабочая · лампа" },
    room: {
      from: { ref: `${homeRef}/room/1`, name: "Офис" },
      to: { ref: workshopRoomRef, name: "Мастерская" },
    },
  });

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, true);
  assert.deepEqual(applied.structuredContent.observed, {
    name: "Рабочая лампа",
    room_ref: workshopRoomRef,
    room_name: "Мастерская",
  });
  assert.deepEqual(
    hub.requests.filter(({ accessory }) => accessory?.update),
    [
      {
        accessory: {
          update: { id: 34, name: "Рабочая · лампа", roomId: 2 },
        },
      },
    ],
  );
  assert.deepEqual(
    hub.state.accessories.find(({ id }) => id === 35),
    {
      id: 35,
      roomId: 1,
      name: "Подсветка той же лампы",
      online: true,
      extensionKey: "zigbee_demo",
      deviceId: "DEVICE_A",
      services: [],
    },
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: accessoryRef, limit: 10 },
  });
  assert.equal(history.structuredContent.changes.length, 1);
  assert.equal(
    history.structuredContent.changes[0].change_ref,
    prepared.structuredContent.change_ref,
  );
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(hub.state.accessories.find(({ id }) => id === 34).name, "Лампа");
  assert.equal(hub.state.accessories.find(({ id }) => id === 34).roomId, 1);
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    2,
  );
});

test("a later manual accessory edit blocks restoration without touching the hub", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая лампа",
      reason: "Упорядочить лампу",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.accessories.find(({ id }) => id === 34).name =
    "Ручное имя владельца";
  const writesBeforeRestore = hub.requests.filter(
    ({ accessory }) => accessory?.update,
  ).length;

  const conflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.equal(
    hub.state.accessories.find(({ id }) => id === 34).name,
    "Ручное имя владельца",
  );
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    writesBeforeRestore,
  );
});

test("a created room is reused after restart and removed only after its accessory is restored", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const roomChange = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Лаборатория",
      reason: "Создать отсутствующую комнату для лампы",
    },
  });
  const created = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: roomChange.structuredContent.change_ref },
  });
  assert.equal(created.isError, undefined, created.content[0]?.text);
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(created.structuredContent.room_creation_owned, true);
  const createdRoomRef = created.structuredContent.room.ref;

  const accessoryChange = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: createdRoomRef,
      name: "Рабочая лампа",
      reason: "Разместить лампу в созданной комнате",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: accessoryChange.structuredContent.change_ref },
  });
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);

  const repeatedRoomApply = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: roomChange.structuredContent.change_ref },
  });
  assert.equal(repeatedRoomApply.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(({ room }) => room?.create).length, 1);
  const occupied = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: roomChange.structuredContent.change_ref },
  });
  assert.equal(occupied.structuredContent.status, "conflict");
  assert.equal(occupied.structuredContent.conflict_reason, "room_not_empty");
  assert.equal(hub.requests.filter(({ room }) => room?.delete).length, 0);

  const accessoryRestored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: accessoryChange.structuredContent.change_ref },
  });
  assert.equal(accessoryRestored.structuredContent.status, "restored");
  const roomRestored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: roomChange.structuredContent.change_ref },
  });
  assert.equal(roomRestored.structuredContent.status, "restored");
  assert.equal(
    hub.state.rooms.some(
      ({ id }) => `${homeRef}/room/${id}` === createdRoomRef,
    ),
    false,
  );
});

test("static room discovery does not relax target-dependent reads or preparation", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  const general = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "room_create" },
  });
  assert.equal(general.isError, undefined, general.content[0]?.text);
  assert.equal(general.structuredContent.contract.write, "room.create({name})");

  const selectedHome = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "room_create", target_ref: homeRef },
  });
  assert.equal(selectedHome.isError, undefined, selectedHome.content[0]?.text);
  assert.deepEqual(
    selectedHome.structuredContent.contract,
    general.structuredContent.contract,
  );

  for (const targetRef of [accessoryRef, "spruthub://hub/another-home"]) {
    const refused = await client.callTool({
      name: "get_native_change_contract",
      arguments: { operation: "room_create", target_ref: targetRef },
    });
    assert.equal(refused.isError, true);
  }

  const missingEntityTarget = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "characteristic_value" },
  });
  assert.equal(missingEntityTarget.isError, true);
  assert.equal(
    missingEntityTarget.structuredContent.error.code,
    "target_required",
  );
  const entityContract = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
    },
  });
  assert.equal(
    entityContract.isError,
    undefined,
    entityContract.content[0]?.text,
  );
  assert.equal(entityContract.structuredContent.contract.type, "On");

  const missingPreparationTarget = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      name: "Не создавать",
      reason: "Отсутствует обязательная цель подготовки",
    },
  });
  assert.equal(missingPreparationTarget.isError, true);
  assert.equal(
    hub.requests.some(({ room }) => room?.create),
    false,
  );
});

test("a lost room-create response exposes one candidate and never repeats creation", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Архив",
      reason: "Создать отсутствующую комнату",
    },
  });
  hub.state.behavior.closeAfterRoomCreate = true;
  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.room_creation_owned, false);
  assert.equal(uncertain.structuredContent.candidate_rooms.length, 1);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(hub.requests.filter(({ room }) => room?.create).length, 1);
  const candidateRoomRef = repeated.structuredContent.candidate_rooms[0].ref;
  const accessoryChange = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: candidateRoomRef,
      name: "Лампа архива",
      reason: "Закончить перенос без повторного создания комнаты",
    },
  });
  const applied = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: accessoryChange.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(({ room }) => room?.create).length, 1);
  const notOwned = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(notOwned.structuredContent.status, "not_owned");
  assert.equal(hub.requests.filter(({ room }) => room?.delete).length, 0);
});

test("a home-qualified accessory placement rejects the same local id in another home", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const refused = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: "spruthub://hub/other-home/accessory/34",
      room_ref: workshopRoomRef,
      name: "Чужая лампа",
      reason: "Не затрагивать другой дом",
    },
  });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, "unsupported_home_write");
  assert.equal(
    hub.requests.some(({ accessory }) => accessory?.update),
    false,
  );
  const foreignRoom = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: "spruthub://hub/other-home/room/2",
      name: "Чужая лампа",
      reason: "Не затрагивать комнату другого дома",
    },
  });
  assert.equal(foreignRoom.isError, true);
  assert.equal(
    foreignRoom.structuredContent.error.code,
    "unsupported_home_write",
  );
  assert.equal(
    hub.requests.some(({ accessory }) => accessory?.update),
    false,
  );
});

test("a lost accessory response is reconciled without a second update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая лампа",
      reason: "Перенести лампу",
    },
  });
  hub.state.behavior.closeAfterAccessoryUpdate = true;
  const recovered = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(recovered.structuredContent.native_acknowledged, false);
  assert.equal(
    recovered.structuredContent.recovered_after_uncertain_write,
    true,
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    1,
  );
});

test("an apply retry never uses a saved accessory snapshot after a fresh read fails", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая лампа",
      reason: "Не повторять запись по устаревшему снимку",
    },
  });
  await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.closeAfterAccessoryUpdate = true;
  hub.state.behavior.failAccessoryGetAfterUpdate = true;
  const firstAttempt = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(
    firstAttempt.structuredContent.status,
    "uncertain",
    firstAttempt.content[0]?.text,
  );

  hub.state.behavior.failNextAccessoryGet = true;
  const failedFreshRead = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(failedFreshRead.structuredContent.status, "uncertain");
  assert.equal(failedFreshRead.structuredContent.verification.fresh, false);
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    1,
  );

  const recovered = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    1,
  );
});

test("a lost rename response reports the unchanged baseline before a safe retry", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: `${homeRef}/room/1`,
      name: "Настольная лампа",
      reason: "Переименовать без смены комнаты",
    },
  });
  hub.state.behavior.dropNextAccessoryUpdate = true;
  hub.state.behavior.closeAfterAccessoryUpdate = true;
  const uncertain = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal("conflict_reason" in uncertain.structuredContent, false);
  assert.equal(
    uncertain.structuredContent.verification.result,
    "requested_values_missing",
  );

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    2,
  );
});

test("a restore retry preserves a manual edit when its fresh read fails", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая лампа",
      reason: "Не затирать ручную правку при повторе возврата",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.closeAfterAccessoryUpdate = true;
  hub.state.behavior.failAccessoryGetAfterUpdate = true;
  const firstRestore = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(
    firstRestore.structuredContent.status,
    "uncertain",
    firstRestore.content[0]?.text,
  );

  hub.state.accessories.find(({ id }) => id === 34).name =
    "Ручное имя владельца";
  hub.state.behavior.failNextAccessoryGet = true;
  const failedFreshRead = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(failedFreshRead.structuredContent.status, "uncertain");
  assert.equal(failedFreshRead.structuredContent.verification.fresh, false);
  assert.equal(
    hub.state.accessories.find(({ id }) => id === 34).name,
    "Ручное имя владельца",
  );
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    2,
  );

  const observedManualEdit = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(observedManualEdit.structuredContent.status, "uncertain");
  assert.equal(
    observedManualEdit.structuredContent.conflict_reason,
    "possible_name_normalization_after_restore",
  );
  assert.equal(
    hub.state.accessories.find(({ id }) => id === 34).name,
    "Ручное имя владельца",
  );
});

test("an exact room ref selects one of two rooms with the same name", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.rooms.push({
    id: 3,
    order: 3,
    name: "Мастерская",
    visible: true,
  });
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: `${homeRef}/room/3`,
      name: "Рабочая лампа",
      reason: "Использовать выбранную мастерскую",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(hub.state.accessories.find(({ id }) => id === 34).roomId, 3);
  assert.deepEqual(
    hub.requests.filter(({ accessory }) => accessory?.update).at(-1).accessory
      .update,
    { id: 34, name: "Рабочая лампа", roomId: 3 },
  );
});

test("a normalized name after a lost accessory response stays uncertain and is not rewritten", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая · лампа",
      reason: "Перенести лампу без догадки о нормализации",
    },
  });
  hub.state.behavior.normalizeNextAccessoryName = true;
  hub.state.behavior.closeAfterAccessoryUpdate = true;
  const uncertain = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(
    uncertain.structuredContent.conflict_reason,
    "possible_name_normalization_after_lost_response",
  );
  assert.equal(uncertain.structuredContent.observed.name, "Рабочая лампа");

  const repeated = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    1,
  );
  const restore = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restore.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    1,
  );
});

test("a normalized baseline name after an acknowledged restore stays uncertain without a rewrite", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.accessories.find(({ id }) => id === 34).name = "Лампа · стол";
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая лампа",
      reason: "Вернуть наблюдённое имя без догадки о нормализации",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.normalizeNextAccessoryName = true;
  const uncertain = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(
    uncertain.structuredContent.conflict_reason,
    "possible_name_normalization_after_restore",
  );
  assert.equal(uncertain.structuredContent.observed.name, "Лампа стол");

  const repeated = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    2,
  );
});

test("an existing room name is a no-op without owned creation", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const existing = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Мастерская",
      reason: "Переиспользовать существующую комнату",
    },
  });
  assert.equal(existing.structuredContent.status, "already_desired");
  assert.deepEqual(existing.structuredContent.matching_rooms, [
    { ref: workshopRoomRef, name: "Мастерская" },
  ]);
  assert.equal(existing.structuredContent.owned_change_created, false);
  assert.equal(
    hub.requests.some(({ room }) => room?.create),
    false,
  );
});

test("room creation trims the name before matching an existing room", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const existing = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "  Мастерская  ",
      reason: "Не создавать почти одинаковую комнату",
    },
  });
  assert.equal(existing.structuredContent.status, "already_desired");
  assert.deepEqual(existing.structuredContent.matching_rooms, [
    { ref: workshopRoomRef, name: "Мастерская" },
  ]);
  assert.equal(
    hub.requests.some(({ room }) => room?.create),
    false,
  );
});

test("room deletion requires catalog-confirmed absence after native not-found", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Архив",
      reason: "Проверить возврат комнаты по реальному not-found контракту",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");

  hub.state.behavior.rejectNextRoomGetAsInternalError = true;
  const presentButRejected = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(presentButRejected.structuredContent.status, "applied");
  assert.equal(presentButRejected.structuredContent.verification.fresh, false);

  hub.state.behavior.missingRoomGetAsNotFoundError = true;
  hub.state.behavior.invalidNextRoomList = true;
  const uncertain = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.verification.fresh, false);
  assert.equal(hub.requests.filter(({ room }) => room?.delete).length, 1);

  const recovered = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "restored");
  assert.equal(recovered.structuredContent.verification.fresh, true);
  assert.equal(hub.requests.filter(({ room }) => room?.delete).length, 1);
});

test("room creation rechecks all current names before writing", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Склад",
      reason: "Создать только действительно отсутствующую комнату",
    },
  });
  hub.state.rooms[0].name = "Склад";
  const conflict = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(
    conflict.structuredContent.conflict_reason,
    "matching_room_appeared",
  );
  assert.equal(
    hub.requests.some(({ room }) => room?.create),
    false,
  );
});

test("get_scenario_sdk returns native typed declarations with matching public metadata", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  const result = await client.callTool({
    name: "get_scenario_sdk",
    arguments: { home_ref: homeRef },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(result.structuredContent.sdk, scenarioSdk);
  assert.equal(result.structuredContent.sdk_complete, true);
  assert.equal(
    result.structuredContent.bytes,
    Buffer.byteLength(result.structuredContent.sdk),
  );
  assert.equal(
    result.structuredContent.sha256,
    createHash("sha256").update(result.structuredContent.sdk).digest("hex"),
  );
});

test("get_scenario_sdk identifies a hidden credential without claiming complete metadata", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  hub.state.scenarioSdk = `${scenarioSdk}\nconst defaults = { password: "sdk-secret-must-not-leak" };`;

  const result = await client.callTool({
    name: "get_scenario_sdk",
    arguments: { home_ref: homeRef },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(result.structuredContent.sdk, "[REDACTED]");
  assert.equal(result.structuredContent.sdk_complete, false);
  assert.equal(
    result.structuredContent.bytes,
    Buffer.byteLength(result.structuredContent.sdk),
  );
  assert.equal(
    result.structuredContent.sha256,
    createHash("sha256").update(result.structuredContent.sdk).digest("hex"),
  );
  assert.doesNotMatch(result.content[0].text, /sdk-secret-must-not-leak/);

  hub.state.scenarioSdk = `${scenarioSdk}\ndeclare const embeddedValue = "native-change-test-token";`;
  const knownSecret = await client.callTool({
    name: "get_scenario_sdk",
    arguments: { home_ref: homeRef },
  });
  assert.equal(knownSecret.structuredContent.sdk, "[REDACTED]");
  assert.equal(knownSecret.structuredContent.sdk_complete, false);
  assert.doesNotMatch(knownSecret.content[0].text, /native-change-test-token/);
});

test("get_scenario_sdk hides credential initializers across TypeScript type syntax", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  const credentialDeclarations = [
    'declare function connect(password: String = "typed-default-secret-must-not-leak"): void;',
    'declare function connect(password: Record<string, string> = "generic-default-secret-must-not-leak"): void;',
    'declare function connect(password: string extends infer T ? T : never = "conditional-default-secret-must-not-leak"): void;',
    'declare function connect(password: Array<String>= "adjacent-default-secret-must-not-leak"): void;',
    'declare function connect(password?: String = "optional-default-secret-must-not-leak"): void;',
  ];
  for (const declaration of credentialDeclarations) {
    hub.state.scenarioSdk = `${scenarioSdk}\n${declaration}`;
    const hiddenCredential = await client.callTool({
      name: "get_scenario_sdk",
      arguments: { home_ref: homeRef },
    });

    assert.equal(
      hiddenCredential.isError,
      undefined,
      hiddenCredential.content[0]?.text,
    );
    assert.equal(hiddenCredential.structuredContent.sdk, "[REDACTED]");
    assert.equal(hiddenCredential.structuredContent.sdk_complete, false);
    assert.doesNotMatch(hiddenCredential.content[0].text, /must-not-leak/);
  }

  hub.state.scenarioSdk = `${scenarioSdk}\ndeclare function login(password: String, retries = 3): Mail;`;
  const ordinaryDefault = await client.callTool({
    name: "get_scenario_sdk",
    arguments: { home_ref: homeRef },
  });
  assert.equal(ordinaryDefault.structuredContent.sdk, hub.state.scenarioSdk);
  assert.equal(ordinaryDefault.structuredContent.sdk_complete, true);
});

test("get_scenario_sdk fails closed without exposing declaration parser errors", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  hub.state.scenarioSdk = `${scenarioSdk}\ninterface Broken { password(password: String): Mail;`;

  const result = await client.callTool({
    name: "get_scenario_sdk",
    arguments: { home_ref: homeRef },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(result.structuredContent.sdk, "[REDACTED]");
  assert.equal(result.structuredContent.sdk_complete, false);
  assert.doesNotMatch(
    result.content[0].text,
    /unexpected|parser|unterminated/i,
  );
});

test("credential-like native text outside the SDK declaration role stays hidden", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  hub.state.characteristic.control.value = {
    stringValue: "ok? token:synthetic-secret-must-not-leak",
  };

  const result = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: characteristicRef },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(
    result.structuredContent.entity.current_value.value,
    "[REDACTED]",
  );
  assert.doesNotMatch(result.content[0].text, /synthetic-secret-must-not-leak/);
});

test("an incomplete native SDK response stays an error instead of becoming a complete declaration", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  hub.state.scenarioSdk = null;

  const result = await client.callTool({
    name: "get_scenario_sdk",
    arguments: { home_ref: homeRef },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, "error");
  assert.equal(result.structuredContent.error.code, "incompatible_response");
  assert.equal(result.structuredContent.sdk, undefined);
  assert.equal(result.structuredContent.sdk_complete, undefined);
});

test("restoring an unapplied scenario change does not accuse a manual edit or cancel later apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.scenarios.push({
    index: "manual-logic",
    name: "Ручной LOGIC",
    desc: "Существующий код",
    active: true,
    onStart: false,
    sync: false,
    type: "LOGIC",
    data: firstLogicSource,
    predefined: false,
  });
  const fixture = installNativeCommandFixture(hub);
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== "all-off-command",
  );
  const client = await startClient(t, hub, stateDirectory);
  const cases = [
    {
      name: "logic_source_create",
      arguments: {
        operation: "logic_source_create",
        target_ref: serviceRef,
        name: "Черновик яркости",
        description: "Ещё не применённый JS",
        active: false,
        on_start: false,
        sync: false,
        source: firstLogicSource,
        reason: "Подготовить JS-черновик без записи",
      },
    },
    {
      name: "logic_source_update",
      arguments: {
        operation: "logic_source_update",
        target_ref: `${homeRef}/scenario/manual-logic`,
        source: secondLogicSource,
        reason: "Подготовить правку source без записи",
      },
    },
    {
      name: "block_create",
      arguments: {
        operation: "block_create",
        target_ref: homeRef,
        name: "Черновик выключения",
        description: "Ещё не применённый BLOCK",
        active: true,
        on_start: false,
        sync: false,
        data: fixture.data,
        reason: "Подготовить BLOCK-черновик без записи",
      },
    },
    {
      name: "block_data_update",
      arguments: {
        operation: "block_data_update",
        target_ref: scenarioRef,
        data: blockData({ delay: 90_000 }),
        reason: "Подготовить замену data без записи",
      },
    },
  ];

  for (const testCase of cases) {
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: testCase.arguments,
    });
    assert.equal(
      prepared.isError,
      undefined,
      `${testCase.name}: ${prepared.content[0]?.text}`,
    );
    assert.equal(prepared.structuredContent.status, "prepared", testCase.name);
    const writesBeforeRestore = scenarioWriteCount(hub);
    const scenariosBeforeRestore = hub.state.scenarios.length;

    const restored = await client.callTool({
      name: "restore_native_change",
      arguments: { change_ref: prepared.structuredContent.change_ref },
    });
    assertUnappliedScenarioRestore(restored, {
      tool: `restore_native_change ${testCase.name}`,
      hub,
      writesBefore: writesBeforeRestore,
      scenariosBefore: scenariosBeforeRestore,
    });

    const observed = await client.callTool({
      name: "get_native_change",
      arguments: { change_ref: prepared.structuredContent.change_ref },
    });
    assertUnappliedScenarioRestore(observed, {
      tool: `get_native_change ${testCase.name}`,
      hub,
      writesBefore: writesBeforeRestore,
      scenariosBefore: scenariosBeforeRestore,
    });

    const applied = await client.callTool({
      name: "apply_native_change",
      arguments: { change_ref: prepared.structuredContent.change_ref },
    });
    assert.equal(
      applied.isError,
      undefined,
      `${testCase.name}: ${applied.content[0]?.text}`,
    );
    assert.equal(applied.structuredContent.status, "applied", testCase.name);
    assert.ok(
      scenarioWriteCount(hub) > writesBeforeRestore,
      `${testCase.name}: later apply must still write`,
    );
  }
});

test("a rejected scenario change does not adopt a later matching source as its own", async (t) => {
  await t.test(
    "get after a later requested match stays not_owned",
    async (t) => {
      await assertRejectedLogicDoesNotAdopt(t, "get_native_change");
    },
  );
  await t.test(
    "direct restore after a later requested match does not write",
    async (t) => {
      await assertRejectedLogicDoesNotAdopt(t, "restore_native_change");
    },
  );
  await t.test(
    "explicit apply after the rejected restore still writes",
    async (t) => {
      for (const testCase of rejectedLogicAdoptionCases()) {
        const { hub, stateDirectory } = await setup(t);
        hub.state.scenarios.push(logicScenarioFixture(testCase.scenarioIndex));
        const client = await startClient(t, hub, stateDirectory);
        const draft = await prepareRejectedLogicDraft(client, hub, testCase);
        const writesBeforeApply = scenarioWriteCount(hub);
        const applied = await client.callTool({
          name: "apply_native_change",
          arguments: { change_ref: draft.change_ref },
        });
        assert.equal(
          applied.isError,
          undefined,
          `${testCase.name}: ${applied.content[0]?.text}`,
        );
        assert.equal(
          applied.structuredContent.status,
          "applied",
          testCase.name,
        );
        assert.ok(
          scenarioWriteCount(hub) > writesBeforeApply,
          `${testCase.name}: later apply must still write`,
        );
      }
    },
  );
});

test("a native LOGIC source is created, assigned, updated, read back, and restored through public tools", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  const sdk = await client.callTool({
    name: "get_scenario_sdk",
    arguments: { home_ref: homeRef },
  });
  assert.equal(sdk.isError, undefined, sdk.content[0]?.text);
  assert.equal(sdk.structuredContent.sdk, scenarioSdk);
  assert.equal(
    sdk.structuredContent.sha256,
    createHash("sha256").update(scenarioSdk).digest("hex"),
  );

  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Яркость при включении",
      description: "Установить стартовый уровень один раз",
      active: true,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Проверить нативную JS-логику без постоянного solver",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.equal(prepared.structuredContent.diff.source.exact_match, false);
  const stillPrepared = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(stillPrepared.structuredContent.status, "prepared");
  assert.equal(stillPrepared.structuredContent.logic_mapping_status, undefined);
  assert.equal(stillPrepared.structuredContent.logic_mapping_reason, undefined);

  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.isError, undefined, created.content[0]?.text);
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(
    created.structuredContent.native_logic_type,
    "GeneratedLogicType1",
  );
  assert.equal(
    created.structuredContent.logic_ref,
    `${serviceRef}/logic/GeneratedLogicType1`,
  );
  assert.notEqual(
    created.structuredContent.scenario_index,
    "GeneratedLogicType1",
  );
  assert.equal(created.structuredContent.diff.source.exact_match, true);
  assert.equal(
    created.structuredContent.diff.editable_flags.observed.description,
    "Set the initial brightness once",
  );
  const createdScenarioRef = created.structuredContent.scenario_ref;
  const createdSource = hub.requests.find(
    ({ scenario }) => scenario?.create?.type === "LOGIC",
  ).scenario.create.data;
  assert.match(
    createdSource,
    new RegExp(
      `\\[${created.structuredContent.ownership_marker.replaceAll("-", "\\-")}\\]`,
    ),
  );

  const assignment = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: created.structuredContent.logic_ref,
      reason: "Назначить созданную логику выбранному свету",
    },
  });
  const assigned = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: assignment.structuredContent.change_ref },
  });
  assert.equal(assigned.structuredContent.status, "applied");

  const restartedClient = await startClient(t, hub, stateDirectory);
  const history = await restartedClient.callTool({
    name: "list_native_changes",
    arguments: {
      home_ref: homeRef,
      entity_ref: created.structuredContent.logic_ref,
    },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.deepEqual(
    history.structuredContent.changes.map(({ operation }) => operation).sort(),
    ["logic_assignment", "logic_source_create"],
  );
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(persisted.structuredContent.status, "applied");
  assert.equal(persisted.structuredContent.diff.source.exact_match, true);

  const update = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_update",
      target_ref: createdScenarioRef,
      source: secondLogicSource,
      reason: "Уточнить условие перехода без изменения metadata",
    },
  });
  assert.equal(update.isError, undefined, update.content[0]?.text);
  const updated = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(updated.structuredContent.status, "applied");
  assert.equal(updated.structuredContent.diff.source.exact_match, true);
  assert.equal(
    updated.structuredContent.diff.editable_flags.observed.description,
    "Set the updated brightness once",
  );
  const readback = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: createdScenarioRef, include: ["configuration"] },
  });
  assert.equal(
    readback.structuredContent.entity.configuration.value,
    secondLogicSource,
  );
  assert.deepEqual(
    hub.state.scenarios.find(({ index }) => index === "created-1"),
    {
      name: "Яркость при включении",
      desc: "Set the updated brightness once",
      active: true,
      onStart: false,
      sync: false,
      type: "LOGIC",
      data: secondLogicSource,
      index: "created-1",
      predefined: false,
    },
  );

  const afterUpdateRestart = await startClient(t, hub, stateDirectory);
  const persistedUpdate = await afterUpdateRestart.callTool({
    name: "get_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(persistedUpdate.structuredContent.status, "applied");
  assert.equal(
    persistedUpdate.structuredContent.diff.editable_flags.observed.description,
    "Set the updated brightness once",
  );
  const sourceRestored = await afterUpdateRestart.callTool({
    name: "restore_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(sourceRestored.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.find(({ index }) => index === "created-1").data,
    createdSource,
  );
  assert.equal(
    hub.state.scenarios.find(({ index }) => index === "created-1").desc,
    "Set the initial brightness once",
  );
  const assignmentRestored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: assignment.structuredContent.change_ref },
  });
  assert.equal(assignmentRestored.structuredContent.status, "restored");
  const sourceRemoved = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(sourceRemoved.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "created-1"),
    false,
  );
  assert.equal(
    hub.state.logicTypes.some(({ type }) => type === "GeneratedLogicType1"),
    false,
  );
  const afterCleanup = await afterUpdateRestart.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(afterCleanup.structuredContent.status, "restored");
  assert.equal(afterCleanup.structuredContent.logic_mapping_status, undefined);
  assert.equal(afterCleanup.structuredContent.logic_mapping_reason, undefined);
});

test("a lost LOGIC create response is reconciled without creating a duplicate", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.scenarios.push({
    index: "neighbor-logic",
    name: "Соседний LOGIC",
    desc: "Set the initial brightness once",
    active: false,
    onStart: false,
    sync: false,
    type: "LOGIC",
    data: firstLogicSource,
    predefined: false,
  });
  hub.state.nextScenario = 8;
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Однократная яркость",
      description: "Проверить потерянный ответ",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Не дублировать уже созданный LOGIC",
    },
  });
  hub.state.behavior.closeAfterCreate = true;
  const recovered = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(
    recovered.structuredContent.recovered_after_uncertain_write,
    true,
  );
  assert.equal(recovered.structuredContent.scenario_index, "created-8");
  assert.match(
    hub.state.scenarios.find(({ index }) => index === "created-8").data,
    new RegExp(recovered.structuredContent.ownership_marker),
  );
  assert.equal(
    hub.state.scenarios.find(({ index }) => index === "neighbor-logic").data,
    firstLogicSource,
  );
  const repeated = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create?.type === "LOGIC")
      .length,
    1,
  );
});

test("an exact owned LOGIC source remains applied when the hub normalizes a create flag", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Нормализованный LOGIC",
      description: "Сохранить подтверждённый source",
      active: true,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Не смешивать source ownership с native-нормализацией",
    },
  });
  hub.state.behavior.afterCreate = () => {
    hub.state.scenarios.find(({ index }) => index === "created-1").active =
      false;
  };

  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(created.structuredContent.diff.source.exact_match, true);
  assert.equal(
    created.structuredContent.diff.editable_flags.exact_match,
    false,
  );
  assert.equal(created.structuredContent.diff.editable_flags.to.active, true);
  assert.equal(
    created.structuredContent.diff.editable_flags.observed.active,
    false,
  );

  const restartedClient = await startClient(t, hub, stateDirectory);
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(persisted.structuredContent.status, "applied");
  assert.equal(persisted.structuredContent.diff.source.exact_match, true);
  assert.equal(
    persisted.structuredContent.diff.editable_flags.observed.active,
    false,
  );

  const restored = await restartedClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "created-1"),
    false,
  );
});

test("an acknowledged LOGIC source delete that leaves the source stays uncertain across restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Неудалённый LOGIC",
      description: "Сохранить наблюдаемый результат неудачного удаления",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Не скрывать оставшийся source после ACK",
    },
  });
  const created = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.structuredContent.status, "applied");
  const createdScenario = structuredClone(
    hub.state.scenarios.find(({ index }) => index === "created-1"),
  );
  const createdLogicType = structuredClone(
    hub.state.logicTypes.find(({ type }) => type === "GeneratedLogicType1"),
  );
  hub.state.behavior.afterDelete = () => {
    hub.state.scenarios.push(createdScenario);
    hub.state.scenarioLogicTypes[createdScenario.index] = createdLogicType.type;
    hub.state.logicTypes.push(createdLogicType);
  };

  const uncertain = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.isError, undefined, uncertain.content[0]?.text);
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(
    uncertain.structuredContent.conflict_reason,
    "ack_without_requested_result",
  );
  assert.equal(uncertain.structuredContent.configuration_matches, false);
  assert.equal(
    uncertain.structuredContent.observed_source_sha256,
    createHash("sha256").update(createdScenario.data).digest("hex"),
  );
  assert.deepEqual(uncertain.structuredContent.diff.editable_flags.observed, {
    name: createdScenario.name,
    description: createdScenario.desc,
    active: createdScenario.active,
    on_start: createdScenario.onStart,
    sync: createdScenario.sync,
    type: createdScenario.type,
  });
  assert.equal(uncertain.structuredContent.write_intent.direction, "restore");
  assert.equal(
    uncertain.structuredContent.write_intent.phase,
    "needs_reconciliation",
  );
  assert.equal(uncertain.structuredContent.write_intent.acknowledged, true);
  assert.match(
    uncertain.structuredContent.write_intent.at,
    /^\d{4}-\d{2}-\d{2}T/,
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
  await firstClient.close();

  const restartedClient = await startClient(t, hub, stateDirectory);
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(persisted.isError, undefined, persisted.content[0]?.text);
  assert.equal(persisted.structuredContent.status, "uncertain");
  assert.equal(
    persisted.structuredContent.conflict_reason,
    "ack_without_requested_result",
  );
  assert.equal(
    persisted.structuredContent.observed_source_sha256,
    uncertain.structuredContent.observed_source_sha256,
  );
  assert.deepEqual(
    persisted.structuredContent.diff.editable_flags.observed,
    uncertain.structuredContent.diff.editable_flags.observed,
  );
  assert.deepEqual(
    persisted.structuredContent.write_intent,
    uncertain.structuredContent.write_intent,
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
});

test("an owned LOGIC source remains editable and restorable while its type mapping is initially missing", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Исправляемый LOGIC",
      description: "Сохранить владение отдельно от назначения",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Исправить source, если его тип пока не появился",
    },
  });
  hub.state.behavior.afterCreate = () => {
    hub.state.logicTypes = hub.state.logicTypes.filter(
      ({ type }) => type === smoothLogicType,
    );
  };

  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(
    created.structuredContent.scenario_ref,
    `${homeRef}/scenario/created-1`,
  );
  assert.equal(created.structuredContent.diff.source.exact_match, true);
  assert.equal(created.structuredContent.logic_mapping_status, "missing");
  assert.equal(created.structuredContent.logic_assignment_ready, false);
  assert.equal(
    created.structuredContent.logic_mapping_reason,
    "logic_type_not_visible_after_create",
  );
  assert.equal(created.structuredContent.restore_supported, false);

  const restartedClient = await startClient(t, hub, stateDirectory);
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(persisted.structuredContent.status, "applied");
  assert.equal(persisted.structuredContent.logic_mapping_status, "missing");
  assert.equal(
    persisted.structuredContent.logic_mapping_reason,
    "logic_type_not_visible_after_create",
  );

  const blockedRestore = await restartedClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(blockedRestore.structuredContent.status, "applied");
  assert.equal(blockedRestore.structuredContent.restore_supported, false);
  assert.equal(
    hub.requests.some(
      ({ scenario }) => scenario?.delete?.index === "created-1",
    ),
    false,
  );

  const update = await restartedClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_update",
      target_ref: created.structuredContent.scenario_ref,
      source: secondLogicSource,
      reason: "Исправить metadata исходника без нового сценария",
    },
  });
  hub.state.behavior.afterUpdate = () => {
    hub.state.logicTypes.push({
      type: "GeneratedLogicType1",
      name: "Исправляемый LOGIC",
      desc: "Доступен после исправления source",
    });
  };
  const updated = await restartedClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(updated.structuredContent.status, "applied");
  const sourceUpdates = hub.requests.filter(
    ({ scenario }) => scenario?.update?.index === "created-1",
  );
  assert.deepEqual(Object.keys(sourceUpdates.at(-1).scenario.update).sort(), [
    "data",
    "index",
  ]);

  const mappingRecovered = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(
    mappingRecovered.structuredContent.logic_mapping_status,
    "mapped",
  );
  assert.equal(mappingRecovered.structuredContent.logic_assignment_ready, true);
  assert.equal(
    mappingRecovered.structuredContent.native_logic_type,
    "GeneratedLogicType1",
  );

  const updateRestored = await restartedClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(updateRestored.structuredContent.status, "restored");
  delete hub.state.accessories[2].services;
  const sourceRestored = await restartedClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(sourceRestored.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "created-1"),
    false,
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create?.type === "LOGIC")
      .length,
    1,
  );
});

test("an ambiguous LOGIC type mapping survives restart and can be resolved without recreating the source", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Неоднозначный LOGIC",
      description: "Не терять подтверждённый source",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Разделить source и выбор native type",
    },
  });
  hub.state.behavior.afterCreate = () => {
    hub.state.logicTypes.push({
      type: "ConcurrentLogicType",
      name: "Чужой одновременный LOGIC",
      desc: "Не считать его своим",
    });
  };

  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(created.structuredContent.logic_mapping_status, "ambiguous");
  assert.equal(created.structuredContent.logic_assignment_ready, false);
  assert.equal(
    created.structuredContent.logic_mapping_reason,
    "ambiguous_logic_type",
  );
  assert.deepEqual(created.structuredContent.candidate_logic_types.sort(), [
    "ConcurrentLogicType",
    "GeneratedLogicType1",
  ]);

  const restartedClient = await startClient(t, hub, stateDirectory);
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(persisted.structuredContent.status, "applied");
  assert.equal(persisted.structuredContent.logic_mapping_status, "ambiguous");
  assert.equal(
    persisted.structuredContent.logic_mapping_reason,
    "ambiguous_logic_type",
  );

  hub.state.logicTypes = hub.state.logicTypes.filter(
    ({ type }) => type !== "ConcurrentLogicType",
  );
  const resolved = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(resolved.structuredContent.status, "applied");
  assert.equal(resolved.structuredContent.logic_mapping_status, "mapped");
  assert.equal(
    resolved.structuredContent.native_logic_type,
    "GeneratedLogicType1",
  );
  assert.equal(resolved.structuredContent.restore_supported, true);

  const restored = await restartedClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create?.type === "LOGIC")
      .length,
    1,
  );
});

test("LOGIC restoration rejects malformed present services without deleting its source", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Защищённый LOGIC",
      description: "Не удалять source при сломанном каталоге",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Отличить omitted repeated field от malformed",
    },
  });
  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.structuredContent.status, "applied");
  hub.state.accessories[2].services = {};

  const rejected = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /incompatible_response/);
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "created-1"),
    true,
  );
  assert.equal(
    hub.requests.some(
      ({ scenario }) => scenario?.delete?.index === "created-1",
    ),
    false,
  );
});

test("a rejected LOGIC create remains not applied", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Ошибочный LOGIC",
      description: "Проверить ошибку компиляции",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Не считать отклонённый source применённым",
    },
  });
  hub.state.behavior.rejectNextScenarioCreate = true;
  const rejected = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  const status = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(status.structuredContent.status, "not_applied");
  assert.equal(
    hub.state.scenarios.some(({ type }) => type === "LOGIC"),
    false,
  );
});

test("a LOGIC source update accepts derived metadata while preserving the manual-change guard", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.scenarios.push({
    index: "manual-logic",
    name: "Ручное имя до изменения",
    desc: "Ручное описание до изменения",
    active: true,
    onStart: false,
    sync: false,
    type: "LOGIC",
    data: firstLogicSource,
    predefined: false,
  });
  const client = await startClient(t, hub, stateDirectory);
  const update = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_update",
      target_ref: `${homeRef}/scenario/manual-logic`,
      source: secondLogicSource,
      reason: "Принять metadata, которые хаб выводит из точного source",
    },
  });
  hub.state.behavior.afterUpdate = () => {
    const scenario = hub.state.scenarios.find(
      ({ index }) => index === "manual-logic",
    );
    scenario.name = "Имя из нового source";
    scenario.desc = "Описание из нового source";
  };

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.configuration_matches, true);
  assert.equal(applied.structuredContent.diff.source.exact_match, true);
  assert.deepEqual(applied.structuredContent.diff.editable_flags.observed, {
    name: "Имя из нового source",
    description: "Описание из нового source",
    active: true,
    on_start: false,
    sync: false,
    type: "LOGIC",
  });

  const restartedClient = await startClient(t, hub, stateDirectory);
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(persisted.structuredContent.status, "applied");
  assert.equal(persisted.structuredContent.configuration_matches, true);
  assert.equal(persisted.structuredContent.diff.source.exact_match, true);

  const manualScenario = hub.state.scenarios.find(
    ({ index }) => index === "manual-logic",
  );
  manualScenario.name = "Ручная правка после apply";
  const protectedResult = await restartedClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(protectedResult.structuredContent.status, "conflict");
  assert.equal(
    protectedResult.structuredContent.conflict_reason,
    "manual_change",
  );
  assert.equal(
    hub.requests.filter(
      ({ scenario }) => scenario?.update?.index === "manual-logic",
    ).length,
    1,
  );

  manualScenario.name = "Имя из нового source";
  const recovered = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  hub.state.behavior.afterUpdate = () => {
    manualScenario.name = "Имя из исходного source";
    manualScenario.desc = "Описание из исходного source";
  };
  const restored = await restartedClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.configuration_matches, true);
  assert.equal(restored.structuredContent.diff.source.exact_match, true);
  assert.deepEqual(restored.structuredContent.diff.editable_flags.observed, {
    name: "Имя из исходного source",
    description: "Описание из исходного source",
    active: true,
    on_start: false,
    sync: false,
    type: "LOGIC",
  });
  assert.equal(manualScenario.data, firstLogicSource);

  const afterRestoreRestart = await startClient(t, hub, stateDirectory);
  const persistedRestore = await afterRestoreRestart.callTool({
    name: "get_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(persistedRestore.structuredContent.status, "restored");
  assert.equal(persistedRestore.structuredContent.configuration_matches, true);
  assert.equal(
    persistedRestore.structuredContent.diff.source.exact_match,
    true,
  );
  assert.deepEqual(
    persistedRestore.structuredContent.diff.editable_flags.observed,
    restored.structuredContent.diff.editable_flags.observed,
  );
});

test("LOGIC restoration preserves a manual source edit and an assigned created type", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.scenarios.push({
    index: "manual-logic",
    name: "Ручной LOGIC",
    desc: "Существующий код",
    active: true,
    onStart: false,
    sync: false,
    type: "LOGIC",
    data: firstLogicSource,
    predefined: false,
  });
  const client = await startClient(t, hub, stateDirectory);
  const update = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_update",
      target_ref: `${homeRef}/scenario/manual-logic`,
      source: secondLogicSource,
      reason: "Проверить сохранение ручной правки",
    },
  });
  const appliedUpdate = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(appliedUpdate.structuredContent.status, "applied");
  const manualScenario = hub.state.scenarios.find(
    ({ index }) => index === "manual-logic",
  );
  manualScenario.desc = "Ручное описание после записи source";
  const metadataConflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(metadataConflict.structuredContent.status, "conflict");
  assert.equal(
    metadataConflict.structuredContent.conflict_reason,
    "manual_change",
  );
  assert.equal(
    hub.requests.filter(
      ({ scenario }) => scenario?.update?.index === "manual-logic",
    ).length,
    1,
  );

  manualScenario.desc = "Set the updated brightness once";
  manualScenario.data = `${secondLogicSource}\n// manual edit`;
  const sourceConflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(sourceConflict.structuredContent.status, "conflict");
  assert.equal(
    sourceConflict.structuredContent.conflict_reason,
    "manual_change",
  );
  assert.match(
    hub.state.scenarios.find(({ index }) => index === "manual-logic").data,
    /manual edit$/,
  );

  const create = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Новый LOGIC",
      description: "Проверить чужое назначение",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Не удалять используемый LOGIC",
    },
  });
  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  hub.state.logics.push({
    aId: 32,
    sId: 13,
    type: created.structuredContent.native_logic_type,
    name: "Чужое назначение",
    active: true,
  });
  const assignmentConflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  assert.equal(assignmentConflict.structuredContent.status, "conflict");
  assert.equal(
    assignmentConflict.structuredContent.conflict_reason,
    "logic_assignments_present",
  );
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "created-1"),
    true,
  );
  assert.equal(
    hub.requests.some(
      ({ scenario }) => scenario?.delete?.index === "created-1",
    ),
    false,
  );
});

test("LOGIC restore blocked by assignments does not ask to prepare a new LOGIC", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "LOGIC с чужим назначением",
      description: "Проверить причину blocked restore",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Не предлагать новый LOGIC вместо снятия назначения",
    },
  });
  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.structuredContent.status, "applied");
  const scenarioIndex = created.structuredContent.scenario_index;
  const appliedSource = hub.state.scenarios.find(
    ({ index }) => index === scenarioIndex,
  ).data;
  hub.state.logics.push({
    aId: 32,
    sId: 13,
    type: created.structuredContent.native_logic_type,
    name: "Чужое назначение",
    active: true,
  });

  const blocked = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assertAssignedLogicRestoreBlocked(blocked, {
    tool: "restore_native_change",
    type: created.structuredContent.native_logic_type,
    scenarioIndex,
    hub,
  });
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === scenarioIndex),
    true,
  );

  // get first while the applied source is intact. Restore-first after a later
  // source edit is a separate observation so one order does not hide the other.
  const writesBeforeMatchingGet = scenarioWriteCount(hub);
  const matchingGet = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assertAssignedLogicStillApplied(matchingGet, {
    tool: "get_native_change after blocked restore",
    scenarioIndex,
    hub,
    writesBefore: writesBeforeMatchingGet,
  });

  const blockedAfterMatchingGet = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assertAssignedLogicRestoreBlocked(blockedAfterMatchingGet, {
    tool: "restore_native_change after get applied",
    type: created.structuredContent.native_logic_type,
    scenarioIndex,
    hub,
  });

  const createdScenario = hub.state.scenarios.find(
    ({ index }) => index === scenarioIndex,
  );
  createdScenario.data = `${appliedSource}\n// manual edit`;
  const mismatchedGetFirst = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assertCurrentLogicSourceMismatch(mismatchedGetFirst, {
    tool: "get_native_change first after source mismatch",
    targetRef: serviceRef,
    scenarioIndex,
    hub,
  });

  createdScenario.data = appliedSource;
  const blockedForRestoreFirst = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assertAssignedLogicRestoreBlocked(blockedForRestoreFirst, {
    tool: "restore_native_change before restore-first mismatch",
    type: created.structuredContent.native_logic_type,
    scenarioIndex,
    hub,
  });
  createdScenario.data = `${appliedSource}\n// manual edit`;
  const mismatchedRestore = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assertCurrentLogicSourceMismatch(mismatchedRestore, {
    tool: "restore_native_change",
    targetRef: serviceRef,
    scenarioIndex,
    hub,
  });
  const mismatchedGet = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assertCurrentLogicSourceMismatch(mismatchedGet, {
    tool: "get_native_change",
    targetRef: serviceRef,
    scenarioIndex,
    hub,
  });

  hub.state.logics.length = 0;
  const afterRemovalRestore = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assertCurrentLogicSourceMismatch(afterRemovalRestore, {
    tool: "restore_native_change after assignment removal",
    targetRef: serviceRef,
    scenarioIndex,
    hub,
  });
  const afterRemovalGet = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assertCurrentLogicSourceMismatch(afterRemovalGet, {
    tool: "get_native_change after assignment removal",
    targetRef: serviceRef,
    scenarioIndex,
    hub,
  });

  createdScenario.data = appliedSource;
  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === scenarioIndex),
    false,
  );
  assert.equal(
    hub.requests.some(
      ({ scenario }) => scenario?.delete?.index === scenarioIndex,
    ),
    true,
  );
});

function scenarioWriteCount(hub) {
  return hub.requests.filter(
    ({ scenario }) => scenario?.create || scenario?.update || scenario?.delete,
  ).length;
}

function assertUnappliedPauseRestore(
  result,
  { tool, hub, writesBefore, originalData, scenariosBefore = 1 },
) {
  assertUnappliedScenarioRestore(result, {
    tool,
    hub,
    writesBefore,
    scenariosBefore,
  });
  assert.equal(
    result.structuredContent.native_write_sent,
    false,
    `${tool} must not record a hub send`,
  );
  assert.equal(
    result.structuredContent.pause_effect.status,
    "not_started",
    tool,
  );
  if (originalData !== undefined) {
    assert.equal(
      hub.state.scenarios[0]?.data,
      originalData,
      `${tool} must keep the original BLOCK rule`,
    );
  }
}

function assertUnappliedScenarioRestore(
  result,
  { tool, hub, writesBefore, scenariosBefore },
) {
  assert.equal(
    result.isError,
    undefined,
    `${tool}: ${result.content[0]?.text}`,
  );
  assert.equal(result.structuredContent.status, "not_owned", tool);
  assert.equal(
    result.structuredContent.conflict_reason,
    "change_was_not_applied",
    tool,
  );
  assert.equal(
    result.structuredContent.next,
    undefined,
    `${tool} must not cancel the draft by asking for a new prepare`,
  );
  assert.equal(
    scenarioWriteCount(hub),
    writesBefore,
    `${tool} must not write to the hub`,
  );
  assert.equal(
    hub.state.scenarios.length,
    scenariosBefore,
    `${tool} must not create or delete a scenario`,
  );
}

function logicScenarioFixture(index, source = firstLogicSource) {
  return {
    index,
    name: "Ручной LOGIC",
    desc: "Существующий код",
    active: true,
    onStart: false,
    sync: false,
    type: "LOGIC",
    data: source,
    predefined: false,
  };
}

function rejectedLogicAdoptionCases() {
  return [
    {
      name: "logic_source_update",
      scenarioIndex: "manual-logic",
      arguments: {
        operation: "logic_source_update",
        target_ref: `${homeRef}/scenario/manual-logic`,
        source: secondLogicSource,
        reason: "Подготовить правку source, которую хаб отклонит",
      },
    },
    {
      name: "logic_source_create",
      scenarioIndex: "manual-logic",
      arguments: {
        operation: "logic_source_create",
        target_ref: serviceRef,
        name: "Черновик после отказа",
        description: "Отклонённый JS не становится своим",
        active: false,
        on_start: false,
        sync: false,
        source: firstLogicSource,
        reason: "Подготовить create, который хаб отклонит",
      },
    },
  ];
}

async function prepareRejectedLogicDraft(client, hub, testCase) {
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: testCase.arguments,
  });
  assert.equal(
    prepared.isError,
    undefined,
    `${testCase.name}: ${prepared.content[0]?.text}`,
  );
  assert.equal(prepared.structuredContent.status, "prepared", testCase.name);
  if (testCase.name === "logic_source_create") {
    hub.state.behavior.rejectNextScenarioCreate = true;
  } else {
    hub.state.behavior.rejectNextScenarioUpdate = true;
  }
  const rejected = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true, testCase.name);
  const status = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(status.structuredContent.status, "not_applied", testCase.name);
  assert.equal(status.structuredContent.native_write_sent, true, testCase.name);
  const writesBeforeRestore = scenarioWriteCount(hub);
  const scenariosBeforeRestore = hub.state.scenarios.length;
  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assertUnappliedScenarioRestore(restored, {
    tool: `restore after rejected ${testCase.name}`,
    hub,
    writesBefore: writesBeforeRestore,
    scenariosBefore: scenariosBeforeRestore,
  });
  return prepared.structuredContent;
}

function plantRequestedLogicSource(hub, testCase, draft) {
  if (testCase.name === "logic_source_update") {
    const scenario = hub.state.scenarios.find(
      ({ index }) => index === testCase.scenarioIndex,
    );
    assert.ok(scenario, `${testCase.name}: missing ${testCase.scenarioIndex}`);
    scenario.data = secondLogicSource;
    return;
  }
  const marker = draft.ownership_marker;
  assert.equal(typeof marker, "string", testCase.name);
  const sent = hub.requests.find(({ scenario }) =>
    scenario?.create?.data?.includes(`/* [${marker}] */`),
  )?.scenario.create;
  assert.ok(sent, `${testCase.name}: rejected create must have been sent`);
  hub.state.scenarios.push({
    index: "foreign-logic",
    name: sent.name,
    desc: sent.desc,
    active: sent.active,
    onStart: sent.onStart,
    sync: sent.sync,
    type: "LOGIC",
    data: sent.data,
    predefined: false,
  });
}

function assertForeignLogicSourceKept(hub, testCase) {
  if (testCase.name === "logic_source_update") {
    assert.equal(
      hub.state.scenarios.find(({ index }) => index === testCase.scenarioIndex)
        ?.data,
      secondLogicSource,
      `${testCase.name}: matching source must stay`,
    );
    return;
  }
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "foreign-logic"),
    true,
    `${testCase.name}: matching create must stay`,
  );
}

async function assertRejectedLogicDoesNotAdopt(t, tool) {
  for (const testCase of rejectedLogicAdoptionCases()) {
    const { hub, stateDirectory } = await setup(t);
    hub.state.scenarios.push(logicScenarioFixture(testCase.scenarioIndex));
    const client = await startClient(t, hub, stateDirectory);
    const draft = await prepareRejectedLogicDraft(client, hub, testCase);
    plantRequestedLogicSource(hub, testCase, draft);
    const writesBefore = scenarioWriteCount(hub);
    const scenariosBefore = hub.state.scenarios.length;
    const result = await client.callTool({
      name: tool,
      arguments: { change_ref: draft.change_ref },
    });
    assertUnappliedScenarioRestore(result, {
      tool: `${tool} ${testCase.name}`,
      hub,
      writesBefore,
      scenariosBefore,
    });
    assertForeignLogicSourceKept(hub, testCase);
  }
}

function assertAssignedLogicStillApplied(
  result,
  { tool, scenarioIndex, hub, writesBefore },
) {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(result.structuredContent.status, "applied", tool);
  assert.equal(result.structuredContent.configuration_matches, true, tool);
  assert.equal("logic_assignments" in result.structuredContent, false, tool);
  assertDoesNotAskToPrepareNewLogic(result, tool);
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === scenarioIndex),
    true,
    tool,
  );
  assert.equal(
    scenarioWriteCount(hub),
    writesBefore,
    `${tool} must not write after a blocked restore`,
  );
}

function assertDoesNotAskToPrepareNewLogic(result, tool) {
  assert.equal(
    result.structuredContent.next,
    undefined,
    `${tool} must not treat assignment conflict as a new LOGIC prepare`,
  );
  assert.doesNotMatch(
    result.structuredContent.limitations.join("\n"),
    /already applied[\s\S]*Prepare a new authorized change/i,
    tool,
  );
}

function assertAssignedLogicRestoreBlocked(
  result,
  { tool, type, scenarioIndex, hub },
) {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(result.structuredContent.status, "conflict", tool);
  assert.equal(
    result.structuredContent.conflict_reason,
    "logic_assignments_present",
    tool,
  );
  assert.equal(result.structuredContent.restore_supported, true, tool);
  assert.deepEqual(result.structuredContent.logic_assignments, [
    {
      ref: `${homeRef}/accessory/32/service/13/logic/${encodeURIComponent(type)}`,
      active: true,
    },
  ]);
  assertDoesNotAskToPrepareNewLogic(result, tool);
  assert.equal(
    hub.requests.some(
      ({ scenario }) => scenario?.delete?.index === scenarioIndex,
    ),
    false,
    `${tool} must not delete a LOGIC that still has assignments`,
  );
}

function assertCurrentLogicSourceMismatch(
  result,
  { tool, targetRef, scenarioIndex, hub },
) {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(result.structuredContent.status, "conflict", tool);
  assert.equal(result.structuredContent.conflict_reason, "manual_change", tool);
  assert.equal(result.structuredContent.configuration_matches, false, tool);
  assert.equal("logic_assignments" in result.structuredContent, false, tool);
  assert.deepEqual(
    result.structuredContent.next,
    {
      tool: "get_native_change_contract",
      arguments: {
        operation: "logic_source_create",
        target_ref: targetRef,
      },
    },
    tool,
  );
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === scenarioIndex),
    true,
    tool,
  );
  assert.equal(
    hub.requests.some(
      ({ scenario }) => scenario?.delete?.index === scenarioIndex,
    ),
    false,
    `${tool} must not delete after a source mismatch`,
  );
}

const scenarioActiveCases = [
  {
    type: "BLOCK",
    install(hub) {
      const scenario = hub.state.scenarios.find(
        ({ index }) => index === "existing-block",
      );
      scenario.active = true;
      return scenario;
    },
  },
  {
    type: "LOGIC",
    install(hub) {
      const scenario = {
        index: "evening-logic",
        name: "Вечерняя яркость",
        desc: "Set the initial brightness once",
        active: true,
        onStart: false,
        sync: false,
        type: "LOGIC",
        data: firstLogicSource,
      };
      hub.state.scenarios.push(scenario);
      return scenario;
    },
  },
  {
    type: "GLOBAL",
    install(hub) {
      const scenario = {
        index: "global-helpers",
        name: "Общие функции",
        desc: "",
        active: true,
        onStart: true,
        sync: false,
        type: "GLOBAL",
        data: 'log.info("helpers ready");',
      };
      hub.state.scenarios.push(scenario);
      return scenario;
    },
  },
];

function scenarioRefFor(scenario) {
  return `${homeRef}/scenario/${encodeURIComponent(scenario.index)}`;
}

function scenarioUpdates(hub) {
  return hub.requests
    .filter(({ scenario }) => scenario?.update)
    .map(({ scenario }) => scenario.update);
}

function scenarioWithoutActive(scenario) {
  const { active: _active, ...configuration } = structuredClone(scenario);
  return configuration;
}

async function prepareScenarioActive(client, targetRef, value) {
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_active",
      target_ref: targetRef,
      value,
      reason: "Выключить сценарий, пока хозяева в отъезде",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  return prepared.structuredContent;
}

async function callChangeTool(client, name, changeRef) {
  const result = await client.callTool({
    name,
    arguments: { change_ref: changeRef },
  });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

test("an existing scenario of any type is turned off and back on through its active flag only", async (t) => {
  for (const scenarioCase of scenarioActiveCases) {
    await t.test(scenarioCase.type, async (subtest) => {
      const { hub, stateDirectory } = await setup(subtest);
      const scenario = scenarioCase.install(hub);
      const targetRef = scenarioRefFor(scenario);
      const configuration = scenarioWithoutActive(scenario);
      const firstClient = await startClient(subtest, hub, stateDirectory);

      const contract = await firstClient.callTool({
        name: "get_native_change_contract",
        arguments: { operation: "scenario_active", target_ref: targetRef },
      });
      assert.equal(contract.isError, undefined, contract.content[0]?.text);
      assert.equal(contract.structuredContent.contract.kind, "boolValue");
      assert.equal(contract.structuredContent.restore_supported, true);

      const prepared = await prepareScenarioActive(
        firstClient,
        targetRef,
        false,
      );
      assert.equal(prepared.status, "prepared");
      assert.equal(prepared.operation, "scenario_active");
      assert.deepEqual(prepared.diff, {
        value: { from: true, to: false, kind: "boolValue" },
      });
      assert.deepEqual(scenarioUpdates(hub), []);

      const applied = await callChangeTool(
        firstClient,
        "apply_native_change",
        prepared.change_ref,
      );
      assert.equal(applied.status, "applied");
      assert.equal(applied.native_acknowledged, true);
      assert.deepEqual(applied.observed_value, {
        value: false,
        kind: "boolValue",
      });
      assert.deepEqual(scenarioUpdates(hub), [
        { index: scenario.index, active: false },
      ]);
      assert.equal(scenario.active, false);
      assert.deepEqual(scenarioWithoutActive(scenario), configuration);

      const history = await firstClient.callTool({
        name: "list_native_changes",
        arguments: { home_ref: homeRef, entity_ref: targetRef },
      });
      assert.deepEqual(
        history.structuredContent.changes.map(
          ({ change_ref, operation, recorded_status }) => ({
            change_ref,
            operation,
            recorded_status,
          }),
        ),
        [
          {
            change_ref: prepared.change_ref,
            operation: "scenario_active",
            recorded_status: "applied",
          },
        ],
      );

      await firstClient.close();
      const secondClient = await startClient(subtest, hub, stateDirectory);
      const restored = await callChangeTool(
        secondClient,
        "restore_native_change",
        prepared.change_ref,
      );
      assert.equal(restored.status, "restored");
      assert.deepEqual(scenarioUpdates(hub), [
        { index: scenario.index, active: false },
        { index: scenario.index, active: true },
      ]);
      assert.equal(scenario.active, true);
      assert.deepEqual(scenarioWithoutActive(scenario), configuration);
    });
  }
});

test("a hand-toggled scenario is neither overwritten on apply nor reclaimed on restore", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const scenario = scenarioActiveCases[0].install(hub);
  const targetRef = scenarioRefFor(scenario);
  const client = await startClient(t, hub, stateDirectory);

  const stale = await prepareScenarioActive(client, targetRef, false);
  scenario.active = false;
  const refused = await callChangeTool(
    client,
    "apply_native_change",
    stale.change_ref,
  );
  assert.equal(refused.status, "conflict");
  assert.equal(refused.conflict_reason, "baseline_changed");
  assert.deepEqual(scenarioUpdates(hub), []);

  scenario.active = true;
  const prepared = await prepareScenarioActive(client, targetRef, false);
  const applied = await callChangeTool(
    client,
    "apply_native_change",
    prepared.change_ref,
  );
  assert.equal(applied.status, "applied");
  scenario.active = true;
  const observed = await callChangeTool(
    client,
    "get_native_change",
    prepared.change_ref,
  );
  assert.equal(observed.status, "conflict");
  assert.equal(observed.manual_change_observed, true);

  scenario.active = false;
  const restored = await callChangeTool(
    client,
    "restore_native_change",
    prepared.change_ref,
  );
  assert.equal(restored.status, "conflict");
  assert.equal(restored.conflict_reason, "manual_change");
  assert.deepEqual(scenarioUpdates(hub), [
    { index: scenario.index, active: false },
  ]);
  assert.equal(scenario.active, false);
});

test("a lost scenario.update response is settled by readback without a second update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const scenario = scenarioActiveCases[0].install(hub);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await prepareScenarioActive(
    firstClient,
    scenarioRefFor(scenario),
    false,
  );
  hub.state.behavior.closeAfterScenarioUpdate = true;

  const applied = await callChangeTool(
    firstClient,
    "apply_native_change",
    prepared.change_ref,
  );
  assert.equal(applied.status, "applied");
  assert.equal(applied.native_acknowledged, false);
  assert.equal(applied.recovered_after_uncertain_write, true);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await callChangeTool(
    secondClient,
    "apply_native_change",
    prepared.change_ref,
  );
  assert.equal(repeated.status, "applied");
  assert.deepEqual(scenarioUpdates(hub), [
    { index: scenario.index, active: false },
  ]);
  assert.equal(scenario.active, false);
});

test("an already inactive scenario creates no change or write", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const scenario = hub.state.scenarios.find(
    ({ index }) => index === "existing-block",
  );
  assert.equal(scenario.active, false);

  const prepared = await prepareScenarioActive(
    client,
    scenarioRefFor(scenario),
    false,
  );
  assert.deepEqual(prepared, {
    status: "already_desired",
    operation: "scenario_active",
    target_ref: scenarioRefFor(scenario),
    observed_value: { value: false, kind: "boolValue" },
    native_write_sent: false,
    owned_change_created: false,
  });
  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRefFor(scenario) },
  });
  assert.deepEqual(history.structuredContent.changes, []);
  assert.deepEqual(scenarioUpdates(hub), []);
});

test("a scenario ref of another home is rejected before any scenario request", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.scenarios[0].active = true;
  const client = await startClient(t, hub, stateDirectory);
  const foreignRef = "spruthub://hub/other-home/scenario/existing-block";

  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "scenario_active", target_ref: foreignRef },
  });
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_active",
      target_ref: foreignRef,
      value: false,
      reason: "Не трогать сценарий другого дома",
    },
  });
  for (const refused of [contract, prepared]) {
    assert.equal(refused.isError, true);
    assert.equal(
      refused.structuredContent?.error?.code,
      "unsupported_home_write",
      refused.content[0]?.text,
    );
  }
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.get || scenario?.update),
    false,
  );
  assert.equal(hub.state.scenarios[0].active, true);
});

test("a scenario whose active state SprutHub omits is neither switched nor restored on a guess", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const scenario = scenarioActiveCases[0].install(hub);
  const targetRef = scenarioRefFor(scenario);
  const client = await startClient(t, hub, stateDirectory);
  const assertIncompatible = (result) => {
    assert.equal(result.isError, true, result.content[0]?.text);
    assert.equal(
      result.structuredContent.error.code,
      "incompatible_response",
      result.content[0]?.text,
    );
  };

  delete scenario.active;
  assertIncompatible(
    await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "scenario_active",
        target_ref: targetRef,
        value: true,
        reason: "Включить сценарий",
      },
    }),
  );
  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: targetRef },
  });
  assert.deepEqual(history.structuredContent.changes, []);

  scenario.active = true;
  const pending = await prepareScenarioActive(client, targetRef, false);
  delete scenario.active;
  assertIncompatible(
    await client.callTool({
      name: "apply_native_change",
      arguments: { change_ref: pending.change_ref },
    }),
  );
  assert.deepEqual(scenarioUpdates(hub), []);

  scenario.active = true;
  const applied = await callChangeTool(
    client,
    "apply_native_change",
    pending.change_ref,
  );
  assert.equal(applied.status, "applied");
  delete scenario.active;
  assertIncompatible(
    await client.callTool({
      name: "restore_native_change",
      arguments: { change_ref: pending.change_ref },
    }),
  );
  assert.deepEqual(scenarioUpdates(hub), [
    { index: scenario.index, active: false },
  ]);
});

async function turnScenarioOffWithChange(client, targetRef) {
  const prepared = await prepareScenarioActive(client, targetRef, false);
  const applied = await callChangeTool(
    client,
    "apply_native_change",
    prepared.change_ref,
  );
  assert.equal(applied.status, "applied");
}

const scenarioTurnOffCases = [
  {
    name: "with a scenario_active change",
    turnOff: turnScenarioOffWithChange,
  },
  {
    name: "by hand in the SprutHub interface",
    turnOff: async (_client, _targetRef, scenario) => {
      scenario.active = false;
    },
  },
];

test("a BLOCK data update stays owned after its scenario is turned off and restores only its data", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const scenario = scenarioActiveCases[0].install(hub);
  const targetRef = scenarioRefFor(scenario);
  const firstClient = await startClient(t, hub, stateDirectory);
  const update = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: targetRef,
      data: blockData({ delay: 45_000 }),
      reason: "Сократить задержку ночника",
    },
  });
  assert.equal(update.isError, undefined, update.content[0]?.text);
  const updateRef = update.structuredContent.change_ref;
  const applied = await callChangeTool(
    firstClient,
    "apply_native_change",
    updateRef,
  );
  assert.equal(applied.status, "applied");

  await turnScenarioOffWithChange(firstClient, targetRef);
  assert.equal(scenario.active, false);
  const observed = await callChangeTool(
    firstClient,
    "get_native_change",
    updateRef,
  );
  assert.equal(observed.status, "applied");
  assert.equal(observed.configuration_matches, true);

  const writesBeforeRestore = scenarioUpdates(hub).length;
  const appliedData = scenario.data;
  scenario.data = JSON.stringify({
    ...JSON.parse(appliedData),
    manual: "keep",
  });
  const refused = await callChangeTool(
    firstClient,
    "restore_native_change",
    updateRef,
  );
  assert.equal(refused.status, "conflict");
  assert.equal(refused.conflict_reason, "manual_change");
  assert.equal(scenarioUpdates(hub).length, writesBeforeRestore);
  scenario.data = appliedData;

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await callChangeTool(
    secondClient,
    "restore_native_change",
    updateRef,
  );
  assert.equal(restored.status, "restored");
  assert.equal(restored.configuration_matches, true);
  const restoreWrites = scenarioUpdates(hub).slice(writesBeforeRestore);
  assert.equal(restoreWrites.length, 1);
  assert.deepEqual(Object.keys(restoreWrites[0]).sort(), ["data", "index"]);
  assert.equal(JSON.parse(scenario.data).targets[0].then[1].time, 60_000);
  assert.equal(scenario.active, false);
});

test("a created BLOCK that was turned off is still deleted by its restore", async (t) => {
  for (const turnOffCase of scenarioTurnOffCases) {
    await t.test(turnOffCase.name, async (subtest) => {
      const { hub, stateDirectory } = await setup(subtest);
      const client = await startClient(subtest, hub, stateDirectory);
      const data = blockData();
      delete data.vendorConfiguration;
      const prepared = await prepareBlockCreate(client, {
        name: "Ночник в коридоре",
        data,
        reason: "Включать ночник в коридоре по движению",
      });
      const createRef = prepared.structuredContent.change_ref;
      const created = await callChangeTool(
        client,
        "apply_native_change",
        createRef,
      );
      assert.equal(created.status, "applied");
      const scenario = hub.state.scenarios.find(
        ({ index }) => index === created.scenario_index,
      );
      assert.equal(scenario.active, true);

      await turnOffCase.turnOff(client, created.scenario_ref, scenario);
      assert.equal(scenario.active, false);
      const observed = await callChangeTool(
        client,
        "get_native_change",
        createRef,
      );
      assert.equal(observed.status, "applied");

      const restored = await callChangeTool(
        client,
        "restore_native_change",
        createRef,
      );
      assert.equal(restored.status, "restored");
      assert.deepEqual(
        scenarioDeletes(hub).map(({ scenario: request }) => request.delete),
        [{ index: created.scenario_index }],
      );
      assert.equal(
        hub.state.scenarios.some(
          ({ index }) => index === created.scenario_index,
        ),
        false,
      );
    });
  }
});

test("a LOGIC source change stays restorable after its scenario is turned off", async (t) => {
  await t.test("a created source is deleted", async (subtest) => {
    const { hub, stateDirectory } = await setup(subtest);
    const client = await startClient(subtest, hub, stateDirectory);
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "logic_source_create",
        target_ref: serviceRef,
        name: "Ночная яркость",
        description: "Приглушать свет ночью",
        active: true,
        on_start: false,
        sync: false,
        source: firstLogicSource,
        reason: "Приглушать свет ночью",
      },
    });
    assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
    const createRef = prepared.structuredContent.change_ref;
    const created = await callChangeTool(
      client,
      "apply_native_change",
      createRef,
    );
    assert.equal(created.status, "applied");
    const scenario = hub.state.scenarios.find(
      ({ index }) => index === created.scenario_index,
    );

    await turnScenarioOffWithChange(client, created.scenario_ref);
    assert.equal(scenario.active, false);
    const observed = await callChangeTool(
      client,
      "get_native_change",
      createRef,
    );
    assert.equal(observed.status, "applied");

    const restored = await callChangeTool(
      client,
      "restore_native_change",
      createRef,
    );
    assert.equal(restored.status, "restored");
    assert.deepEqual(
      scenarioDeletes(hub).map(({ scenario: request }) => request.delete),
      [{ index: created.scenario_index }],
    );
  });

  await t.test("an updated source is put back", async (subtest) => {
    const { hub, stateDirectory } = await setup(subtest);
    const scenario = logicScenarioFixture("evening-logic");
    hub.state.scenarios.push(scenario);
    const targetRef = scenarioRefFor(scenario);
    const client = await startClient(subtest, hub, stateDirectory);
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "logic_source_update",
        target_ref: targetRef,
        source: secondLogicSource,
        reason: "Поменять вечернюю яркость",
      },
    });
    assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
    const updateRef = prepared.structuredContent.change_ref;
    const applied = await callChangeTool(
      client,
      "apply_native_change",
      updateRef,
    );
    assert.equal(applied.status, "applied");

    await turnScenarioOffWithChange(client, targetRef);
    assert.equal(scenario.active, false);
    const observed = await callChangeTool(
      client,
      "get_native_change",
      updateRef,
    );
    assert.equal(observed.status, "applied");

    const restored = await callChangeTool(
      client,
      "restore_native_change",
      updateRef,
    );
    assert.equal(restored.status, "restored");
    assert.equal(scenario.data, firstLogicSource);
    assert.equal(scenario.active, false);
    assert.deepEqual(Object.keys(scenarioUpdates(hub).at(-1)).sort(), [
      "data",
      "index",
    ]);
  });
});

test("scenario_active prepared with active instead of value points to value before touching the hub", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const scenario = scenarioActiveCases[0].install(hub);
  const targetRef = scenarioRefFor(scenario);
  const client = await startClient(t, hub, stateDirectory);
  const reason = "Выключить ночник на время отъезда";

  const misplaced = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "scenario_active",
      target_ref: targetRef,
      active: false,
      reason,
    },
  });
  assert.equal(misplaced.isError, true);
  assert.equal(
    misplaced.structuredContent.error.code,
    "invalid_native_value",
    misplaced.content[0]?.text,
  );
  assert.deepEqual(misplaced.structuredContent.next, {
    tool: "prepare_native_change",
    arguments: {
      operation: "scenario_active",
      target_ref: targetRef,
      value: false,
      reason,
    },
  });
  assert.deepEqual(scenarioUpdates(hub), []);
  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: targetRef },
  });
  assert.deepEqual(history.structuredContent.changes, []);

  const followed = await client.callTool({
    name: misplaced.structuredContent.next.tool,
    arguments: misplaced.structuredContent.next.arguments,
  });
  assert.equal(followed.isError, undefined, followed.content[0]?.text);
  assert.equal(followed.structuredContent.status, "prepared");
  assert.deepEqual(followed.structuredContent.diff, {
    value: { from: true, to: false, kind: "boolValue" },
  });
  assert.equal(scenario.active, true);
});

test("logic_active prepared with active instead of value points to value", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.logics.push(assignedSmoothLogic());
  const client = await startClient(t, hub, stateDirectory);
  const misplaced = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_active",
      target_ref: smoothLogicRef,
      active: true,
      reason: "Включить плавную яркость",
    },
  });
  assert.equal(misplaced.isError, true);
  assert.equal(
    misplaced.structuredContent.error.code,
    "invalid_native_value",
    misplaced.content[0]?.text,
  );
  const followed = await client.callTool({
    name: misplaced.structuredContent.next.tool,
    arguments: misplaced.structuredContent.next.arguments,
  });
  assert.equal(followed.isError, undefined, followed.content[0]?.text);
  assert.equal(followed.structuredContent.status, "prepared");
  assert.deepEqual(followed.structuredContent.diff, {
    value: { from: false, to: true, kind: "boolValue" },
  });
  assert.equal(hub.state.logics[0].active, false);
});

const twoChannelSwitch = {
  id: 40,
  roomId: 1,
  name: "Выключатель у дивана",
  online: true,
  services: [
    {
      aId: 40,
      sId: 10,
      name: "Канал 1",
      type: "Switch",
      visible: true,
      characteristics: [
        {
          aId: 40,
          sId: 10,
          cId: 20,
          control: {
            name: "Включено",
            type: "On",
            read: true,
            write: true,
            value: { boolValue: false },
          },
        },
      ],
    },
    {
      aId: 40,
      sId: 11,
      name: "Канал 2",
      type: "Switch",
      visible: true,
      characteristics: [
        {
          aId: 40,
          sId: 11,
          cId: 21,
          control: {
            name: "Включено",
            type: "On",
            read: true,
            write: true,
            value: { boolValue: true },
          },
        },
      ],
    },
    {
      aId: 40,
      sId: 12,
      name: "Температура устройства",
      type: "TemperatureSensor",
      visible: true,
      characteristics: [
        {
          aId: 40,
          sId: 12,
          cId: 22,
          control: {
            name: "Текущая температура",
            type: "CurrentTemperature",
            read: true,
            write: false,
            value: { doubleValue: 41.5 },
          },
        },
      ],
    },
  ],
};

function installTwoChannelSwitch(hub) {
  const accessory = structuredClone(twoChannelSwitch);
  hub.state.accessories.push(accessory);
  return accessory;
}

// Each case names the household request, the entity the fake hub keeps, and
// the exact native update expected for one value.
const roomServiceSettingCases = [
  {
    operation: "room_name",
    targetRef: `${homeRef}/room/1`,
    foreignRef: "spruthub://hub/other-home/room/1",
    kind: "stringValue",
    field: "name",
    baseline: "Зал",
    input: "  Гостиная ",
    requested: "Гостиная",
    changedBeforeApply: "Кухня",
    changedAfterApply: "Кухня",
    install(hub) {
      const room = hub.state.rooms.find(({ id }) => id === 1);
      room.name = "Зал";
      return room;
    },
    locate: (room) => room,
    update: (name) => ({ room: { update: { id: 1, name } } }),
  },
  {
    operation: "service_name",
    targetRef: `${homeRef}/accessory/40/service/11`,
    foreignRef: "spruthub://hub/other-home/accessory/40/service/11",
    kind: "stringValue",
    field: "name",
    baseline: "Канал 2",
    input: " Подсветка ",
    requested: "Подсветка",
    changedBeforeApply: "Свет у дивана",
    changedAfterApply: "Свет у дивана",
    install: installTwoChannelSwitch,
    locate: (accessory) => accessory.services.find(({ sId }) => sId === 11),
    update: (name) => ({ service: { update: { aId: 40, sId: 11, name } } }),
  },
  {
    operation: "service_visible",
    targetRef: `${homeRef}/accessory/40/service/12`,
    foreignRef: "spruthub://hub/other-home/accessory/40/service/12",
    kind: "boolValue",
    field: "visible",
    baseline: true,
    input: false,
    requested: false,
    changedBeforeApply: false,
    changedAfterApply: true,
    install: installTwoChannelSwitch,
    locate: (accessory) => accessory.services.find(({ sId }) => sId === 12),
    update: (visible) => ({
      service: { update: { aId: 40, sId: 12, visible } },
    }),
  },
];

function roomServiceUpdates(hub) {
  return hub.requests.filter(
    (params) => params.room?.update || params.service?.update,
  );
}

function withSetting(settingCase, entity, value) {
  const expected = structuredClone(entity);
  settingCase.locate(expected)[settingCase.field] = value;
  return expected;
}

async function prepareRoomServiceSetting(client, settingCase, value) {
  return client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: settingCase.operation,
      target_ref: settingCase.targetRef,
      value,
      reason: "Хозяин попросил навести порядок в названиях и плитках",
    },
  });
}

async function preparedRoomServiceSetting(client, settingCase, value) {
  const prepared = await prepareRoomServiceSetting(client, settingCase, value);
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  return prepared.structuredContent;
}

test("a room or service is renamed or hidden with one native update and restored after restart", async (t) => {
  for (const settingCase of roomServiceSettingCases) {
    await t.test(settingCase.operation, async (subtest) => {
      const { hub, stateDirectory } = await setup(subtest);
      const entity = settingCase.install(hub);
      const before = structuredClone(entity);
      const firstClient = await startClient(subtest, hub, stateDirectory);

      const contract = await firstClient.callTool({
        name: "get_native_change_contract",
        arguments: {
          operation: settingCase.operation,
          target_ref: settingCase.targetRef,
        },
      });
      assert.equal(contract.isError, undefined, contract.content[0]?.text);
      assert.equal(contract.structuredContent.contract.kind, settingCase.kind);
      assert.equal(contract.structuredContent.restore_supported, true);

      const prepared = await preparedRoomServiceSetting(
        firstClient,
        settingCase,
        settingCase.input,
      );
      assert.equal(prepared.status, "prepared");
      assert.equal(prepared.operation, settingCase.operation);
      assert.deepEqual(prepared.diff, {
        value: {
          from: settingCase.baseline,
          to: settingCase.requested,
          kind: settingCase.kind,
        },
      });
      assert.equal(prepared.warnings, undefined);
      assert.deepEqual(roomServiceUpdates(hub), []);

      const applied = await callChangeTool(
        firstClient,
        "apply_native_change",
        prepared.change_ref,
      );
      assert.equal(applied.status, "applied");
      assert.equal(applied.native_acknowledged, true);
      assert.deepEqual(applied.observed_value, {
        value: settingCase.requested,
        kind: settingCase.kind,
      });
      assert.deepEqual(roomServiceUpdates(hub), [
        settingCase.update(settingCase.requested),
      ]);
      assert.deepEqual(
        entity,
        withSetting(settingCase, before, settingCase.requested),
      );

      const history = await firstClient.callTool({
        name: "list_native_changes",
        arguments: { home_ref: homeRef, entity_ref: settingCase.targetRef },
      });
      assert.deepEqual(
        history.structuredContent.changes.map(
          ({ change_ref, operation, recorded_status }) => ({
            change_ref,
            operation,
            recorded_status,
          }),
        ),
        [
          {
            change_ref: prepared.change_ref,
            operation: settingCase.operation,
            recorded_status: "applied",
          },
        ],
      );

      await firstClient.close();
      const secondClient = await startClient(subtest, hub, stateDirectory);
      const restored = await callChangeTool(
        secondClient,
        "restore_native_change",
        prepared.change_ref,
      );
      assert.equal(restored.status, "restored");
      assert.deepEqual(roomServiceUpdates(hub), [
        settingCase.update(settingCase.requested),
        settingCase.update(settingCase.baseline),
      ]);
      assert.deepEqual(entity, before);
    });
  }
});

test("a room or service setting changed by hand is neither overwritten on apply nor reclaimed on restore", async (t) => {
  for (const settingCase of roomServiceSettingCases) {
    await t.test(settingCase.operation, async (subtest) => {
      const { hub, stateDirectory } = await setup(subtest);
      const target = settingCase.locate(settingCase.install(hub));
      const client = await startClient(subtest, hub, stateDirectory);

      const stale = await preparedRoomServiceSetting(
        client,
        settingCase,
        settingCase.input,
      );
      target[settingCase.field] = settingCase.changedBeforeApply;
      const refused = await callChangeTool(
        client,
        "apply_native_change",
        stale.change_ref,
      );
      assert.equal(refused.status, "conflict");
      assert.equal(refused.conflict_reason, "baseline_changed");
      assert.deepEqual(roomServiceUpdates(hub), []);

      target[settingCase.field] = settingCase.baseline;
      const prepared = await preparedRoomServiceSetting(
        client,
        settingCase,
        settingCase.input,
      );
      const applied = await callChangeTool(
        client,
        "apply_native_change",
        prepared.change_ref,
      );
      assert.equal(applied.status, "applied");
      target[settingCase.field] = settingCase.changedAfterApply;
      const observed = await callChangeTool(
        client,
        "get_native_change",
        prepared.change_ref,
      );
      assert.equal(observed.status, "conflict");
      assert.equal(observed.manual_change_observed, true);

      target[settingCase.field] = settingCase.requested;
      const restored = await callChangeTool(
        client,
        "restore_native_change",
        prepared.change_ref,
      );
      assert.equal(restored.status, "conflict");
      assert.equal(restored.conflict_reason, "manual_change");
      assert.deepEqual(roomServiceUpdates(hub), [
        settingCase.update(settingCase.requested),
      ]);
      assert.equal(target[settingCase.field], settingCase.requested);
    });
  }
});

test("a room or service that already has the requested setting creates no change or write", async (t) => {
  for (const settingCase of roomServiceSettingCases) {
    await t.test(settingCase.operation, async (subtest) => {
      const { hub, stateDirectory } = await setup(subtest);
      settingCase.install(hub);
      const client = await startClient(subtest, hub, stateDirectory);

      const prepared = await preparedRoomServiceSetting(
        client,
        settingCase,
        settingCase.baseline,
      );
      assert.deepEqual(prepared, {
        status: "already_desired",
        operation: settingCase.operation,
        target_ref: settingCase.targetRef,
        observed_value: {
          value: settingCase.baseline,
          kind: settingCase.kind,
        },
        native_write_sent: false,
        owned_change_created: false,
      });
      const history = await client.callTool({
        name: "list_native_changes",
        arguments: { home_ref: homeRef, entity_ref: settingCase.targetRef },
      });
      assert.deepEqual(history.structuredContent.changes, []);
      assert.deepEqual(roomServiceUpdates(hub), []);
    });
  }
});

test("a room or service ref of another home is rejected before any room or service request", async (t) => {
  for (const settingCase of roomServiceSettingCases) {
    await t.test(settingCase.operation, async (subtest) => {
      const { hub, stateDirectory } = await setup(subtest);
      const entity = settingCase.install(hub);
      const before = structuredClone(entity);
      const client = await startClient(subtest, hub, stateDirectory);

      const contract = await client.callTool({
        name: "get_native_change_contract",
        arguments: {
          operation: settingCase.operation,
          target_ref: settingCase.foreignRef,
        },
      });
      const prepared = await client.callTool({
        name: "prepare_native_change",
        arguments: {
          operation: settingCase.operation,
          target_ref: settingCase.foreignRef,
          value: settingCase.input,
          reason: "Не трогать комнаты и сервисы другого дома",
        },
      });
      for (const refused of [contract, prepared]) {
        assert.equal(refused.isError, true);
        assert.equal(
          refused.structuredContent?.error?.code,
          "unsupported_home_write",
          refused.content[0]?.text,
        );
      }
      assert.equal(
        hub.requests.some(
          (params) => params.room || params.accessory || params.service,
        ),
        false,
      );
      assert.deepEqual(entity, before);
    });
  }
});

test("a blank room name is refused and a name already used by another room is flagged", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const [roomName] = roomServiceSettingCases;
  roomName.install(hub);
  const client = await startClient(t, hub, stateDirectory);

  const blank = await prepareRoomServiceSetting(client, roomName, "   ");
  assert.equal(blank.isError, true);
  assert.equal(
    blank.structuredContent?.error?.code,
    "name_required",
    blank.content[0]?.text,
  );

  const workshop = hub.state.rooms.find(({ id }) => id === 2);
  const prepared = await preparedRoomServiceSetting(
    client,
    roomName,
    workshop.name,
  );
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.diff.value.to, workshop.name);
  assert.deepEqual(
    prepared.warnings.map(({ code, room_refs }) => ({ code, room_refs })),
    [{ code: "room_name_in_use", room_refs: [workshopRoomRef] }],
  );
  assert.deepEqual(roomServiceUpdates(hub), []);
});

test("a service whose visibility the hub does not report is not hidden on a guess", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const serviceVisible = roomServiceSettingCases.find(
    ({ operation }) => operation === "service_visible",
  );
  const target = serviceVisible.locate(serviceVisible.install(hub));
  delete target.visible;
  const client = await startClient(t, hub, stateDirectory);

  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "service_visible",
      target_ref: serviceVisible.targetRef,
    },
  });
  const prepared = await prepareRoomServiceSetting(
    client,
    serviceVisible,
    false,
  );
  for (const refused of [contract, prepared]) {
    assert.equal(refused.isError, true);
    assert.equal(
      refused.structuredContent?.error?.code,
      "service_visibility_unknown",
      refused.content[0]?.text,
    );
  }
  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: serviceVisible.targetRef },
  });
  assert.deepEqual(history.structuredContent.changes, []);
  assert.deepEqual(roomServiceUpdates(hub), []);
  assert.equal(Object.hasOwn(target, "visible"), false);
});
