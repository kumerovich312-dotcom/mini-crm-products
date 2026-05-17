import { getErrorMessage } from "../bot/utils.js";
import type { TelegramMessage } from "./types.js";

type TelegramMethod =
  | "answerCallbackQuery"
  | "deleteMessage"
  | "editMessageText"
  | "getMe"
  | "getFile"
  | "sendMessage"
  | "sendPhoto"
  | "sendVideo";

type TelegramApiOptions = {
  action?: string;
  chatId?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number | ((attempt: number) => number);
  suppressErrorLog?: boolean;
};

export class TelegramFileError extends Error {
  constructor(
    message: string,
    public readonly code: "get_file" | "download_file" | "file_too_large",
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "TelegramFileError";
  }
}

class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

function errorCode(error: unknown) {
  if (error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause) {
    const code = (error.cause as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function getTelegramToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing.");
  return token;
}

function timeoutForMethod(method: TelegramMethod) {
  if (method === "answerCallbackQuery") return 2000;
  if (method === "deleteMessage") return 5000;
  if (method === "getFile") return 8000;
  if (method === "sendPhoto" || method === "sendVideo") return 15000;
  return 8000;
}

const RETRYABLE_ERROR_CODES = new Set(["etimedout", "econnreset", "enetunreach", "eai_again", "enotfound"]);

function isFetchFailed(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("timeout") ||
    message.includes("aborted") ||
    message.includes("terminated")
  ) return true;
  if (error instanceof Error && error.cause != null) {
    const cause = error.cause as Record<string, unknown>;
    if (typeof cause.code === "string" && RETRYABLE_ERROR_CODES.has(cause.code.toLowerCase())) return true;
    const causeMsg = getErrorMessage(error.cause).toLowerCase();
    if (causeMsg.includes("etimedout") || causeMsg.includes("timeout") || causeMsg.includes("aborted")) return true;
  }
  return false;
}

export function isNonCriticalTelegramError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("query is too old") ||
    message.includes("query id is invalid") ||
    message.includes("response timeout expired") ||
    message.includes("message is not modified") ||
    message.includes("message to edit not found") ||
    message.includes("message can't be edited")
  );
}

export function isNonCriticalDeleteMessageError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("message to delete not found") || message.includes("message can't be deleted") || message.includes("bad request");
}

function isRetryableMethod(method: TelegramMethod) {
  return method === "answerCallbackQuery" || method === "editMessageText" || method === "sendMessage";
}

function errorCause(error: unknown) {
  if (error instanceof Error && error.cause) return getErrorMessage(error.cause);
  return undefined;
}

