import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const skillRoot = path.join(repo, "skills", "spruthub-master");
const codexBinary = process.env.SPRUT_EVAL_CODEX_BIN ?? "codex";
const codexProfile = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
const codexAuth =
  process.env.SPRUT_EVAL_CODEX_AUTH ?? path.join(codexProfile, "auth.json");
const model = process.env.SPRUT_EVAL_MODEL ?? "gpt-5.6-terra";
const reasoningEffort = process.env.SPRUT_EVAL_REASONING ?? "medium";
const requireFromRepo = createRequire(path.join(repo, "package.json"));
const { WebSocketServer } = requireFromRepo("ws");

const caseName = process.argv[2] ?? "contact-option";
const arm = process.argv[3] ?? "treatment";
const caseNames = [
  "target-mismatch",
  "simple-on",
  "equivalent-reuse",
  "runtime-conflict",
  "native-option",
  "ambiguity",
  "contact-option",
  "empty-option-scopes",
];
if (!caseNames.includes(caseName) || !["baseline", "treatment"].includes(arm)) {
  throw new Error(
    `Usage: node research/evaluate-spruthub-master.mjs <${caseNames.join("|")}> <baseline|treatment>`,
  );
}

async function main() {
  const runtime = await describeRuntime();
  await access(codexAuth);
  await access(skillRoot);
  const codexVersion = execFileSync(codexBinary, ["--version"], {
    encoding: "utf8",
  }).trim();
  process.umask(0o077);

  const scratchRoot = await mkdtemp(path.join(tmpdir(), "sprut-session-"));
  let hub = null;
  let outcome = null;
  let shouldFail = false;
  let operationError = null;
  let cleanupError = null;
  try {
    const workspace = path.join(scratchRoot, "workspace");
    const temporaryHome = path.join(scratchRoot, "home");
    const codexHome = path.join(scratchRoot, "codex-home");
    const stateDir = path.join(scratchRoot, "state");
    const answerPath = path.join(scratchRoot, "answer.txt");
    await mkdir(workspace, { recursive: true });
    await mkdir(temporaryHome, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await symlink(codexAuth, path.join(codexHome, "auth.json"));
    let installedSkill = null;
    if (arm === "treatment") {
      installedSkill = path.join(
        temporaryHome,
        ".agents",
        "skills",
        "spruthub-master",
      );
      await mkdir(path.dirname(installedSkill), { recursive: true });
      await cp(skillRoot, installedSkill, {
        recursive: true,
      });
    }

    const testCase = makeCase(caseName);
    hub = await startHub(testCase.state);
    const input = {
      case: caseName,
      arm,
      prompt: testCase.prompt,
      model,
      reasoning_effort: reasoningEffort,
      codex_version: codexVersion,
      ...runtime,
      skill_installed: arm === "treatment",
      skill_source: arm === "treatment" ? "skills/spruthub-master" : null,
      skill_sha256: arm === "treatment" ? await hashDirectory(skillRoot) : null,
    };

    const hubEnv = {
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "synthetic-eval-token",
      SPRUTHUB_SERIAL: "eval-hub",
      SPRUTHUB_CID: `sprut-${path.basename(scratchRoot)}`,
      SPRUTHUB_TIMEOUT_MS: "5000",
      SPRUT_AGENT_STATE_DIR: stateDir,
    };
    const config = {
      model,
      model_reasoning_effort: reasoningEffort,
      "features.plugins": false,
      "features.apps": false,
      "features.memories": false,
      "features.multi_agent": false,
      "features.shell_tool": true,
      "features.skill_search": false,
      "features.skip_host_skill_discovery": false,
      "features.tool_suggest": false,
      project_doc_max_bytes: 0,
      web_search: "disabled",
      "mcp_servers.sprut.command": process.execPath,
      "mcp_servers.sprut.args": [path.join(repo, "src/server.mjs")],
      "mcp_servers.sprut.env": hubEnv,
      "mcp_servers.sprut.required": true,
      "mcp_servers.sprut.default_tools_approval_mode": "auto",
    };
    const args = [
      "exec",
      "--ignore-user-config",
      "--ephemeral",
      "--skip-git-repo-check",
      "--strict-config",
      "--approve-for-me",
      "--json",
    ];
    for (const [key, value] of Object.entries(config)) {
      args.push(
        "-c",
        `${key}=${key.endsWith(".env") ? tomlInlineTable(value) : JSON.stringify(value)}`,
      );
    }
    args.push("--output-last-message", answerPath, "-");

    const exposedProcessValues = [
      workspace,
      codexHome,
      stateDir,
      answerPath,
      hubEnv.SPRUTHUB_CID,
      ...args,
    ];
    for (const forbidden of [caseName, arm]) {
      if (
        exposedProcessValues.some((value) => String(value).includes(forbidden))
      ) {
        throw new Error(
          `Evaluator label leaked into child process parameters: ${forbidden}`,
        );
      }
    }
    const workspaceEntriesBefore = await readdir(workspace);
    if (workspaceEntriesBefore.length !== 0) {
      throw new Error(
        "Evaluator workspace must be empty before the child starts",
      );
    }

    const started = Date.now();
    const result = await runCodex(
      args,
      testCase.prompt,
      {
        ...process.env,
        HOME: temporaryHome,
        CODEX_HOME: codexHome,
      },
      workspace,
    );
    const evidence = summarizeEvents(result.stdout, installedSkill);
    const syntheticWriteCount = hub.requests.filter(isWriteRequest).length;
    const validationErrors = [];
    if (caseName === "contact-option" && arm === "treatment") {
      if (!evidence.skillReadObserved) {
        validationErrors.push("Codex did not read the installed SKILL.md");
      }
      if (evidence.toolCalls.length === 0) {
        validationErrors.push("Codex did not call the public Sprut MCP");
      }
      if (syntheticWriteCount !== 0) {
        validationErrors.push("Read-only smoke attempted a hub write");
      }
    }
    const execution = {
      exitCode: result.code,
      timedOut: result.timedOut,
      elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
      syntheticWriteCount,
      validationErrors,
      ...evidence,
    };

    const stamp = new Date()
      .toISOString()
      .replaceAll(":", "-")
      .replaceAll(".", "-");
    const outputRoot = process.env.SPRUT_EVAL_OUTPUT
      ? path.resolve(process.env.SPRUT_EVAL_OUTPUT)
      : await mkdtemp(path.join(tmpdir(), "sprut-agent-eval-output-"));
    const runDir = path.join(outputRoot, `${caseName}-${arm}-${stamp}`);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "events.jsonl"), result.stdout, {
      mode: 0o600,
    });
    await writeFile(path.join(runDir, "stderr.txt"), result.stderr, {
      mode: 0o600,
    });
    await writeFile(
      path.join(runDir, "answer.txt"),
      await readFile(answerPath, "utf8").catch(() => ""),
      { mode: 0o600 },
    );
    await writeJson(path.join(runDir, "hub-requests.json"), hub.requests);
    await writeJson(path.join(runDir, "hub-final-state.json"), hub.state);
    await writeJson(path.join(runDir, "execution.json"), execution);
    await writeJson(path.join(runDir, "input.json"), input);
    await writeJson(path.join(runDir, "process.json"), {
      executable: codexBinary,
      args: args.map((value) =>
        String(value).replaceAll(hubEnv.SPRUTHUB_TOKEN, "<synthetic-token>"),
      ),
      cwd: workspace,
      environment: {
        HOME: temporaryHome,
        CODEX_HOME: codexHome,
        SPRUTHUB_CID: hubEnv.SPRUTHUB_CID,
        SPRUT_AGENT_STATE_DIR: stateDir,
      },
      workspace_entries_before_child: workspaceEntriesBefore,
      evaluation_metadata_written_after_child_exit: true,
    });

    outcome = { runDir, ...execution };
    shouldFail =
      result.code !== 0 || result.timedOut || validationErrors.length > 0;
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await closeHub(hub);
    } catch (error) {
      cleanupError = error;
    }
    try {
      await rm(scratchRoot, { recursive: true });
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  if (shouldFail) process.exitCode = 1;
}

