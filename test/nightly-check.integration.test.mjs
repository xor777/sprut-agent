import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { FAKE_HUB_HOST, ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";
import {
  isWriteMethod,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

const run = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const script = path.join(projectRoot, "scripts", "nightly-check.mjs");
const guard = new URL("./support/loopback-only.mjs", import.meta.url).href;
const login = "owner@example.invalid";
const password = "pāss-secret-🔐";
const oldPassword = "old-pāss-secret-🗝";

// osascript found first on PATH: the only thing replaced in these runs. It
// records its arguments and does what FAKE_NOTIFIER says.
const FAKE_OSASCRIPT = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_NOTIFIER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.FAKE_NOTIFIER === "fail") process.exit(1);
if (process.env.FAKE_NOTIFIER === "hang") setInterval(() => {}, 1000);
`;

async function ownerMac(t) {
  const home = await mkdtemp(path.join(tmpdir(), "sprut-nightly-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = path.join(home, "bin");
  const stateDirectory = path.join(home, "state");
  const notifierLog = path.join(home, "notifier.jsonl");
  const configDirectory = path.join(home, ".config", "sprut-agent");
  const credentialFile = path.join(configDirectory, "connection.env");
  await mkdir(bin);
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(bin, "osascript"), FAKE_OSASCRIPT);
  await chmod(path.join(bin, "osascript"), 0o755);
  let seenNotices = 0;
  const allOutput = [];

  const notices = async () => {
    const lines = await readFile(notifierLog, "utf8").catch(() => "");
    return lines
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };

  return {
    home,
    bin,
    stateDirectory,
    allOutput,
    credentialFile,
    saveLogin: ({ url, password: saved = password, extra = "" }) =>
      writeFile(
        credentialFile,
        `SPRUTHUB_LOGIN=${login}\nSPRUTHUB_PASSWORD=${saved}\nSPRUTHUB_URL=${url}\n${extra}`,
        { mode: 0o600 },
      ),
    summary: async () =>
      JSON.parse(
        await readFile(path.join(stateDirectory, "nightly-check.json"), "utf8"),
      ),
    // One scheduled run. Returns its exit code, stdout, stderr and the
    // notices it sent as { title, text, statements }.
    night: async ({
      notifier = "ok",
      timeoutMs = 30_000,
      retryMs = 50,
    } = {}) => {
      const startedAt = performance.now();
      const finished = await run(process.execPath, [script], {
        timeout: 60_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: home,
          NODE_OPTIONS: `--import=${guard}`,
          SPRUT_AGENT_STATE_DIR: stateDirectory,
          SPRUT_AGENT_NIGHTLY_TIMEOUT_MS: String(timeoutMs),
          SPRUT_AGENT_NIGHTLY_RETRY_MS: String(retryMs),
          SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
          FAKE_NOTIFIER: notifier,
          FAKE_NOTIFIER_LOG: notifierLog,
        },
      }).then(
        ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
        (error) => ({
          code: error.code,
          stdout: error.stdout,
          stderr: error.stderr,
        }),
      );
      const all = await notices();
      const sent = all.slice(seenNotices).map((argv) => {
        const separator = argv.indexOf("--");
        return {
          statements: argv.slice(0, separator),
          text: argv[separator + 1],
          title: argv[separator + 2],
        };
      });
      seenNotices = all.length;
      allOutput.push(finished.stdout, finished.stderr);
      for (const { title, text } of sent) allOutput.push(title, text);
      return {
        ...finished,
        sent,
        elapsedMs: performance.now() - startedAt,
      };
    },
  };
}

async function hubWith(t, { firmware, online, account } = {}) {
  const fixture = await loadHomeFixture("apartment");
  const methods = [];
  // The hub reads the account at each login: a test may change it later.
  const hubAccount = { login, password, ...account };
  const hub = await startSimulatedHub(
    {
      ...fixture,
      hub: {
        ...fixture.hub,
        ...(firmware ? { revision: firmware } : {}),
        ...(online === undefined ? {} : { online }),
      },
    },
    {
      account: hubAccount,
      onRequest: ({ method }) => methods.push(method),
    },
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await hub.close();
  };
  t.after(close);
  return {
    hub,
    hubAccount,
    methods,
    close,
    logins: () => methods.filter((name) => name === "account.auth").length,
  };
}

test("a working home stays silent and only reads, through the real MCP entry", async (t) => {
  const mac = await ownerMac(t);
  const { hub, methods } = await hubWith(t);
  await mac.saveLogin({ url: hub.url });

  const { code, sent, stdout } = await mac.night();

  assert.equal(code, 0);
  assert.deepEqual(sent, []);
  assert.equal(JSON.parse(stdout).outcome, "ok");
  const summary = await mac.summary();
  assert.equal(summary.outcome, "ok");
  assert.equal(summary.firmware_check, "matches");
  assert.equal(summary.firmware_revision, "20131");
  assert.ok(Date.parse(summary.checked_at) > Date.now() - 120_000);
  // The call went through the shipped server: its own work log saw it.
  const workLog = await readFile(
    path.join(mac.stateDirectory, "work-log.jsonl"),
    "utf8",
  );
  const calls = workLog
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map(({ tool, outcome }) => [tool, outcome]),
    [["home_overview", "ok"]],
  );
  assert.ok(methods.length > 0, "the hub was read");
  assert.deepEqual(methods.filter(isWriteMethod), []);
  assert.deepEqual(hub.snapshot(), hub.initialSnapshot());
});

test("a refused login warns on every run with one attempt at the hub, and its fix is announced once", async (t) => {
  const mac = await ownerMac(t);
  const { hub, logins } = await hubWith(t);
  await mac.saveLogin({ url: hub.url, password: oldPassword });

  const first = await mac.night();
  assert.equal(first.code, 1);
  assert.equal(first.sent.length, 1);
  assert.match(first.sent[0].text, /логин или пароль/);
  assert.match(first.sent[0].text, /connection\.env/);
  assert.equal(logins(), 1);
  const summary = await mac.summary();
  assert.equal(summary.outcome, "login_refused");
  assert.equal(summary.account_status, "ACCOUNT_RESPONSE_FAILED");
  assert.ok(Date.parse(summary.next_login_at) > Date.now());

  const second = await mac.night();
  assert.equal(second.code, 1);
  assert.deepEqual(
    second.sent.map(({ text }) => text),
    [first.sent[0].text],
  );
  assert.equal(logins(), 1, "the login hold kept the second run off the hub");

  await mac.saveLogin({ url: hub.url });
  const recovered = await mac.night();
  assert.equal(recovered.code, 0);
  assert.equal(recovered.sent.length, 1);
  assert.match(recovered.sent[0].title, /снова работает/);
  assert.equal((await mac.summary()).outcome, "ok");

  const after = await mac.night();
  assert.equal(after.code, 0);
  assert.deepEqual(after.sent, []);
});

// The incident behind this tool: the password changed on the hub, the saved
// session stopped working and nothing told the owner.
test("a password changed on the hub is found through the saved session", async (t) => {
  const mac = await ownerMac(t);
  const { hub, hubAccount, logins } = await hubWith(t);
  await mac.saveLogin({ url: hub.url });
  assert.deepEqual((await mac.night()).sent, []);
  assert.equal(logins(), 1);

  hubAccount.password = "changed-on-the-hub";
  hub.expireTokens();

  const { code, sent } = await mac.night();
  assert.equal(code, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /логин или пароль/);
  assert.equal((await mac.summary()).outcome, "login_refused");
  assert.equal(logins(), 2);

  assert.equal((await mac.night()).sent.length, 1);
  assert.equal(logins(), 2, "no further attempt while the file is the same");
});

test("each refusal the owner handles differently gets its own advice", async (t) => {
  const texts = new Map();
  for (const [status, expected] of [
    ["ACCOUNT_RESPONSE_NO_MORE_TRIES", /Подождите/],
    ["ACCOUNT_RESPONSE_NOT_CONFIRMED", /подтвер/i],
  ]) {
    const mac = await ownerMac(t);
    const { hub } = await hubWith(t, { account: { status } });
    await mac.saveLogin({ url: hub.url });
    const { code, sent } = await mac.night();
    assert.equal(code, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, expected);
    assert.equal((await mac.summary()).account_status, status);
    texts.set(status, sent[0].text);
  }
  assert.notEqual(
    texts.get("ACCOUNT_RESPONSE_NO_MORE_TRIES"),
    texts.get("ACCOUNT_RESPONSE_NOT_CONFIRMED"),
  );
});

test("a missing login file and an unexpected refusal are reported, not taken for a working tool", async (t) => {
  const noLogin = await ownerMac(t);
  const missing = await noLogin.night();
  assert.equal(missing.code, 1);
  assert.equal(missing.sent.length, 1);
  assert.match(missing.sent[0].text, /не настроен/);
  assert.equal((await noLogin.summary()).outcome, "login_not_configured");

  const mac = await ownerMac(t);
  const { hub } = await hubWith(t);
  await mac.saveLogin({
    url: hub.url,
    extra: "SPRUTHUB_SERIAL=no-such-home\n",
  });
  const failed = await mac.night();
  assert.equal(failed.code, 1);
  assert.equal(failed.sent.length, 1);
  const summary = await mac.summary();
  assert.equal(summary.outcome, "check_failed");
  assert.match(summary.error_code, /^[a-z_]+$/);
  assert.ok(failed.sent[0].text.includes(summary.error_code));
});

test("an unreachable hub warns on every run in its own words", async (t) => {
  const mac = await ownerMac(t);
  const { hub, close } = await hubWith(t);
  await mac.saveLogin({ url: hub.url });
  assert.equal((await mac.night()).code, 0);
  await close();

  const first = await mac.night();
  assert.equal(first.code, 1);
  assert.equal(first.sent.length, 1);
  assert.match(first.sent[0].text, /Хаб не отвечает/);
  assert.doesNotMatch(first.sent[0].text, /пароль/);
  const summary = await mac.summary();
  assert.equal(summary.outcome, "hub_unreachable");
  assert.equal(summary.attempts, 2);

  const second = await mac.night();
  assert.equal(second.sent.length, 1);

  const { hub: back } = await hubWith(t);
  await mac.saveLogin({ url: back.url });
  const recovered = await mac.night();
  assert.equal(recovered.code, 0);
  assert.equal(recovered.sent.length, 1);
  assert.match(recovered.sent[0].title, /снова работает/);
});

test("a hub that the cloud reports as offline counts as unreachable", async (t) => {
  const mac = await ownerMac(t);
  const { hub } = await hubWith(t, { online: false });
  await mac.saveLogin({ url: hub.url });
  const { code, sent } = await mac.night();
  assert.equal(code, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Хаб не отвечает/);
  assert.equal((await mac.summary()).outcome, "hub_unreachable");
});

// launchd runs a job missed in sleep at wake-up, often before the network is
// back: that must not wake the owner with a false alarm.
test("a hub back within the retry raises no alarm", async (t) => {
  const mac = await ownerMac(t);
  const { hub } = await hubWith(t);
  const hubPort = Number(new URL(hub.url).port);
  let down = true;
  let reopening;
  const proxy = createServer((socket) => {
    if (down) {
      reopening ??= setTimeout(() => {
        down = false;
      }, 1000);
      socket.destroy();
      return;
    }
    const upstream = createConnection(hubPort, FAKE_HUB_HOST);
    socket.pipe(upstream).pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  proxy.listen(0, FAKE_HUB_HOST);
  await once(proxy, "listening");
  t.after(() => {
    clearTimeout(reopening);
    proxy.close();
  });
  await mac.saveLogin({
    url: `ws://${FAKE_HUB_HOST}:${proxy.address().port}/spruthub`,
  });

  const { code, sent } = await mac.night({ retryMs: 2500 });

  assert.equal(code, 0);
  assert.deepEqual(sent, []);
  const summary = await mac.summary();
  assert.equal(summary.outcome, "ok");
  assert.equal(summary.attempts, 2);
});