function logTelegramApiError(method: TelegramMethod, action: string, chatId: string | undefined, error: unknown) {
  const status = error instanceof TelegramApiError ? error.status : undefined;
  const responseBody = error instanceof TelegramApiError ? error.body : undefined;
  console.error("Telegram API error", {
    method,
    action,
    chatId,
    status,
    responseBody,
    message: getErrorMessage(error),
    code: errorCode(error),
    cause: errorCause(error),
    networkError: isFetchFailed(error),
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt: number) {
  return [300, 1000, 2500][attempt - 1] ?? 2500;
}

function safeTelegramFilePath(filePath: string) {
  return filePath.split("/").at(-1) ?? "telegram-file";
}

function telegramApiRetryDelay(options: TelegramApiOptions, attempt: number) {
  if (typeof options.retryDelayMs === "function") return options.retryDelayMs(attempt);
  if (typeof options.retryDelayMs === "number") return options.retryDelayMs;
  return 200;
}

async function parseTelegramBody(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRetryableFileError(error: unknown) {
  if (error instanceof TelegramFileError) {
    if (error.code === "file_too_large") return false;
    if (typeof error.status !== "number") return true; // network failure, no HTTP status
    return error.status >= 500;
  }
  return isFetchFailed(error);
}

function isRetryableTelegramApiError(error: unknown) {
  if (error instanceof TelegramApiError && typeof error.status === "number") return error.status >= 500;
  return isFetchFailed(error);
}

export async function telegramApi<T>(method: TelegramMethod, payload: Record<string, unknown>, options: TelegramApiOptions = {}) {
  const action = options.action ?? method;
  const chatId = options.chatId ?? (typeof payload.chat_id === "string" || typeof payload.chat_id === "number" ? String(payload.chat_id) : undefined);
  const maxAttempts = options.maxAttempts ?? (isRetryableMethod(method) ? 2 : 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? timeoutForMethod(method));

    try {
      const response = await fetch(`https://api.telegram.org/bot${getTelegramToken()}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = (await response.json()) as { ok: boolean; result?: T; description?: string };
      if (!response.ok || !body.ok) {
        throw new TelegramApiError(body.description ?? `Telegram API ${method} failed`, response.status, body);
      }
      return body.result as T;
    } catch (error) {
      if (isNonCriticalTelegramError(error)) throw error;
      if (method === "deleteMessage" && isNonCriticalDeleteMessageError(error)) throw error;
      if (attempt < maxAttempts && isRetryableTelegramApiError(error)) {
        await sleep(telegramApiRetryDelay(options, attempt));
        continue;
      }
      if (!options.suppressErrorLog) logTelegramApiError(method, action, chatId, error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Telegram API ${method} failed`);
}

export async function sendTelegramMessage(chatId: string, text: string, replyMarkup?: Record<string, unknown>, action = "send_message") {
  return telegramApi<TelegramMessage>("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup }, { action, chatId });
}

export async function editTelegramMessage(
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
  action = "edit_message",
) {
  try {
    return await telegramApi("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup }, { action, chatId });
  } catch (error) {
    if (getErrorMessage(error).toLowerCase().includes("message is not modified")) return null;
    throw error;
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string, chatId?: string) {
  try {
    return await telegramApi("answerCallbackQuery", { callback_query_id: callbackQueryId, text }, {
      action: "answer_callback",
      chatId,
      timeoutMs: 1500,
      maxAttempts: 2,
      retryDelayMs: 200,
    });
  } catch (error) {
    console.warn("Telegram API answerCallbackQuery ignored", { message: getErrorMessage(error), cause: errorCause(error) });
    return null;
  }
}

export async function getTelegramMe(action = "warmup_get_me") {
  return telegramApi("getMe", {}, { action, timeoutMs: 5000, maxAttempts: 2, retryDelayMs: 200, suppressErrorLog: true });
}

export async function deleteTelegramMessage(chatId: string, messageId: number, action = "delete_message") {
  return telegramApi("deleteMessage", { chat_id: chatId, message_id: messageId }, {
    action,
    chatId,
    timeoutMs: 5000,
    maxAttempts: 2,
    retryDelayMs: 200,
    suppressErrorLog: true,
  });
}

export async function sendTelegramPhoto(chatId: string, photo: string, payload: Record<string, unknown> = {}, action = "send_photo") {
  return telegramApi<TelegramMessage>("sendPhoto", { chat_id: chatId, photo, ...payload }, { action, chatId });
}

export async function sendTelegramVideo(chatId: string, video: string, payload: Record<string, unknown> = {}, action = "send_video") {
  return telegramApi<TelegramMessage>("sendVideo", { chat_id: chatId, video, ...payload }, { action, chatId });
}

export async function getTelegramFile(fileId: string) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    console.log("telegram file", { stage: "getFile", fileId, attempt });

    try {
      const params = new URLSearchParams({ file_id: fileId });
      const response = await fetch(`https://api.telegram.org/bot${getTelegramToken()}/getFile?${params.toString()}`, {
        signal: controller.signal,
      });
      const body = (await parseTelegramBody(response)) as { ok?: boolean; result?: { file_path?: string; file_size?: number }; description?: string };

      if (!response.ok || !body.ok) {
        console.error("Telegram API error", {
          method: "getFile",
          action: "get_file",
          fileId,
          message: body.description ?? `Telegram getFile failed with status ${response.status}`,
          status: response.status,
        });
        throw new TelegramFileError(body.description ?? "Telegram getFile failed", "get_file", response.status, body);
      }

      return body.result ?? {};
    } catch (error) {
      if (!(error instanceof TelegramFileError && error.status && error.status < 500)) {
        console.error("Telegram file download error", {
          stage: "getFile",
          message: getErrorMessage(error),
          code: errorCode(error),
          cause: errorCause(error),
          attempt,
          fileId,
        });
      }
      if (attempt < 3 && isRetryableFileError(error)) {
        await sleep(retryDelay(attempt));
        continue;
      }
      if (!(error instanceof TelegramFileError)) {
        throw new TelegramFileError(getErrorMessage(error), "get_file");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new TelegramFileError("Telegram getFile failed", "get_file");
}

export async function downloadTelegramFile(filePath: string) {
  const path = safeTelegramFilePath(filePath);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(`https://api.telegram.org/file/bot${getTelegramToken()}/${filePath}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new TelegramFileError(`Telegram file download failed with status ${response.status}.`, "download_file", response.status);
      }

      const buffer = await response.arrayBuffer();
      console.log("telegram file", { stage: "download", attempt, bytes: buffer.byteLength, path });
      return {
        buffer,
        bytes: buffer.byteLength,
        contentType: response.headers.get("content-type") ?? undefined,
      };
    } catch (error) {
      console.error("Telegram file download error", {
        stage: "download",
        message: getErrorMessage(error),
        code: errorCode(error),
        cause: errorCause(error),
        attempt,
        path,
      });
      if (attempt < 3 && isRetryableFileError(error)) {
        await sleep(retryDelay(attempt));
        continue;
      }
      throw error instanceof TelegramFileError ? error : new TelegramFileError(getErrorMessage(error), "download_file");
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new TelegramFileError("Telegram file download failed", "download_file");
}