async function closeHub(hub) {
  if (hub === null) return;
  for (const socket of hub.server.clients) socket.terminate();
  if (!hub.server.listening) return;
  await new Promise((resolve, reject) => {
    hub.server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function describeRuntime() {
  const git = (args, encoding = "utf8") =>
    execFileSync("git", args, {
      cwd: repo,
      encoding,
    });
  const actual = git(["rev-parse", "HEAD"]).trim();
  let actualMerge = null;
  try {
    actualMerge = git(["rev-parse", "MERGE_HEAD"]).trim();
  } catch {}
  const actualIndexTree = git(["write-tree"]).trim();
  const patch = git(["diff", "--binary"], null);
  const sourcePaths = [
    "src/server.mjs",
    "src/spruthub-client.mjs",
    "test/home-entities.integration.test.mjs",
    "README.md",
  ];
  const sourceSha256 = {};
  for (const sourcePath of sourcePaths) {
    sourceSha256[sourcePath] = createHash("sha256")
      .update(await readFile(path.join(repo, sourcePath)))
      .digest("hex");
  }
  return {
    checkout_head: actual,
    merge_head: actualMerge,
    prepared_index_tree: actualIndexTree,
    unstaged_patch_sha256: createHash("sha256").update(patch).digest("hex"),
    source_sha256: sourceSha256,
  };
}

function isWriteRequest(params) {
  return Boolean(
    params.scenario?.create ||
      params.scenario?.delete ||
      params.characteristic?.set ||
      params.logic?.create ||
      params.logic?.delete ||
      params.link?.create ||
      params.link?.delete,
  );
}

async function startHub(state) {
  const requests = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      requests.push(message.params);
      try {
        const result = respond(state, message.params, message.serial);
        socket.send(JSON.stringify({ id: message.id, result }));
      } catch (error) {
        socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: -32603, message: error.message },
          }),
        );
      }
    });
  });
  const address = server.address();
  return {
    requests,
    server,
    state,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

function respond(state, params, serial) {
  if (params.hub?.list) return { hub: { list: { hubs: [home] } } };
  if (serial !== "eval-hub") throw new Error(`Unexpected serial ${serial}`);
  if (params.room?.list) return { room: { list: { rooms: state.rooms } } };
  if (params.room?.get) {
    return {
      room: {
        get: state.rooms.find(({ id }) => id === params.room.get.id) ?? null,
      },
    };
  }
  if (params.accessory?.list) {
    const roomId = params.accessory.list.roomId;
    return {
      accessory: {
        list: {
          accessories: state.accessories.filter(
            (item) => roomId === undefined || item.roomId === roomId,
          ),
        },
      },
    };
  }
  if (params.accessory?.get) {
    return {
      accessory: {
        get:
          state.accessories.find(({ id }) => id === params.accessory.get.id) ??
          null,
      },
    };
  }
  if (params.scenario?.list) {
    return params.scenario.list.aId === undefined
      ? { scenario: { list: { scenarios: state.scenarios } } }
      : { scenario: { list: {} } };
  }
  if (params.scenario?.get) {
    return {
      scenario: {
        get:
          state.scenarios.find(
            ({ index }) => index === params.scenario.get.index,
          ) ?? null,
      },
    };
  }
  if (params.scenario?.create) {
    const scenario = {
      ...structuredClone(params.scenario.create),
      index: `created-${state.nextScenario++}`,
      predefined: false,
    };
    state.scenarios.push(scenario);
    return { scenario: { create: scenario } };
  }
  if (params.scenario?.delete) {
    const at = state.scenarios.findIndex(
      ({ index }) => index === params.scenario.delete.index,
    );
    if (at >= 0) state.scenarios.splice(at, 1);
    return { scenario: { delete: {} } };
  }
  if (params.logic?.list) {
    const logics =
      params.logic.list.aId === 34
        ? [
            {
              type: "LightbulbControl",
              name: "Связь включения и уровня",
              active: true,
            },
          ]
        : [];
    return { logic: { list: { logics } } };
  }
  if (params.logic?.types) {
    const logicTypes =
      params.logic.types.aId === 34
        ? [
            { type: "AdaptiveLighting", name: "Адаптивное освещение" },
            { type: "LightbulbControl", name: "Связь включения и уровня" },
          ]
        : [
            {
              type: "MotionDetectedFromCurrentMotionLevel",
              name: "Определение движения",
            },
          ];
    return { logic: { types: { logicTypes } } };
  }
  if (params.link?.list) {
    return { link: { list: { links: [{ type: "SYSTEM" }] } } };
  }
  if (params.characteristic?.getOptions) {
    const { aId, sId, cId } = params.characteristic.getOptions;
    const key = [aId, sId, cId].join(":");
    const options = state.characteristicOptions?.[key] ?? [];
    return { characteristic: { getOptions: { options } } };
  }
  if (params.extension?.list) {
    return {
      extension: {
        list: {
          extensions: [
            {
              id: 1,
              extensionKey: "Controller:zigbee_eval",
              type: "zigbee",
              index: "zigbee_eval",
              bundleType: "CONTROLLER",
              name: "ZigBee",
              enabled: true,
              state: "LOADED",
            },
          ],
        },
      },
    };
  }
  if (params.window?.get) {
    const windowKey = params.window.get.windowKey;
    const window = state.windows?.[windowKey] ?? {
      windowKey,
      label: { text: "Настройки" },
      options: [],
    };
    return { window: { get: window } };
  }
  throw new Error(`Unexpected operation ${JSON.stringify(params)}`);
}

function baseState({ ambiguous = false, scenarios = [] } = {}) {
  return {
    rooms: [
      { id: 1, name: "Гостиная" },
      { id: 2, name: "Офис" },
      { id: 3, name: "Сад" },
      ...(ambiguous ? [{ id: 4, name: "1 - Офис" }] : []),
    ],
    accessories: [
      accessory(
        32,
        1,
        "Датчик движения",
        "MotionSensor",
        "Движение",
        "MotionDetected",
        false,
        false,
        true,
      ),
      accessory(34, 2, "Цветная лампа", "Lightbulb", "Свет", "On", false, true),
      accessory(40, 3, "Насос полива", "Switch", "Полив", "On", false, true),
      ...(ambiguous
        ? [
            accessory(
              35,
              4,
              "Цветная лампа",
              "Lightbulb",
              "Свет",
              "On",
              false,
              true,
            ),
          ]
        : []),
    ],
    scenarios: structuredClone(scenarios),
    nextScenario: 1,
    characteristicOptions: {
      "32:13:15": [
        {
          key: "SwitchOffTime",
          name: "Выключить через (сек.)",
          type: "GenericDouble",
          unit: "s",
          value: { doubleValue: 180 },
          read: true,
          write: true,
        },
      ],
    },
    windows: {
      "motion-window": {
        windowKey: "motion-window",
        label: { text: "Настройки" },
        options: [],
      },
      "window-34": {
        windowKey: "window-34",
        label: { text: "Настройки" },
        options: [],
      },
      "window-40": {
        windowKey: "window-40",
        label: { text: "Настройки" },
        options: [],
      },
    },
  };
}

function accessory(
  id,
  roomId,
  name,
  serviceType,
  serviceName,
  controlType,
  value,
  write,
  hasOptions = false,
) {
  return {
    id,
    roomId,
    name,
    online: true,
    extensionKey: "Controller:zigbee_eval",
    deviceId: `device-${id}`,
    deviceWindow: id === 32 ? "motion-window" : `window-${id}`,
    services: [
      {
        aId: id,
        sId: 13,
        name: serviceName,
        type: serviceType,
        characteristics: [
          {
            aId: id,
            sId: 13,
            cId: 15,
            hasOptions,
            control: {
              name:
                controlType === "MotionDetected"
                  ? "Обнаружено движение"
                  : controlType === "ContactSensorState"
                    ? "Состояние контакта"
                    : "Включено",
              type: controlType,
              read: true,
              write,
              events: true,
              unit: "boolean",
              value: { boolValue: value },
            },
          },
        ],
      },
    ],
  };
}

function ruleData(targetId = 34, targetType = "Lightbulb", targetValue = true) {
  return {
    blockId: 0,
    targets: [
      {
        type: "if",
        blockId: 1,
        if: {
          type: "condition",
          blockId: 2,
          mode: "AND",
          conditions: [
            {
              type: "characteristic",
              blockId: 3,
              aId: 32,
              sId: 13,
              cId: 15,
              value: "true",
              cond: "=",
              trigger: true,
              hs: "MotionSensor",
              hc: "MotionDetected",
              time: 0,
              timeCond: "",
            },
          ],
        },
        // biome-ignore lint/suspicious/noThenProperty: SprutHub BLOCK requires the native field name.
        then: [
          {
            type: "service",
            blockId: 4,
            aId: targetId,
            sId: 13,
            hs: targetType,
            characteristics: [
              {
                type: "set",
                blockId: 5,
                cId: 15,
                hc: "On",
                value: String(targetValue),
              },
            ],
          },
        ],
        else: [],
        then_delay: 0,
        else_delay: 0,
        mode: "EVERY",
      },
    ],
  };
}

function scenario(index, name, data, flags = {}) {
  return {
    index,
    name,
    desc: flags.desc ?? "Создано ранее",
    type: "BLOCK",
    predefined: false,
    active: flags.active ?? true,
    onStart: flags.onStart ?? false,
    sync: flags.sync ?? false,
    data: JSON.stringify(data),
  };
}

const home = {
  serial: "eval-hub",
  name: "Тестовый дом",
  online: true,
  owner: "synthetic-owner",
  model: "Sprut.hub 2",
  version: { current: { version: "3.0.0b", revision: "20131" } },
};

const writePrompt =
  "Каждый раз, когда захожу в гостиную, вручную включаю свет в соседнем офисе. Сделай так, чтобы датчик движения в гостиной включал цветную лампу в офисе. Автоматическое выключение не добавляй.";

function contactOptionState() {
  const state = baseState();
  state.rooms = [{ id: 1, name: "Прихожая" }];
  state.accessories = [
    accessory(
      32,
      1,
      "Датчик двери",
      "ContactSensor",
      "Контакт",
      "ContactSensorState",
      false,
      false,
      true,
    ),
  ];
  state.characteristicOptions = {
    "32:13:15": [
      {
        key: "DebounceTime",
        name: "Фильтр дребезга (сек.)",
        type: "GenericDouble",
        unit: "s",
        value: { doubleValue: 3 },
        read: true,
        write: true,
      },
    ],
  };
  state.windows = {
    "motion-window": {
      windowKey: "motion-window",
      label: { text: "Настройки" },
      options: [],
    },
  };
  return state;
}

function emptyOptionScopesState() {
  const state = baseState();
  state.characteristicOptions["34:13:15"] = [];
  state.windows["window-34"] = {
    windowKey: "window-34",
    label: { text: "Настройки" },
    options: [],
  };
  return state;
}

function makeCase(name) {
  const definitions = {
    "target-mismatch": () => ({
      prompt:
        "Посмотри текущий сценарий «Свет в офисе по движению». Соответствует ли он названию и действительно ли включает офисную лампу? Ничего не меняй.",
      state: baseState({
        scenarios: [
          scenario(
            "misleading",
            "Свет в офисе по движению",
            ruleData(40, "Switch"),
          ),
        ],
      }),
    }),
    "simple-on": () => ({ prompt: writePrompt, state: baseState() }),
    "equivalent-reuse": () => ({
      prompt: writePrompt,
      state: baseState({
        scenarios: [
          scenario(
            "equivalent",
            "Старое правило без понятного имени",
            ruleData(),
          ),
        ],
      }),
    }),
    "runtime-conflict": () => ({
      prompt: writePrompt,
      state: baseState({
        scenarios: [
          scenario("conflict", "Похожее правило", ruleData(), {
            onStart: true,
          }),
        ],
      }),
    }),
    "native-option": () => ({
      prompt:
        "Сделай сценарий, который через две минуты сбрасывает состояние датчика движения в гостиной. Ничего другого не меняй.",
      state: baseState(),
    }),
    ambiguity: () => ({
      prompt:
        "Сделай так, чтобы датчик движения в гостиной включал цветную лампу в офисе. Автоматическое выключение не нужно.",
      state: baseState({ ambiguous: true }),
    }),
    "contact-option": () => ({
      prompt:
        "Проверь, какой нативный таймаут фильтра дребезга сейчас настроен у датчика двери в прихожей. Ничего не меняй.",
      state: contactOptionState(),
    }),
    "empty-option-scopes": () => ({
      prompt:
        "Проверь, есть ли у цветной лампы в офисе нативный таймер или настройка автоматического выключения — и в самой характеристике, и в физических настройках устройства. Ничего не меняй.",
      state: emptyOptionScopesState(),
    }),
  };
  return definitions[name]();
}

function runCodex(args, prompt, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBinary, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 5_000).unref();
    }, 240_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(prompt);
  });
}