test("a hung hub is bounded by the timeout and reported as unreachable", async (t) => {
  const mac = await ownerMac(t);
  const silent = new WebSocketServer({ host: FAKE_HUB_HOST, port: 0 });
  await once(silent, "listening");
  t.after(() => {
    for (const client of silent.clients) client.terminate();
    silent.close();
  });
  await mac.saveLogin({
    url: `ws://${FAKE_HUB_HOST}:${silent.address().port}/spruthub`,
  });

  const { code, sent, elapsedMs } = await mac.night({ timeoutMs: 1000 });

  assert.equal(code, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Хаб не отвечает/);
  // ORDINARY_HUB_TIMEOUT_MS is far longer: only the check's own limit ended it.
  assert.ok(elapsedMs < 20_000, `took ${elapsedMs} ms`);
  const summary = await mac.summary();
  assert.equal(summary.outcome, "hub_unreachable");
  assert.equal(summary.error_code, "timeout");
});

test("another firmware warns once per revision and keeps the run successful", async (t) => {
  const mac = await ownerMac(t);
  const first = await hubWith(t, { firmware: "20999" });
  await mac.saveLogin({ url: first.hub.url });

  const warned = await mac.night();
  assert.equal(warned.code, 0);
  assert.equal(warned.sent.length, 1);
  assert.match(warned.sent[0].text, /20999/);
  assert.match(warned.sent[0].text, /20131/);
  const summary = await mac.summary();
  assert.equal(summary.outcome, "ok");
  assert.equal(summary.firmware_check, "differs");
  assert.equal(summary.firmware_revision, "20999");

  const quiet = await mac.night();
  assert.equal(quiet.code, 0);
  assert.deepEqual(quiet.sent, []);

  const newer = await hubWith(t, { firmware: "21000" });
  await mac.saveLogin({ url: newer.hub.url });
  const again = await mac.night();
  assert.equal(again.sent.length, 1);
  assert.match(again.sent[0].text, /21000/);
  assert.deepEqual((await mac.night()).sent, []);
});

