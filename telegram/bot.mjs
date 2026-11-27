import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  CodexSessionManager,
  CodexTurnTimeoutError,
} from "./codex-session.mjs";
import {
  atomicWriteFile,
  loadTelegramConfig,
  redactTelegramSecrets,
  saveAllowedUserIds,
} from "./config.mjs";
import {
  MAX_TELEGRAM_PHOTO_BYTES,
  TelegramApi,
  TelegramApiError,
} from "./telegram-api.mjs";

const START_GREETING =
  "Привет! Я здесь и готов помочь по дому — пиши, что посмотреть, переключить или настроить.\n\nКоманды: /new — начать новый разговор, /status — состояние бота.";
const NEW_SESSION_REPLY =
  "Начинаем с чистого листа. Прошлый контекст сбросил — пиши новый запрос.";
const PAIR_CONFIRMATION =
  "Готово, доступ привязан. Теперь можешь запускать бота в обычном режиме и писать сюда по делам дома.";
const DEFAULT_PROGRESS_TEXT = "Работаю над запросом…";
const MAX_PROGRESS_STATUS_CHARS = 400;
const PERMANENT_PROGRESS_EDIT_ERROR_RE =
  /message to edit not found|message can't be edited|message_id_invalid/i;
const MISSING_PROGRESS_MESSAGE_ERROR_RE =
  /message to edit not found|message_id_invalid/i;
const MAX_PROGRESS_BACKOFF_MS = 30_000;

function formatProgressStatusText(
  rawText,
  token,
  maxChars = MAX_PROGRESS_STATUS_CHARS,
) {
  const scrubbed = redactTelegramSecrets(String(rawText ?? ""), token)
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (scrubbed.length === 0) return "";
  if (scrubbed.length <= maxChars) return scrubbed;

  let limit = Math.max(1, maxChars - 1);
  // Avoid cutting a UTF-16 surrogate pair in half.
  const prevCode = scrubbed.charCodeAt(limit - 1);
  if (prevCode >= 0xd800 && prevCode <= 0xdbff && limit > 1) {
    limit -= 1;
  }
  const window = scrubbed.slice(0, limit);
  const minSplit = Math.floor(limit * 0.4);
  const wordBreak = Math.max(
    window.lastIndexOf("\n"),
    window.lastIndexOf(" "),
    window.lastIndexOf("\t"),
  );
  const cut = wordBreak >= minSplit ? wordBreak : limit;
  const trimmed = scrubbed.slice(0, cut).trimEnd();
  return trimmed.length > 0 ? `${trimmed}…` : `${window}…`;
}