function summarizeEvents(jsonl, installedSkill) {
  const toolCalls = [];
  const shellCommands = [];
  let usage = null;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const item = event.item;
      if (item?.type === "mcp_tool_call") {
        toolCalls.push({
          tool: item.tool,
          arguments: item.arguments,
          status: item.status,
        });
      }
      if (item?.type === "command_execution") shellCommands.push(item.command);
      if (event.type === "turn.completed") usage = event.usage ?? usage;
    } catch {}
  }
  const normalizedSkill = installedSkill?.replaceAll("\\", "/") ?? null;
  return {
    toolCalls,
    shellCommands,
    skillReadObserved:
      normalizedSkill !== null &&
      shellCommands.some((command) =>
        String(command).includes(`${normalizedSkill}/SKILL.md`),
      ),
    referenceReadObserved: shellCommands.some((command) =>
      normalizedSkill === null
        ? false
        : String(command).includes(`${normalizedSkill}/references/`),
    ),
    usage,
  };
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function tomlInlineTable(value) {
  return `{ ${Object.entries(value)
    .map(([key, item]) => `${key} = ${JSON.stringify(item)}`)
    .join(", ")} }`;
}

async function hashDirectory(directory) {
  const files = [];
  async function collect(current) {
    for (const name of (await readdir(current)).sort()) {
      const full = path.join(current, name);
      const info = await stat(full);
      if (info.isDirectory()) await collect(full);
      else files.push(full);
    }
  }
  await collect(directory);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(path.relative(directory, file));
    digest.update("\0");
    digest.update(await readFile(file));
    digest.update("\0");
  }
  return digest.digest("hex");
}

await main();