test("a revision with hostile text reaches neither the notification nor the summary", async (t) => {
  const mac = await ownerMac(t);
  const hostile = '21001"; do shell script "touch /tmp/pwned';
  const { hub } = await hubWith(t, { firmware: hostile });
  await mac.saveLogin({ url: hub.url });

  const { code, sent, stdout } = await mac.night();

  assert.equal(code, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text.includes(hostile), false);
  assert.equal(stdout.includes("shell script"), false);
  assert.equal(
    JSON.stringify(await mac.summary()).includes("shell script"),
    false,
  );
  // Our text goes as an argument, never as AppleScript source.
  assert.equal(sent[0].statements.join(" ").includes(sent[0].text), false);
  assert.deepEqual((await mac.night()).sent, [], "still once per revision");
});

test("a failing or hanging notification command loses neither the run nor the summary", async (t) => {
  for (const notifier of ["fail", "hang"]) {
    const mac = await ownerMac(t);
    const { hub } = await hubWith(t);
    await mac.saveLogin({ url: hub.url, password: oldPassword });

    const { code, stdout, sent, elapsedMs } = await mac.night({
      notifier,
      timeoutMs: 5000,
    });

    assert.equal(code, 1, notifier);
    assert.equal(sent.length, 1);
    assert.ok(elapsedMs < 30_000, `${notifier} took ${elapsedMs} ms`);
    assert.equal(JSON.parse(stdout).outcome, "login_refused");
    const summary = await mac.summary();
    assert.equal(summary.outcome, "login_refused");
    assert.deepEqual(
      summary.notifications.map(({ kind, delivered }) => [kind, delivered]),
      [["login_refused", false]],
    );
  }
});

