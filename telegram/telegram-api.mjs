import { DEFAULT_TELEGRAM_API_BASE, redactTelegramSecrets } from "./config.mjs";
import { splitTelegramHtmlChunks } from "./format-html.mjs";

export const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;
export const MAX_TELEGRAM_PHOTO_BYTES = 5 * 1024 * 1024;
const TELEGRAM_HTML_PARSE_ERROR_RE =
  /can't parse entities|unsupported start tag|unclosed|expected end tag/i;
const TELEGRAM_NOT_MODIFIED_ERROR_RE = /message is not modified/i;
const DISABLED_LINK_PREVIEW = { is_disabled: true };

export class TelegramApiError extends Error {
  constructor(
    message,
    {
      method = "",
      status = null,
      retryAfterSeconds = null,
      code = "api_error",
    } = {},
  ) {
    super(message);
    this.name = "TelegramApiError";
    this.method = method;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.code = code;
  }
}

export function splitTelegramMessage(
  text,
  maxLength = MAX_TELEGRAM_MESSAGE_LENGTH,
) {
  const input = String(text ?? "");
  if (input.length === 0) return [];
  if (input.length <= maxLength) return [input];

  const chunks = [];
  const minSplit = Math.max(1, Math.floor(maxLength * 0.4));
  let remaining = input;

  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength);
    let splitAt = -1;

    const paraBreak = window.lastIndexOf("\n\n");
    if (paraBreak >= minSplit) {
      splitAt = paraBreak;
    } else {
      const lineBreak = window.lastIndexOf("\n");
      if (lineBreak >= minSplit) {
        splitAt = lineBreak;
      } else {
        const spaceBreak = Math.max(
          window.lastIndexOf(" "),
          window.lastIndexOf("\t"),
        );
        if (spaceBreak >= minSplit) {
          splitAt = spaceBreak;
        }
      }
    }

    if (splitAt <= 0) {
      splitAt = maxLength;
      // Avoid cutting a UTF-16 surrogate pair in half.
      const code = remaining.charCodeAt(splitAt - 1);
      if (code >= 0xd800 && code <= 0xdbff && splitAt > 1) {
        splitAt -= 1;
      }
    }

    const head = remaining.slice(0, splitAt).trimEnd();
    if (head.length > 0) {
      chunks.push(head);
    } else {
      chunks.push(remaining.slice(0, splitAt));
    }

    const tail = remaining.slice(splitAt).trimStart();
    if (tail.length === remaining.length) {
      // Defensive guard against zero progress on degenerate whitespace input.
      remaining = remaining.slice(splitAt);
    } else {
      remaining = tail;
    }
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function errorReason(error) {
  if (!error) return "unknown error";
  if (error.name === "TimeoutError") return "request timed out";
  return (
    error.cause?.code ?? error.cause?.message ?? error.message ?? String(error)
  );
}