async function loadSavedOffset(offsetFile) {
  try {
    const raw = await readFile(offsetFile, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.lastUpdateId === "number" &&
      Number.isSafeInteger(parsed.lastUpdateId) &&
      parsed.lastUpdateId >= 0
    ) {
      return parsed.lastUpdateId;
    }
    return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

async function saveLastUpdateId(offsetFile, lastUpdateId) {
  await atomicWriteFile(
    offsetFile,
    `${JSON.stringify({ version: 1, lastUpdateId }, null, 2)}\n`,
    { mode: 0o600, dirMode: 0o700 },
  );
}

function sleepAbortable(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseCommand(text) {
  const match = /^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s|$)/i.exec(text);
  return match ? match[1].toLowerCase() : null;
}

function pickBestPhoto(photoSizes, maxBytes = MAX_TELEGRAM_PHOTO_BYTES) {
  const candidates = [...photoSizes].sort(
    (a, b) =>
      (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
  );
  for (const photo of candidates) {
    if (
      typeof photo?.file_id === "string" &&
      photo.file_id.length > 0 &&
      (photo.file_size == null || photo.file_size <= maxBytes)
    ) {
      return photo;
    }
  }
  return null;
}

export function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} д`);
  if (hours > 0) parts.push(`${hours} ч`);
  if (minutes > 0) parts.push(`${minutes} мин`);
  if (parts.length === 0) parts.push(`${seconds} с`);
  return parts.join(" ");
}

export function formatStatusMessage(status, nowMs = Date.now()) {
  const sessionText = status.hasActiveSession
    ? "активная сессия продолжается"
    : "сессия ещё не начата";
  const uptimeText = formatUptime(nowMs - (status.startedAt ?? nowMs));
  return [
    "Состояние бота:",
    `Модель: ${status.model} (effort: ${status.effort}, tier: ${status.serviceTier})`,
    `Разговор: ${sessionText}`,
    `Аптайм: ${uptimeText}`,
  ].join("\n");
}

function defaultLogger(line) {
  process.stderr.write(`${line}\n`);
}

export class TelegramBotRunner {
  #config;
  #api;
  #sessions;
  #allowedUserIds;
  #logger;
  #pollTimeoutSec;
  #typingIntervalMs;
  #retryDelayMs;
  #progressDelayMs;
  #progressEditIntervalMs;
  #now;
  #offsetFile;
  #offset = undefined;
  #abortController = null;
  #pollPromise = null;
  #chatQueues = new Map();
  #inFlight = new Set();
  #startedAt = Date.now();
  #stopped = false;

  constructor({
    config,
    api,
    sessions,
    env = process.env,
    logger = defaultLogger,
    pollTimeoutSec = 25,
    typingIntervalMs = 4000,
    retryDelayMs = 1000,
    interruptGraceMs = 2000,
    progressDelayMs = 3500,
    progressEditIntervalMs = 1500,
    now = () => Date.now(),
  }) {
    if (!config) throw new Error("TelegramBotRunner requires config");
    this.#config = config;
    this.#allowedUserIds = new Set(config.allowedUserIds ?? []);
    this.#logger = (line) =>
      logger(redactTelegramSecrets(line, this.#config.token));
    this.#pollTimeoutSec = pollTimeoutSec;
    this.#typingIntervalMs = typingIntervalMs;
    this.#retryDelayMs = retryDelayMs;
    this.#progressDelayMs = progressDelayMs;
    this.#progressEditIntervalMs = progressEditIntervalMs;
    this.#now = now;
    this.#offsetFile = path.join(config.stateDir, "offset.json");

    this.#api =
      api ??
      new TelegramApi({
        token: config.token,
        apiBase: config.apiBase,
      });

    this.#sessions =
      sessions ??
      new CodexSessionManager({
        config,
        env,
        logger: this.#logger,
        interruptGraceMs,
      });
  }

  async start() {
    if (this.#allowedUserIds.size === 0) {
      throw new Error(
        `TELEGRAM_ALLOWED_USER_IDS is empty; refusing to start in open mode. Run "npm run telegram:pair" (or set TELEGRAM_ALLOWED_USER_IDS in ${this.#config.envPath}) first.`,
      );
    }

    this.#stopped = false;
    this.#startedAt = this.#now();
    this.#abortController = new AbortController();

    await this.#sessions.prepareEnvironment();
    const savedLastUpdateId = await loadSavedOffset(this.#offsetFile);
    if (savedLastUpdateId !== null) {
      this.#offset = savedLastUpdateId + 1;
    }

    await this.#api.deleteWebhook({
      drop_pending_updates: false,
      signal: this.#abortController.signal,
    });
    const me = await this.#api.getMe({ signal: this.#abortController.signal });
    const botHandle = me?.username ? `@${me.username}` : "bot";
    this.#logger(
      `[telegram] started ${botHandle} (${this.#allowedUserIds.size} allowed user(s), model=${this.#config.codexModel}, effort=${this.#config.codexEffort}, tier=${this.#config.codexServiceTier})`,
    );

    this.#pollPromise = this.#pollLoop();
    return me;
  }

  async #pollLoop() {
    let backoffMs = this.#retryDelayMs;

    while (!this.#stopped) {
      try {
        const updates = await this.#api.getUpdates({
          offset: this.#offset,
          timeout: this.#pollTimeoutSec,
          signal: this.#abortController.signal,
        });
        backoffMs = this.#retryDelayMs;

        if (Array.isArray(updates)) {
          for (const update of updates) {
            if (this.#stopped) break;
            if (typeof update?.update_id === "number") {
              this.#offset = Math.max(this.#offset ?? 0, update.update_id + 1);
              await saveLastUpdateId(this.#offsetFile, update.update_id);
            }
            this.#dispatchUpdate(update);
          }
        }
      } catch (error) {
        if (this.#stopped || error?.name === "AbortError") {
          break;
        }
        this.#logger(
          `[telegram] poll error: ${error?.message ?? String(error)}`,
        );
        const waitMs =
          error instanceof TelegramApiError && error.retryAfterSeconds
            ? Math.min(error.retryAfterSeconds * 1000, 30_000)
            : backoffMs;
        backoffMs = Math.min(backoffMs * 2, 10_000);
        await sleepAbortable(waitMs, this.#abortController.signal);
      }
    }
  }

  #dispatchUpdate(update) {
    if (this.#stopped) return;
    const msg = update?.message;
    if (!msg) return;
    if (msg.chat?.type !== "private") return;
    if (!msg.from || msg.from.is_bot) return;
    if (!this.#allowedUserIds.has(msg.from.id)) return;

    const chatKey = String(msg.chat.id);
    const previous = this.#chatQueues.get(chatKey) ?? Promise.resolve();
    const run = previous.then(() => this.#handleAuthorizedMessage(msg));

    const tracked = run
      .catch((error) => {
        this.#logger(
          `[telegram] unexpected chat handler error: ${error?.message ?? String(error)}`,
        );
      })
      .finally(() => {
        this.#inFlight.delete(tracked);
        if (this.#chatQueues.get(chatKey) === tracked) {
          this.#chatQueues.delete(chatKey);
        }
      });

    this.#inFlight.add(tracked);
    this.#chatQueues.set(chatKey, tracked);
  }

  async #handleAuthorizedMessage(msg) {
    if (this.#stopped) return;
    const chatId = msg.chat.id;
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;

    if (!hasPhoto && text.startsWith("/")) {
      const command = parseCommand(text);
      if (command === "start") {
        await this.#safeSendMessage(chatId, START_GREETING);
        return;
      }
      if (command === "new") {
        await this.#sessions.resetThread(chatId);
        await this.#safeSendMessage(chatId, NEW_SESSION_REPLY);
        return;
      }
      if (command === "status") {
        const status = {
          ...this.#sessions.getStatus(chatId),
          startedAt: this.#startedAt,
        };
        await this.#safeSendMessage(
          chatId,
          formatStatusMessage(status, this.#now()),
        );
        return;
      }
    }

    let chosenPhoto = null;
    if (hasPhoto) {
      chosenPhoto = pickBestPhoto(msg.photo, MAX_TELEGRAM_PHOTO_BYTES);
      if (!chosenPhoto) {
        await this.#safeSendMessage(
          chatId,
          "Фото больше 5 МБ — пришли, пожалуйста, картинку поменьше.",
        );
        return;
      }
    } else if (text.length === 0) {
      await this.#safeSendMessage(
        chatId,
        "Пока понимаю только текст и фото — напиши текстом или пришли картинку.",
      );
      return;
    }

    const stopTyping = this.#startTypingLoop(chatId);
    let progress = null;
    try {
      let input;
      if (chosenPhoto) {
        const dataUrl = await this.#api.downloadPhotoAsDataUrl(
          chosenPhoto.file_id,
          { signal: this.#abortController?.signal },
        );
        if (this.#stopped) {
          stopTyping();
          return;
        }
        const caption =
          typeof msg.caption === "string" ? msg.caption.trim() : "";
        input = [
          {
            type: "text",
            text: caption || "Посмотри на это фото и помоги по нему.",
          },
          { type: "image", url: dataUrl },
        ];
      } else {
        input = [{ type: "text", text }];
      }

      progress = this.#createProgressTracker(chatId);
      const reply = await this.#sessions.sendTurn(chatId, input, {
        onProgress: (commentary) => progress.update(commentary),
      });
      stopTyping();
      await progress.finish();
      if (this.#stopped) return;
      await this.#safeSendMessage(
        chatId,
        reply ||
          "Готово, но ответ пришёл пустым — уточни, если нужно подробнее.",
      );
    } catch (error) {
      stopTyping();
      if (progress) {
        await progress.finish();
      }
      if (this.#stopped || error?.name === "AbortError") {
        return;
      }
      this.#logger(
        `[telegram] error handling chat ${chatId}: ${error?.message ?? String(error)}`,
      );
      await this.#safeSendMessage(chatId, this.#formatUserError(error));
    }
  }

  #createProgressTracker(chatId) {
    let closed = false;
    let editsDisabled = false;
    let statusMessageId = null;
    let latestText = "";
    let displayedText = "";
    let lastAttemptedText = "";
    let nextEditAt = 0;
    let editTimer = null;
    let opChain = Promise.resolve();

    const enqueueOp = (task) => {
      const next = opChain.catch(() => {}).then(task);
      opChain = next.catch(() => {});
      return next;
    };

    const scheduleEdit = ({ forceAsync = false } = {}) => {
      if (closed || editsDisabled || statusMessageId == null) return;
      if (
        !latestText ||
        latestText === displayedText ||
        latestText === lastAttemptedText
      ) {
        return;
      }
      if (editTimer !== null) return;

      const rawWaitMs = Math.max(0, nextEditAt - this.#now());
      const waitMs = forceAsync ? Math.max(1, rawWaitMs) : rawWaitMs;
      const triggerEdit = () => {
        editTimer = null;
        if (closed || editsDisabled || statusMessageId == null) return;
        enqueueOp(async () => {
          if (closed || editsDisabled || statusMessageId == null) return;
          const targetText = latestText;
          if (
            !targetText ||
            targetText === displayedText ||
            targetText === lastAttemptedText
          ) {
            return;
          }
          lastAttemptedText = targetText;
          let failed = false;
          try {
            await this.#api.editMessageText(
              chatId,
              statusMessageId,
              targetText,
              { signal: this.#abortController?.signal },
            );
            displayedText = targetText;
            nextEditAt = this.#now() + this.#progressEditIntervalMs;
          } catch (error) {
            failed = true;
            if (this.#stopped || error?.name === "AbortError") return;
            this.#logger(
              `[telegram] progress edit failed for chat ${chatId}: ${error?.message ?? String(error)}`,
            );
            if (
              error instanceof TelegramApiError &&
              error.status === 400 &&
              PERMANENT_PROGRESS_EDIT_ERROR_RE.test(error.message)
            ) {
              editsDisabled = true;
              if (MISSING_PROGRESS_MESSAGE_ERROR_RE.test(error.message)) {
                statusMessageId = null;
              }
              return;
            }
            const retryAfterMs =
              error instanceof TelegramApiError && error.retryAfterSeconds
                ? Math.min(
                    error.retryAfterSeconds * 1000,
                    MAX_PROGRESS_BACKOFF_MS,
                  )
                : 0;
            const backoffMs = Math.max(
              this.#progressEditIntervalMs,
              retryAfterMs,
              1,
            );
            nextEditAt = this.#now() + backoffMs;
          }
          // Never auto-retry the same failed targetText; only reschedule when a
          // newer commentary arrived while this edit was in flight.
          if (
            !closed &&
            !editsDisabled &&
            latestText &&
            latestText !== targetText &&
            latestText !== displayedText
          ) {
            scheduleEdit({ forceAsync: failed });
          }
        });
      };

      if (waitMs === 0) {
        triggerEdit();
      } else {
        editTimer = setTimeout(triggerEdit, waitMs);
        editTimer.unref?.();
      }
    };

    const delayTimer = setTimeout(() => {
      if (closed || this.#stopped) return;
      enqueueOp(async () => {
        if (closed || this.#stopped || statusMessageId != null) return;
        const initialText = latestText || DEFAULT_PROGRESS_TEXT;
        try {
          const sent = await this.#api.sendMessage(chatId, initialText, {
            disableNotification: true,
            signal: this.#abortController?.signal,
          });
          statusMessageId = sent?.[0]?.message_id ?? null;
          if (statusMessageId == null) {
            editsDisabled = true;
            return;
          }
          displayedText = initialText;
          lastAttemptedText = initialText;
          nextEditAt = this.#now() + this.#progressEditIntervalMs;
        } catch (error) {
          editsDisabled = true;
          if (this.#stopped || error?.name === "AbortError") return;
          this.#logger(
            `[telegram] progress status send failed for chat ${chatId}: ${error?.message ?? String(error)}`,
          );
          return;
        }
        if (
          !closed &&
          !editsDisabled &&
          latestText &&
          latestText !== displayedText
        ) {
          scheduleEdit({ forceAsync: true });
        }
      });
    }, this.#progressDelayMs);
    delayTimer.unref?.();

    return {
      update: (rawText) => {
        if (closed) return;
        const formatted = formatProgressStatusText(rawText, this.#config.token);
        if (!formatted || formatted === latestText) return;
        latestText = formatted;
        if (
          !editsDisabled &&
          statusMessageId != null &&
          latestText !== displayedText &&
          latestText !== lastAttemptedText
        ) {
          scheduleEdit();
        }
      },
      finish: () => {
        if (closed) return opChain;
        closed = true;
        clearTimeout(delayTimer);
        if (editTimer !== null) {
          clearTimeout(editTimer);
          editTimer = null;
        }
        return enqueueOp(async () => {
          if (statusMessageId == null) return;
          const messageId = statusMessageId;
          statusMessageId = null;
          const deleteOptions = this.#stopped
            ? { timeoutMs: 500 }
            : { signal: this.#abortController?.signal };
          await this.#api
            .deleteMessage(chatId, messageId, deleteOptions)
            .catch(() => {});
        });
      },
    };
  }

  #startTypingLoop(chatId) {
    let active = true;
    const sendTyping = () => {
      if (!active || this.#stopped) return;
      this.#api
        .sendChatAction(chatId, "typing", {
          signal: this.#abortController?.signal,
        })
        .catch((error) => {
          if (this.#stopped || error?.name === "AbortError") return;
          this.#logger(
            `[telegram] sendChatAction failed: ${error?.message ?? String(error)}`,
          );
        });
    };
    sendTyping();
    const timer = setInterval(sendTyping, this.#typingIntervalMs);
    timer.unref?.();
    return () => {
      if (!active) return;
      active = false;
      clearInterval(timer);
    };
  }

  #formatUserError(error) {
    if (error instanceof CodexTurnTimeoutError) {
      return "Запрос занял слишком много времени, я его остановил. Если это было действие по дому, оно могло успеть выполниться — проверь состояние или спроси снова.";
    }
    if (error instanceof TelegramApiError && error.code === "photo_too_large") {
      return "Фото больше 5 МБ — пришли, пожалуйста, картинку поменьше.";
    }
    return "Не получилось обработать запрос — попробуй ещё раз чуть позже.";
  }

  async #safeSendMessage(chatId, text) {
    if (this.#stopped) return;
    try {
      await this.#api.sendMessage(
        chatId,
        redactTelegramSecrets(text, this.#config.token),
        { signal: this.#abortController?.signal },
      );
    } catch (error) {
      if (this.#stopped || error?.name === "AbortError") return;
      this.#logger(
        `[telegram] sendMessage failed for chat ${chatId}: ${error?.message ?? String(error)}`,
      );
    }
  }

  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#abortController?.abort();
    const poll = this.#pollPromise;
    this.#pollPromise = null;
    // Close sessions immediately alongside poll teardown so wedged turns do
    // not hold shutdown open up to turnTimeoutMs.
    await Promise.allSettled([
      poll ?? Promise.resolve(),
      this.#sessions.close(),
    ]);
    if (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }
}

export async function runPairMode({
  config,
  api,
  logger = defaultLogger,
  pollTimeoutSec = 25,
  signal,
}) {
  const safeLog = (line) => logger(redactTelegramSecrets(line, config.token));
  const telegram =
    api ??
    new TelegramApi({
      token: config.token,
      apiBase: config.apiBase,
    });

  const offsetFile = path.join(config.stateDir, "offset.json");
  const savedLastUpdateId = await loadSavedOffset(offsetFile);
  let offset = savedLastUpdateId !== null ? savedLastUpdateId + 1 : undefined;

  await telegram.deleteWebhook({ drop_pending_updates: false, signal });
  const me = await telegram.getMe({ signal });
  const botHandle = me?.username ? `@${me.username}` : "your bot";
  safeLog(
    `[telegram:pair] waiting for a private message to ${botHandle} to authorize a user...`,
  );

  while (!signal?.aborted) {
    const updates = await telegram.getUpdates({
      offset,
      timeout: pollTimeoutSec,
      signal,
    });
    if (!Array.isArray(updates)) continue;

    for (const update of updates) {
      if (typeof update?.update_id === "number") {
        offset = Math.max(offset ?? 0, update.update_id + 1);
        await saveLastUpdateId(offsetFile, update.update_id);
      }
      const msg = update?.message;
      if (
        msg?.chat?.type !== "private" ||
        !msg.from ||
        msg.from.is_bot ||
        !Number.isSafeInteger(msg.from.id) ||
        msg.from.id <= 0
      ) {
        continue;
      }

      const userId = msg.from.id;
      const allowedUserIds = await saveAllowedUserIds(
        config.envPath,
        config.token,
        [...config.allowedUserIds, userId],
      );

      // Acknowledge the offset to Telegram so the pairing message is not replayed.
      await telegram.getUpdates({ offset, timeout: 0, signal }).catch(() => {});

      await telegram.sendMessage(msg.chat.id, PAIR_CONFIRMATION, { signal });
      safeLog(
        `[telegram:pair] authorized user ${userId} in ${config.envPath} (allowed: ${allowedUserIds.join(",")})`,
      );
      return {
        userId,
        allowedUserIds,
        botUsername: me?.username ?? null,
      };
    }
  }

  throw new Error("Pairing cancelled");
}

async function main(onTokenLoaded) {
  const isPair = process.argv.includes("--pair");
  const config = await loadTelegramConfig();
  onTokenLoaded?.(config.token);
  const controller = new AbortController();

  if (isPair) {
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    await runPairMode({
      config,
      signal: controller.signal,
    });
    process.exit(0);
  }

  const runner = new TelegramBotRunner({ config });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runner.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await runner.start();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  let loadedToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  try {
    await main((token) => {
      loadedToken = token;
    });
  } catch (error) {
    const scrubbed = redactTelegramSecrets(
      error?.message ?? String(error),
      loadedToken,
    );
    process.stderr.write(`[telegram] fatal: ${scrubbed}\n`);
    process.exit(1);
  }
}