test("what the command could not deliver is delivered by the next run", async (t) => {
  const mac = await ownerMac(t);
  const { hub } = await hubWith(t, { firmware: "20999" });
  await mac.saveLogin({ url: hub.url, password: oldPassword });
  await mac.night();
  await mac.saveLogin({ url: hub.url });

  const undelivered = await mac.night({ notifier: "fail" });
  assert.equal(undelivered.code, 0);
  assert.equal(undelivered.sent.length, 2, "recovery and firmware were tried");

  const delivered = await mac.night();
  assert.equal(delivered.sent.length, 2);
  assert.deepEqual((await mac.night()).sent, []);
});

test("no secret or home name reaches a notification, the summary or the output", async (t) => {
  const fixture = await loadHomeFixture("apartment");
  const names = [
    fixture.hub.name,
    ...fixture.rooms.map(({ name }) => name),
    ...fixture.accessories.map(({ name }) => name),
  ];
  assert.ok(names.includes("Квартира на Лесной"));
  const mac = await ownerMac(t);
  const { hub, close } = await hubWith(t, { firmware: "20999" });

  await mac.saveLogin({ url: hub.url, password: oldPassword });
  await mac.night();
  const refusedSummary = JSON.stringify(await mac.summary());
  await mac.saveLogin({ url: hub.url });
  await mac.night();
  const okSummary = JSON.stringify(await mac.summary());
  await close();
  await mac.night();
  const downSummary = JSON.stringify(await mac.summary());

  // The session the server saved: a token that really exists on this Mac.
  const { token } = JSON.parse(
    await readFile(
      path.join(path.dirname(mac.credentialFile), "session.json"),
      "utf8",
    ),
  );
  assert.ok(token);
  const written = [
    ...mac.allOutput,
    refusedSummary,
    okSummary,
    downSummary,
  ].join("\n");
  assert.ok(written.length > 100);
  for (const secret of [login, password, oldPassword, token, ...names]) {
    assert.equal(written.includes(secret), false, secret);
  }
});