function detectImageMime(filePath, contentTypeHeader) {
  const headerMime = String(contentTypeHeader ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (/^image\/[a-z0-9.+-]+$/.test(headerMime)) {
    return headerMime;
  }
  const lowerPath = String(filePath ?? "").toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function createAbortError() {
  const err = new Error("Telegram request aborted");
  err.name = "AbortError";
  return err;
}

export class TelegramApi {
  #token;
  #apiBase;
  #fetch;
  #requestTimeoutMs;
  #maxPhotoBytes;

  constructor({
    token,
    apiBase = DEFAULT_TELEGRAM_API_BASE,
    fetchImpl = fetch,
    requestTimeoutMs = 20_000,
    maxPhotoBytes = MAX_TELEGRAM_PHOTO_BYTES,
  }) {
    if (!token) throw new Error("TelegramApi requires a bot token");
    this.#token = token;
    this.#apiBase = String(apiBase).replace(/\/+$/, "");
    this.#fetch = fetchImpl;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxPhotoBytes = maxPhotoBytes;
  }

  #scrub(text) {
    return redactTelegramSecrets(text, this.#token);
  }

  #buildSignal(timeoutMs, externalSignal) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;
  }

  async call(
    method,
    params = {},
    { timeoutMs = this.#requestTimeoutMs, signal } = {},
  ) {
    const url = `${this.#apiBase}/bot${this.#token}/${method}`;
    let response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params ?? {}),
        signal: this.#buildSignal(timeoutMs, signal),
      });
    } catch (error) {
      if (signal?.aborted) throw createAbortError();
      throw new TelegramApiError(
        this.#scrub(`Telegram ${method} request failed: ${errorReason(error)}`),
        {
          method,
          code: error?.name === "TimeoutError" ? "timeout" : "network",
        },
      );
    }

    let rawText = "";
    try {
      rawText = await response.text();
    } catch (error) {
      if (signal?.aborted) throw createAbortError();
      throw new TelegramApiError(
        this.#scrub(
          `Telegram ${method} response read failed: ${errorReason(error)}`,
        ),
        { method, status: response.status, code: "network" },
      );
    }

    let payload = null;
    if (rawText.length > 0) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = null;
      }
    }

    if (!response.ok || payload?.ok !== true) {
      const description =
        payload?.description ??
        (rawText.slice(0, 200) || `HTTP ${response.status}`);
      throw new TelegramApiError(
        this.#scrub(
          `Telegram ${method} failed (${response.status}): ${description}`,
        ),
        {
          method,
          status: response.status,
          retryAfterSeconds: payload?.parameters?.retry_after ?? null,
          code: "api_error",
        },
      );
    }

    return payload.result;
  }

  getMe(options = {}) {
    return this.call("getMe", {}, options);
  }

  deleteWebhook({ drop_pending_updates = false, ...options } = {}) {
    return this.call("deleteWebhook", { drop_pending_updates }, options);
  }

  getUpdates({
    offset,
    timeout = 25,
    allowed_updates = ["message"],
    signal,
  } = {}) {
    const params = { timeout, allowed_updates };
    if (offset !== undefined && offset !== null) {
      params.offset = offset;
    }
    const timeoutMs = Math.max(this.#requestTimeoutMs, (timeout + 15) * 1000);
    return this.call("getUpdates", params, { timeoutMs, signal });
  }

  sendChatAction(chatId, action = "typing", options = {}) {
    return this.call("sendChatAction", { chat_id: chatId, action }, options);
  }

  async sendMessage(chatId, text, options = {}) {
    const trimmed = this.#scrub(String(text ?? "")).trim();
    if (trimmed.length === 0) return [];
    const {
      parseMode,
      disableNotification = false,
      ...callOptions
    } = options ?? {};
    const baseParams = {
      chat_id: chatId,
      link_preview_options: DISABLED_LINK_PREVIEW,
      ...(disableNotification ? { disable_notification: true } : {}),
    };

    if (parseMode === null || parseMode === false) {
      const chunks = splitTelegramMessage(trimmed, MAX_TELEGRAM_MESSAGE_LENGTH);
      const sent = [];
      for (const chunk of chunks) {
        sent.push(
          await this.call(
            "sendMessage",
            { ...baseParams, text: chunk },
            callOptions,
          ),
        );
      }
      return sent;
    }

    const chunks = splitTelegramHtmlChunks(
      trimmed,
      MAX_TELEGRAM_MESSAGE_LENGTH,
    );
    const sent = [];
    for (const chunk of chunks) {
      try {
        sent.push(
          await this.call(
            "sendMessage",
            { ...baseParams, text: chunk.html, parse_mode: "HTML" },
            callOptions,
          ),
        );
      } catch (error) {
        if (
          error instanceof TelegramApiError &&
          error.status === 400 &&
          TELEGRAM_HTML_PARSE_ERROR_RE.test(error.message)
        ) {
          sent.push(
            await this.call(
              "sendMessage",
              { ...baseParams, text: chunk.plain },
              callOptions,
            ),
          );
          continue;
        }
        throw error;
      }
    }
    return sent;
  }

  async editMessageText(chatId, messageId, text, options = {}) {
    const trimmed = this.#scrub(String(text ?? "")).trim();
    if (trimmed.length === 0) return null;
    const { parseMode, ...callOptions } = options ?? {};
    const baseParams = {
      chat_id: chatId,
      message_id: messageId,
      link_preview_options: DISABLED_LINK_PREVIEW,
    };

    const callEdit = async (params) => {
      try {
        return await this.call("editMessageText", params, callOptions);
      } catch (error) {
        if (
          error instanceof TelegramApiError &&
          error.status === 400 &&
          TELEGRAM_NOT_MODIFIED_ERROR_RE.test(error.message)
        ) {
          return null;
        }
        throw error;
      }
    };

    if (parseMode === null || parseMode === false) {
      const plainChunk = splitTelegramMessage(
        trimmed,
        MAX_TELEGRAM_MESSAGE_LENGTH,
      )[0];
      if (!plainChunk) return null;
      return callEdit({ ...baseParams, text: plainChunk });
    }

    const chunk = splitTelegramHtmlChunks(
      trimmed,
      MAX_TELEGRAM_MESSAGE_LENGTH,
    )[0];
    if (!chunk) return null;

    try {
      return await callEdit({
        ...baseParams,
        text: chunk.html,
        parse_mode: "HTML",
      });
    } catch (error) {
      if (
        error instanceof TelegramApiError &&
        error.status === 400 &&
        TELEGRAM_HTML_PARSE_ERROR_RE.test(error.message)
      ) {
        return callEdit({ ...baseParams, text: chunk.plain });
      }
      throw error;
    }
  }

  deleteMessage(chatId, messageId, options = {}) {
    return this.call(
      "deleteMessage",
      { chat_id: chatId, message_id: messageId },
      options,
    );
  }

  async downloadPhotoAsDataUrl(fileId, { signal, timeoutMs = 30_000 } = {}) {
    const fileInfo = await this.call(
      "getFile",
      { file_id: fileId },
      { timeoutMs, signal },
    );

    if (
      typeof fileInfo?.file_size === "number" &&
      fileInfo.file_size > this.#maxPhotoBytes
    ) {
      throw new TelegramApiError("Photo exceeds 5 MB limit", {
        method: "getFile",
        code: "photo_too_large",
      });
    }

    const rawFilePath = String(fileInfo?.file_path ?? "").replace(/^\/+/, "");
    if (
      rawFilePath.length === 0 ||
      rawFilePath.split("/").some((segment) => segment === "..")
    ) {
      throw new TelegramApiError(
        "Telegram getFile returned an invalid file_path",
        {
          method: "getFile",
          code: "invalid_file_path",
        },
      );
    }

    const encodedPath = rawFilePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const fileUrl = `${this.#apiBase}/file/bot${this.#token}/${encodedPath}`;

    let response;
    try {
      response = await this.#fetch(fileUrl, {
        method: "GET",
        signal: this.#buildSignal(timeoutMs, signal),
      });
    } catch (error) {
      if (signal?.aborted) throw createAbortError();
      throw new TelegramApiError(
        this.#scrub(`Telegram photo download failed: ${errorReason(error)}`),
        {
          method: "downloadFile",
          code: error?.name === "TimeoutError" ? "timeout" : "network",
        },
      );
    }

    if (!response.ok) {
      throw new TelegramApiError(
        this.#scrub(`Telegram photo download failed (${response.status})`),
        { method: "downloadFile", status: response.status, code: "api_error" },
      );
    }

    const contentLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > this.#maxPhotoBytes) {
      await response.body?.cancel().catch(() => {});
      throw new TelegramApiError("Photo exceeds 5 MB limit", {
        method: "downloadFile",
        code: "photo_too_large",
      });
    }

    const chunks = [];
    let totalBytes = 0;
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > this.#maxPhotoBytes) {
            throw new TelegramApiError("Photo exceeds 5 MB limit", {
              method: "downloadFile",
              code: "photo_too_large",
            });
          }
          chunks.push(buf);
        }
      } else {
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.length > this.#maxPhotoBytes) {
          throw new TelegramApiError("Photo exceeds 5 MB limit", {
            method: "downloadFile",
            code: "photo_too_large",
          });
        }
        chunks.push(buf);
      }
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (signal?.aborted) throw createAbortError();
      throw new TelegramApiError(
        this.#scrub(`Telegram photo stream failed: ${errorReason(error)}`),
        { method: "downloadFile", code: "network" },
      );
    }

    const mime = detectImageMime(
      rawFilePath,
      response.headers.get("content-type"),
    );
    return `data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`;
  }
}