test("the schedule installs from a temporary HOME and comes off again", {
  skip: process.platform === "darwin" ? false : "launchd is macOS only",
}, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "sprut nightly & home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = path.join(home, "bin");
  await mkdir(bin);
  const launchctlLog = path.join(home, "launchctl.log");
  await writeFile(
    path.join(bin, "launchctl"),
    `#!/bin/sh\necho "$*" >> "${launchctlLog}"\n`,
  );
  await chmod(path.join(bin, "launchctl"), 0o755);
  // PATH holds nothing but the fake: the real launchctl is out of reach.
  const scriptRun = (command) =>
    run(process.execPath, [script, command], {
      env: { HOME: home, PATH: bin },
    });
  const plist = path.join(
    home,
    "Library",
    "LaunchAgents",
    "com.sprut-agent.nightly-check.plist",
  );
  const readPlist = async () => {
    await run("/usr/bin/plutil", ["-lint", plist]);
    const { stdout } = await run("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      plist,
    ]);
    return JSON.parse(stdout);
  };

  await scriptRun("install");

  const job = await readPlist();
  assert.equal(job.Label, "com.sprut-agent.nightly-check");
  assert.deepEqual(job.ProgramArguments, [process.execPath, script]);
  assert.ok(path.isAbsolute(job.ProgramArguments[0]));
  assert.equal(typeof job.StartCalendarInterval.Hour, "number");
  assert.equal(typeof job.StartCalendarInterval.Minute, "number");
  assert.equal(job.StartInterval, undefined);
  for (const log of [job.StandardOutPath, job.StandardErrorPath]) {
    assert.ok(log.startsWith(path.join(home, "Library", "Logs")), log);
    assert.equal(log.startsWith(projectRoot), false);
    assert.ok((await stat(path.dirname(log))).isDirectory());
  }
  const uid = process.getuid();
  const installCalls = await readFile(launchctlLog, "utf8");
  assert.ok(installCalls.includes(`bootstrap gui/${uid} ${plist}`));

  // A stable name on PATH survives the version bump a Cellar path would not.
  const stableNode = path.join(bin, "node");
  await symlink(process.execPath, stableNode);
  await scriptRun("install");
  assert.deepEqual((await readPlist()).ProgramArguments, [stableNode, script]);

  await scriptRun("uninstall");
  await assert.rejects(stat(plist), { code: "ENOENT" });
  const calls = await readFile(launchctlLog, "utf8");
  assert.ok(
    calls
      .trim()
      .split("\n")
      .at(-1)
      .includes(`bootout gui/${uid}/com.sprut-agent.nightly-check`),
  );
});
