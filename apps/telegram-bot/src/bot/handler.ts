import { getSupabaseAdmin } from "../supabase/admin.js";
import { AiUnavailableError, generateProductAi, transcribeAudio, type ProductAiResult } from "../ai/client.js";
import type { ProductAiAction, ProductAiInput } from "../ai/productPrompts.js";
import { parseProductVoiceTranscript, type ProductVoiceParseResult, type VoiceDraftContext } from "../ai/productVoiceParser.js";
import {
  answerCallbackQuery,
  deleteTelegramMessage,
  downloadTelegramFile as downloadTelegramFileByPath,
  editTelegramMessage,
  getTelegramFile,
  isNonCriticalDeleteMessageError,
  isNonCriticalTelegramError,
  sendTelegramMessage,
  TelegramFileError,
} from "../telegram/api.js";
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate, TelegramUser } from "../telegram/types.js";
import type { Category, Company, CustomField, Product, ProductCustomValue, ProductMedia, ProductStatus } from "./database.js";
import { createId, getErrorMessage } from "./utils.js";

const MEDIA_BUCKET = "product-media";
const NOT_CONNECTED = "Сначала подключите бота. Откройте CRM → Настройки → Telegram-бот и отправьте сюда код подключения.";
const TELEGRAM_FILE_SIZE_LIMIT_BYTES = 300 * 1024 * 1024;
const AI_VOICE_FILE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;
const VOICE_TRANSCRIPT_KEY = "__voice_transcript";
const VOICE_ATTRIBUTES_KEY = "__voice_attributes";
const VOICE_WEIGHT_KEY = "__voice_weight";
const VOICE_MISSING_KEY = "__voice_missing_required";
const VOICE_CATEGORY_SUGGESTION_KEY = "__voice_category_suggestion";

type TelegramConnection = {
  id: string;
  company_id: string;
  telegram_chat_id: string;
  telegram_user_id: string | null;
  telegram_username: string | null;
  is_active: boolean;
  last_menu_message_id: number | null;
  last_bot_message_id: number | null;
  active_screen_message_id: number | null;
};
type DraftMedia = {
  media_type: "photo" | "video";
  file_name: string;
  file_path: string;
  public_url: string;
  file_size_bytes: number | null;
};
type TelegramDraft = {
  id: string;
  company_id: string;
  telegram_chat_id: string;
  step: string;
  mode: string;
  product_id: string | null;
  category_id: string | null;
  name: string | null;
  price: number;
  stock: number;
  description: string | null;
  keywords: string[];
  media: DraftMedia[];
  custom_values: Record<string, unknown>;
  edit_field: string | null;
  created_product_id: string | null;
  step_history: string[];
  status: string;
};
type InlineButton = { text: string; callback_data: string };
type CachedConnection = {
  company_id: string;
  is_active: boolean;
  last_menu_message_id: number | null;
  last_bot_message_id: number | null;
  active_screen_message_id: number | null;
};
type ProductListSource = "search" | "latest" | "unknown";
type ProductAiCacheItem = {
  chatId: string;
  companyId: string;
  productId: string;
  action: ProductAiAction;
  result: ProductAiResult;
  source: ProductListSource;
  expiresAt: number;
};

const CONNECTION_CACHE_TTL_MS = 300_000;
const CATEGORY_CACHE_TTL_MS = 300_000;
const CUSTOM_FIELD_CACHE_TTL_MS = 300_000;
const RECENT_UPDATE_TTL_MS = 120_000;
const CLEANUP_QUEUE_LIMIT = 10;
const CALLBACK_COLD_AFTER_MS = 60_000;
const connectionCache = new Map<string, { value: CachedConnection | null; expiresAt: number }>();
const categoryCache = new Map<string, { value: Category[]; expiresAt: number }>();
const customFieldCache = new Map<string, { value: CustomField[]; expiresAt: number }>();
const recentUpdates = new Map<string, number>();
const screenCleanupQueue = new Map<string, number[]>();
const chatQueues = new Map<string, Promise<void>>();
const searchResultsCache = new Map<string, { products: Product[]; companyId: string; expiresAt: number }>();
const productAiCache = new Map<string, ProductAiCacheItem>();
let lastCallbackAt = 0;

function logTiming(action: string, startedAt: number, chatId?: string) {
  console.log("telegram timing", { action, ms: Date.now() - startedAt, chatId });
}

function logTotalTiming(action: string, startedAt: number, chatId?: string) {
  console.log("telegram timing total", { action, ms: Date.now() - startedAt, chatId });
}

function cachedConnectionToConnection(chatId: string, cached: CachedConnection): TelegramConnection {
  return {
    id: "cache",
    company_id: cached.company_id,
    telegram_chat_id: chatId,
    telegram_user_id: null,
    telegram_username: null,
    is_active: cached.is_active,
    last_menu_message_id: cached.last_menu_message_id,
    last_bot_message_id: cached.last_bot_message_id,
    active_screen_message_id: cached.active_screen_message_id,
  };
}

function clearConnectionCache(chatId: string) {
  connectionCache.delete(chatId);
}

function enqueueChatWork(chatId: string | undefined, work: () => Promise<void>) {
  if (!chatId) return work();

  const previous = chatQueues.get(chatId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  chatQueues.set(chatId, next);
  return next.finally(() => {
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
  });
}

function getCachedCompanyItems<T>(cache: Map<string, { value: T[]; expiresAt: number }>, companyId: string) {
  const cached = cache.get(companyId);
  if (!cached || cached.expiresAt <= Date.now()) {
    if (cached) cache.delete(companyId);
    return null;
  }
  return cached.value;
}

function setCachedCompanyItems<T>(cache: Map<string, { value: T[]; expiresAt: number }>, companyId: string, value: T[], ttlMs: number) {
  cache.set(companyId, { value, expiresAt: Date.now() + ttlMs });
}

function cleanupRecentUpdates(now = Date.now()) {
  for (const [key, expiresAt] of recentUpdates.entries()) {
    if (expiresAt <= now) recentUpdates.delete(key);
  }
}

function getDedupeKeys(update: TelegramUpdate) {
  const keys: string[] = [];
  if (typeof update.update_id === "number") keys.push(`update:${update.update_id}`);
  if (update.callback_query?.id) keys.push(`callback:${update.callback_query.id}`);
  return keys;
}

function isDuplicateUpdate(update: TelegramUpdate) {
  const keys = getDedupeKeys(update);
  if (keys.length === 0) return false;

  const now = Date.now();
  cleanupRecentUpdates(now);
  if (keys.some((key) => {
    const expiresAt = recentUpdates.get(key);
    return Boolean(expiresAt && expiresAt > now);
  })) {
    return true;
  }

  for (const key of keys) recentUpdates.set(key, now + RECENT_UPDATE_TTL_MS);
  return false;
}

function logTelegramError(stage: string, error: unknown, details?: Record<string, unknown>) {
  console.error("Telegram bot error", { stage, message: getErrorMessage(error), details });
}

function keyboard(rows: InlineButton[][]) {
  return { inline_keyboard: rows };
}

function navRows(includeCancel = true): InlineButton[][] {
  return [
    [
      { text: "⬅️ Назад", callback_data: "wizard:back" },
      { text: "🏠 Главное меню", callback_data: "nav:menu" },
    ],
    ...(includeCancel ? [[{ text: "❌ Отмена", callback_data: "draft:cancel" }]] : []),
  ];
}

function withNavRows(rows: InlineButton[][], includeCancel = true) {
  return [...rows, ...navRows(includeCancel)];
}

async function sendMessage(chatId: string, text: string, replyMarkup?: Record<string, unknown>, action = "send_message") {
  return sendTelegramMessage(chatId, text, replyMarkup ?? keyboard(navRows()), action);
}

function mainMenuRows(): InlineButton[][] {
  return [
    [
      { text: "➕ Добавить товар", callback_data: "menu:add_product" },
      { text: "🔎 Найти товар", callback_data: "menu:find_product" },
    ],
    [
      { text: "📦 Последние товары", callback_data: "menu:latest_products" },
      { text: "✏️ Изменить товар", callback_data: "menu:edit_product" },
    ],
    [
      { text: "📊 Статистика", callback_data: "menu:stats" },
      { text: "⚙️ Помощь", callback_data: "menu:help" },
    ],
  ];
}

async function updateConnectionMessageIds(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  values: { last_menu_message_id?: number | null; last_bot_message_id?: number | null; active_screen_message_id?: number | null },
) {
  Object.assign(connection, values);
  const cached = connectionCache.get(chatId);
  if (cached?.value) Object.assign(cached.value, values);

  const { error } = await supabase
    .from("telegram_connections")
    .update(values)
    .eq("company_id", connection.company_id)
    .eq("telegram_chat_id", chatId);
  if (error) throw error;
}

async function safeEditOrSend(
  chatId: string,
  messageId: number | null | undefined,
  text: string,
  replyMarkup?: Record<string, unknown>,
  action = "safe_edit_or_send",
) {
  if (messageId) {
    try {
      await editTelegramMessage(chatId, messageId, text, replyMarkup, action);
      return { mode: "edit" as const, messageId };
    } catch (error) {
      const message = getErrorMessage(error).toLowerCase();
      if (message.includes("message is not modified")) {
        return { mode: "edit" as const, messageId };
      }
      if (
        message.includes("message to edit not found") ||
        message.includes("message can't be edited") ||
        isNonCriticalTelegramError(error)
      ) {
        console.warn("telegram screen edit fallback", {
          action,
          chatId,
          messageId,
          reason: getErrorMessage(error),
        });
      } else {
        throw error;
      }
    }
  }

  const sent = await sendTelegramMessage(chatId, text, replyMarkup, action);
  return { mode: "send" as const, messageId: sent.message_id };
}

function enqueueScreenCleanup(chatId: string, messageId: number | null | undefined) {
  if (!messageId) return;
  const current = screenCleanupQueue.get(chatId) ?? [];
  const next = [...current.filter((id) => id !== messageId), messageId].slice(-CLEANUP_QUEUE_LIMIT);
  screenCleanupQueue.set(chatId, next);
  console.log("telegram cleanup", { chatId, messageId, deleted: false, queued: true });
}

function isQueuedForCleanup(chatId: string, messageId: number | null | undefined) {
  if (!messageId) return false;
  return (screenCleanupQueue.get(chatId) ?? []).includes(messageId);
}

async function safeDeleteMessage(chatId: string, messageId: number | null | undefined, action: string) {
  if (!messageId) return true;
  try {
    await deleteTelegramMessage(chatId, messageId, action);
    console.log("telegram cleanup", { chatId, messageId, deleted: true, queued: false });
    return true;
  } catch (error) {
    console.warn("telegram cleanup delete failed", {
      chatId,
      messageId,
      action,
      message: getErrorMessage(error),
      cause: error instanceof Error && error.cause ? getErrorMessage(error.cause) : undefined,
    });
    const deleted = isNonCriticalDeleteMessageError(error);
    console.log("telegram cleanup", { chatId, messageId, deleted, queued: !deleted });
    return deleted;
  }
}

async function flushScreenCleanupQueue(chatId: string, action: string, protectedMessageIds: Array<number | null | undefined> = []) {
  const queued = screenCleanupQueue.get(chatId);
  if (!queued?.length) return;

  screenCleanupQueue.delete(chatId);
  const remaining: number[] = [];
  const protectedIds = new Set(protectedMessageIds.filter((id): id is number => typeof id === "number"));
  for (const messageId of queued) {
    if (protectedIds.has(messageId)) {
      remaining.push(messageId);
      continue;
    }
    const deleted = await safeDeleteMessage(chatId, messageId, action);
    if (!deleted) remaining.push(messageId);
  }

  if (remaining.length) screenCleanupQueue.set(chatId, remaining.slice(-CLEANUP_QUEUE_LIMIT));
}

async function renderTelegramScreen({
  supabase,
  chatId,
  companyId,
  connection,
  screen,
  text,
  rows,
  preferMessageId,
  nav = true,
  cancel = true,
  forceNew = false,
}: {
  supabase: ReturnType<typeof getSupabaseAdmin>;
  chatId: string;
  companyId: string;
  connection?: TelegramConnection | null;
  screen: string;
  text: string;
  rows: InlineButton[][];
  preferMessageId?: number | null;
  nav?: boolean;
  cancel?: boolean;
  forceNew?: boolean;
}) {
  const screenConnection = connection ?? (await getConnection(supabase, chatId));
  if (companyId && screenConnection && screenConnection.company_id !== companyId) {
    throw new Error("Telegram connection company mismatch.");
  }
  const finalRows = nav ? withNavRows(rows, cancel) : rows;
  const replyMarkup = keyboard(finalRows);
  const targetMessageId =
    preferMessageId ??
    screenConnection?.active_screen_message_id ??
    screenConnection?.last_bot_message_id ??
    screenConnection?.last_menu_message_id;
  const targetQueuedForCleanup = isQueuedForCleanup(chatId, targetMessageId);
  const canEditTarget = Boolean(targetMessageId && !targetQueuedForCleanup);

  console.log("telegram screen render decision", {
    mode: forceNew ? "force_new" : "edit_or_send",
    screen,
    chatId,
    oldMessageId: targetMessageId,
    willEdit: !forceNew && canEditTarget,
    willSend: forceNew || !canEditTarget,
    reason: forceNew ? "force_new" : targetQueuedForCleanup ? "target_queued_for_cleanup" : targetMessageId ? "target_available" : "no_target",
  });

  void flushScreenCleanupQueue(chatId, `cleanup_queue:${screen}`, [
    targetMessageId,
    screenConnection?.active_screen_message_id,
    screenConnection?.last_bot_message_id,
    screenConnection?.last_menu_message_id,
  ]);

  let result: { mode: string; messageId: number };
  let oldMessageId: number | null | undefined;
  if (forceNew) {
    oldMessageId = targetMessageId;
    const sent = await sendTelegramMessage(chatId, text, replyMarkup, `render_screen:${screen}`);
    result = { mode: "force_new", messageId: sent.message_id };
    console.log("telegram screen render", { mode: "force_new", screen, chatId, oldMessageId, newMessageId: sent.message_id });
  } else {
    const editResult = await safeEditOrSend(chatId, canEditTarget ? targetMessageId : null, text, replyMarkup, `render_screen:${screen}`);
    result = editResult;
    if (targetMessageId && result.mode === "send") {
      console.warn("telegram screen fallback", {
        from: "edit",
        to: "send",
        reason: targetQueuedForCleanup ? "target_queued_for_cleanup" : "edit_failed_or_missing_target",
        oldMessageId: targetMessageId,
        newMessageId: result.messageId,
      });
    }
    console.log("telegram screen render", { mode: result.mode, screen, chatId, oldMessageId: targetMessageId, newMessageId: result.messageId });
  }

  if (screenConnection) {
    await updateConnectionMessageIds(supabase, chatId, screenConnection, {
      active_screen_message_id: result.messageId,
      last_bot_message_id: result.messageId,
      ...(screen === "main_menu" ? { last_menu_message_id: result.messageId } : {}),
    });
  }

  if (forceNew && oldMessageId && oldMessageId !== result.messageId) {
    void safeDeleteMessage(chatId, oldMessageId, `delete_for_new:${screen}`).then((deleted) => {
      if (!deleted) enqueueScreenCleanup(chatId, oldMessageId);
      const cached = connectionCache.get(chatId);
      if (deleted && cached?.value) {
        if (cached.value.active_screen_message_id === oldMessageId) cached.value.active_screen_message_id = result.messageId;
        if (cached.value.last_bot_message_id === oldMessageId) cached.value.last_bot_message_id = result.messageId;
        if (cached.value.last_menu_message_id === oldMessageId && screen === "main_menu") cached.value.last_menu_message_id = result.messageId;
      }
    });
  }

  return result;
}

async function showMainMenu(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  options: { messageId?: number | null; forceNew?: boolean } = {},
) {
  const result = await renderTelegramScreen({
    supabase,
    chatId,
    companyId: connection.company_id,
    connection,
    screen: "main_menu",
    text: "Главное меню",
    rows: mainMenuRows(),
    preferMessageId: options.messageId,
    nav: false,
    forceNew: options.forceNew,
  });
  console.log("telegram menu render", { mode: result.mode, chatId, messageId: result.messageId });
  return result;
}

async function showCancelledMenu(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  options: { messageId?: number | null; forceNew?: boolean } = {},
) {
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId: connection.company_id,
    connection,
    screen: "main_menu",
    text: "Действие отменено.\n\nГлавное меню",
    rows: mainMenuRows(),
    preferMessageId: options.messageId,
    nav: false,
    forceNew: options.forceNew,
  });
}

function getMessageMedia(message: TelegramMessage) {
  const photo = message.photo?.[message.photo.length - 1] ?? null;
  const video = message.video ?? null;
  const document = message.document ?? null;
  const imageDocument = document?.mime_type?.startsWith("image/") ? document : null;
  if (!photo && !video && !imageDocument) return null;
  return {
    fileId: photo?.file_id ?? video?.file_id ?? imageDocument?.file_id ?? "",
    fileSize: photo?.file_size ?? video?.file_size ?? imageDocument?.file_size ?? null,
    mediaType: photo || imageDocument ? ("photo" as const) : ("video" as const),
  };
}

function getMessageVoiceMedia(message: TelegramMessage) {
  const voice = message.voice ?? null;
  const audio = message.audio ?? null;
  const videoNote = message.video_note ?? null;
  if (!voice && !audio && !videoNote) return null;
  const fileId = voice?.file_id ?? audio?.file_id ?? videoNote?.file_id ?? "";
  const fileSize = voice?.file_size ?? audio?.file_size ?? videoNote?.file_size ?? null;
  const contentType = voice?.mime_type ?? audio?.mime_type ?? (videoNote ? "video/mp4" : undefined);
  const fileName = audio?.file_name ?? (voice ? "voice.oga" : "video-note.mp4");
  return { fileId, fileSize, contentType, fileName };
}

async function downloadTelegramFile(fileId: string) {
  const file = await getTelegramFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return file_path.");
  if (file.file_size && file.file_size > TELEGRAM_FILE_SIZE_LIMIT_BYTES) {
    throw new TelegramFileError("Telegram file is too large.", "file_too_large", undefined, { file_size: file.file_size });
  }

  const downloaded = await downloadTelegramFileByPath(file.file_path);
  return {
    buffer: downloaded.buffer,
    filePath: file.file_path,
    fileSize: file.file_size ?? downloaded.bytes,
    contentType: downloaded.contentType,
  };
}

async function downloadTelegramVoiceFile(fileId: string) {
  const file = await getTelegramFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return file_path.");
  if (file.file_size && file.file_size > AI_VOICE_FILE_SIZE_LIMIT_BYTES) {
    throw new TelegramFileError("Telegram voice file is too large.", "file_too_large", undefined, { file_size: file.file_size });
  }

  const downloaded = await downloadTelegramFileByPath(file.file_path);
  if (downloaded.bytes > AI_VOICE_FILE_SIZE_LIMIT_BYTES) {
    throw new TelegramFileError("Telegram voice file is too large.", "file_too_large", undefined, { file_size: downloaded.bytes });
  }
  return {
    buffer: downloaded.buffer,
    filePath: file.file_path,
    fileSize: file.file_size ?? downloaded.bytes,
    contentType: downloaded.contentType,
  };
}

function shortId() {
  return createId().replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 6);
}

function getExtension(filePath: string, fallback: string) {
  const cleanPath = filePath.split("?")[0] ?? "";
  const dotIndex = cleanPath.lastIndexOf(".");
  return dotIndex === -1 ? fallback : cleanPath.slice(dotIndex).toLowerCase();
}

function generateSkuDigits(length: number) {
  return Math.floor(Math.random() * 10 ** length).toString().padStart(length, "0");
}

function parsePrice(value: string) {
  const price = Number(value.replace(",", ".").trim());
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function parseStock(value: string) {
  const stock = Number(value.trim());
  return Number.isInteger(stock) && stock >= 0 ? stock : null;
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function sourceToCode(source: ProductListSource) {
  if (source === "search") return "s";
  if (source === "latest") return "l";
  return "u";
}

function codeToSource(code: string | undefined): ProductListSource {
  if (code === "s") return "search";
  if (code === "l") return "latest";
  return "unknown";
}

function productOpenCallback(productId: string, source: ProductListSource) {
  const code = sourceToCode(source);
  return code === "u" ? `p:o:${productId}` : `p:o:${productId}:${code}`;
}

function productBackCallback(productId: string, source: ProductListSource) {
  return `p:b:${productId}:${sourceToCode(source)}`;
}

function setSearchResultsCache(chatId: string, companyId: string, products: Product[]) {
  searchResultsCache.set(chatId, { companyId, products, expiresAt: Date.now() + 10 * 60_000 });
}

function getSearchResultsCache(chatId: string, companyId: string) {
  const cached = searchResultsCache.get(chatId);
  if (!cached || cached.companyId !== companyId || cached.expiresAt <= Date.now()) {
    if (cached) searchResultsCache.delete(chatId);
    return null;
  }
  return cached.products;
}

function mediaUploadErrorMessage(error: unknown) {
  if (error instanceof TelegramFileError) {
    if (error.code === "file_too_large") return "Файл слишком большой. Максимальный размер для загрузки: 300 MB.";
  }
  return "Не удалось загрузить файл из Telegram. Попробуйте отправить ещё раз или нажмите «Пропустить медиа».";
}

function notSpecified(kind: "male" | "female" | "neutral" = "neutral") {
  if (kind === "male") return "не указан";
  if (kind === "female") return "не указана";
  return "не указано";
}

function hasCompletedStep(draft: TelegramDraft, step: string) {
  return draft.step_history?.includes(step) || draft.step === "preview" || draft.step === "custom_fields";
}

function formatMoney(value: number) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : notSpecified("female");
}

function customFieldDisplayValue(field: CustomField, value: unknown) {
  const formatted = formatCustomValue(field, value);
  return formatted === "—" ? notSpecified() : formatted;
}

function isWeightField(field: CustomField) {
  const key = `${field.key} ${field.name}`.toLowerCase();
  return key.includes("weight") || key.includes("вес");
}

function draftCategoryLabel(category: Category | null) {
  return category ? `${category.code} · ${category.name}` : notSpecified("female");
}

function draftSummaryLines(draft: TelegramDraft, category: Category | null, fields: CustomField[] = []) {
  const fieldLines = fields.flatMap((field) => {
    const value = draft.custom_values?.[field.id];
    if (value === undefined || value === null || value === "") return [];
    const icon = isWeightField(field) ? "⚖️" : "▫️";
    return `${icon} ${field.name}: ${customFieldDisplayValue(field, value)}`;
  });
  return [
    "Товар:",
    `📦 Название: ${draft.name?.trim() || notSpecified("male")}`,
    `🏷 Категория: ${draftCategoryLabel(category)}`,
    `💰 Цена: ${hasCompletedStep(draft, "wait_price") ? formatMoney(draft.price) : notSpecified("female")}`,
    `📦 Остаток: ${hasCompletedStep(draft, "wait_stock") ? String(Number(draft.stock) || 0) : notSpecified("male")}`,
    `📝 Описание: ${draft.description?.trim() || notSpecified()}`,
    `🖼 Медиа: ${(draft.media ?? []).length > 0 ? `загружено (${draft.media.length})` : "не загружено"}`,
    ...fieldLines,
  ];
}

function wizardStepMeta(draft: TelegramDraft, fields: CustomField[] = []) {
  const total = 6 + fields.length;
  if (draft.step === "wait_media") return { index: 1, total, title: "Медиа" };
  if (draft.step === "choose_category") return { index: 2, total, title: "Категория" };
  if (draft.step === "wait_name") return { index: 3, total, title: "Название" };
  if (draft.step === "wait_price") return { index: 4, total, title: "Цена" };
  if (draft.step === "wait_stock") return { index: 5, total, title: "Остаток" };
  if (draft.step === "wait_description") return { index: 6, total, title: "Описание" };
  if (draft.step === "custom_fields" && draft.edit_field) {
    const fieldIndex = Math.max(fields.findIndex((field) => field.id === draft.edit_field), 0);
    return { index: 7 + fieldIndex, total, title: fields[fieldIndex]?.name ?? "Доп. поле" };
  }
  return { index: Math.min(total, 1), total, title: "Товар" };
}

function wizardPrompt(draft: TelegramDraft, field?: CustomField) {
  if (draft.step === "wait_media") return "Отправьте фото или видео товара.";
  if (draft.step === "choose_category") return "Выберите категорию товара.";
  if (draft.step === "wait_name") return "Введите название товара.";
  if (draft.step === "wait_price") return "Введите цену товара.";
  if (draft.step === "wait_stock") return "Введите остаток товара.";
  if (draft.step === "wait_description") return "Добавьте описание товара.";
  if (draft.step === "custom_fields" && field) return field.is_required ? `Введите ${field.name}.` : `Введите ${field.name} или пропустите поле.`;
  return "Продолжайте заполнение товара.";
}

function optionalRowsForDraftStep(draft: TelegramDraft, field?: CustomField): InlineButton[][] {
  if (draft.step === "wait_media") return [[{ text: "⏭ Пропустить медиа", callback_data: "media:skip" }]];
  if (draft.step === "wait_description") return [[{ text: "⏭ Пропустить описание", callback_data: "desc:skip" }]];
  if (draft.step === "custom_fields" && field && !field.is_required) return [[{ text: `⏭ Пропустить ${field.name}`, callback_data: `cfs:${field.id}` }]];
  return [];
}

async function renderAddWizardScreen({
  supabase,
  chatId,
  draft,
  connection,
  rows = [],
  messageId,
  forceNew,
  error,
  prompt,
}: {
  supabase: ReturnType<typeof getSupabaseAdmin>;
  chatId: string;
  draft: TelegramDraft;
  connection?: TelegramConnection | null;
  rows?: InlineButton[][];
  messageId?: number | null;
  forceNew?: boolean;
  error?: string;
  prompt?: string;
}) {
  const [category, fields] = await Promise.all([
    draft.category_id ? getCategory(supabase, draft.company_id, draft.category_id) : Promise.resolve(null),
    getCustomFields(supabase, draft.company_id),
  ]);
  const currentField = draft.step === "custom_fields" && draft.edit_field ? fields.find((field) => field.id === draft.edit_field) : undefined;
  const meta = wizardStepMeta(draft, fields);
  const text = [
    `Шаг ${meta.index} из ${meta.total} — ${meta.title}`,
    "",
    ...draftSummaryLines(draft, category, fields),
    "",
    ...(error ? [`⚠️ ${error}`, ""] : []),
    prompt ?? wizardPrompt(draft, currentField),
  ].join("\n");
  const finalRows = [...rows, ...optionalRowsForDraftStep(draft, currentField)];
  console.log("telegram wizard", { action: "render", step: draft.step, chatId, draftId: draft.id, mode: draft.mode });
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId: draft.company_id,
    connection,
    screen: draft.step,
    text,
    rows: finalRows,
    preferMessageId: messageId,
    forceNew,
  });
}

async function renderMediaRetryScreen(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  text: string,
  connection?: TelegramConnection | null,
  forceNew?: boolean,
  draft?: TelegramDraft,
) {
  if (draft) {
    return renderAddWizardScreen({ supabase, chatId, draft, connection, forceNew, error: text });
  }
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection,
    screen: "wait_media",
    text,
    rows: [[{ text: "Пропустить медиа", callback_data: "media:skip" }]],
    forceNew,
  });
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function getConnection(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string) {
  const cacheStartedAt = Date.now();
  const cached = connectionCache.get(chatId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    console.log("telegram cache", { type: "connection", hit: true, chatId });
    logTiming("get connection cache", cacheStartedAt, chatId);
    return cached.value?.is_active ? cachedConnectionToConnection(chatId, cached.value) : null;
  }
  if (cached) connectionCache.delete(chatId);
  console.log("telegram cache", { type: "connection", hit: false, chatId });

  const { data, error } = await supabase
    .from("telegram_connections")
    .select("id, company_id, telegram_chat_id, is_active, last_menu_message_id, last_bot_message_id, active_screen_message_id")
    .eq("telegram_chat_id", chatId)
    .eq("is_active", true)
    .limit(1);
  if (error) throw error;
  const connection = ((data?.[0] ?? null) as TelegramConnection | null) ?? null;
  connectionCache.set(chatId, {
    value: connection
      ? {
        company_id: connection.company_id,
        is_active: connection.is_active,
        last_menu_message_id: connection.last_menu_message_id,
        last_bot_message_id: connection.last_bot_message_id,
        active_screen_message_id: connection.active_screen_message_id,
      }
      : null,
    expiresAt: Date.now() + CONNECTION_CACHE_TTL_MS,
  });
  return connection;
}

async function getActiveDraft(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string, chatId: string) {
  const { data, error } = await supabase
    .from("telegram_product_drafts")
    .select("*")
    .eq("company_id", companyId)
    .eq("telegram_chat_id", chatId)
    .neq("step", "done")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data?.[0] ?? null) as TelegramDraft | null) ?? null;
}

async function clearDrafts(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string, chatId: string) {
  const { error } = await supabase
    .from("telegram_product_drafts")
    .delete()
    .eq("company_id", companyId)
    .eq("telegram_chat_id", chatId)
    .neq("step", "done");
  if (error) throw error;
}

async function createDraft(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  companyId: string,
  chatId: string,
  mode: string,
  step: string,
  extra: Record<string, unknown> = {},
) {
  await clearDrafts(supabase, companyId, chatId);
  const { data, error } = await supabase
    .from("telegram_product_drafts")
    .insert({ company_id: companyId, telegram_chat_id: chatId, mode, step, step_history: [], status: "draft", ...extra })
    .select("*")
    .single();
  if (error) throw error;
  return data as TelegramDraft;
}

function getDraftHistoryKey(draft: Pick<TelegramDraft, "step" | "edit_field">) {
  if (draft.edit_field) return `${draft.step}:${draft.edit_field}`;
  return draft.step;
}

function draftValuesWithHistory(draft: TelegramDraft, values: Record<string, unknown>) {
  if ("step_history" in values) return values;
  const nextStep = typeof values.step === "string" ? values.step : draft.step;
  const hasNextEditField = Object.prototype.hasOwnProperty.call(values, "edit_field");
  const nextEditField = hasNextEditField
    ? (typeof values.edit_field === "string" ? values.edit_field : null)
    : draft.edit_field;
  const isSameStep = nextStep === draft.step;
  const isSameCustomField = draft.step === "custom_fields" && nextStep === "custom_fields" && nextEditField === draft.edit_field;
  if (isSameStep && (draft.step !== "custom_fields" || isSameCustomField)) return values;
  const currentKey = getDraftHistoryKey(draft);
  const history = Array.isArray(draft.step_history) ? draft.step_history : [];
  if (history.at(-1) === currentKey) return values;
  return { ...values, step_history: [...history, currentKey] };
}

async function updateDraft(supabase: ReturnType<typeof getSupabaseAdmin>, draft: TelegramDraft, values: Record<string, unknown>) {
  const { data, error } = await supabase
    .from("telegram_product_drafts")
    .update(draftValuesWithHistory(draft, values))
    .eq("id", draft.id)
    .eq("company_id", draft.company_id)
    .select("*")
    .single();
  if (error) throw error;
  return data as TelegramDraft;
}

async function connectByCode(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string, user: TelegramUser | undefined, code: string) {
  const { data: codeData, error: codeError } = await supabase
    .from("telegram_connection_codes")
    .select("id, company_id")
    .eq("code", code)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (codeError) throw codeError;
  if (!codeData) return false;

  const { error } = await supabase.from("telegram_connections").upsert(
    {
      company_id: codeData.company_id,
      telegram_chat_id: chatId,
      telegram_user_id: user?.id ? String(user.id) : null,
      telegram_username: user?.username ?? null,
      is_active: true,
    },
    { onConflict: "company_id,telegram_chat_id" },
  );
  if (error) throw error;

  const { error: codeUpdateError } = await supabase
    .from("telegram_connection_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("id", codeData.id);
  if (codeUpdateError) throw codeUpdateError;
  clearConnectionCache(chatId);
  return true;
}

async function getCategories(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string) {
  const cached = getCachedCompanyItems(categoryCache, companyId);
  if (cached) {
    console.log("telegram cache", { type: "categories", hit: true, companyId });
    return cached;
  }
  console.log("telegram cache", { type: "categories", hit: false, companyId });

  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  const categories = ((data ?? []) as Category[]) ?? [];
  setCachedCompanyItems(categoryCache, companyId, categories, CATEGORY_CACHE_TTL_MS);
  return categories;
}

async function getCategory(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string, categoryId: string) {
  const cached = getCachedCompanyItems(categoryCache, companyId);
  const cachedCategory = cached?.find((category) => category.id === categoryId);
  if (cachedCategory) return cachedCategory;

  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .eq("company_id", companyId)
    .eq("id", categoryId)
    .maybeSingle();
  if (error) throw error;
  return (data as Category | null) ?? null;
}

async function sendCategoryKeyboard(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  companyId: string,
  chatId: string,
  text = "Выберите категорию",
  options: { connection?: TelegramConnection | null; messageId?: number | null; screen?: string; forceNew?: boolean; draft?: TelegramDraft | null } = {},
) {
  const categories = await getCategories(supabase, companyId);
  if (categories.length === 0) {
    await sendMessage(chatId, "Сначала создайте категорию в CRM.");
    return false;
  }
  const rows = categories.map((category) => [{ text: `${category.code} · ${category.name}`, callback_data: `cat:${category.id}` }]);
  if (options.draft?.mode === "add") {
    await renderAddWizardScreen({
      supabase,
      chatId,
      draft: options.draft,
      connection: options.connection,
      rows,
      messageId: options.messageId,
      forceNew: options.forceNew,
      prompt: text,
    });
    return true;
  }
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection: options.connection,
    screen: options.screen ?? "choose_category",
    text,
    rows,
    preferMessageId: options.messageId,
    forceNew: options.forceNew,
  });
  return true;
}

async function uploadTelegramMedia(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  companyId: string,
  targetId: string,
  fileId: string,
  mediaType: "photo" | "video",
  fileName?: string,
) {
  const downloaded = await downloadTelegramFile(fileId);
  const extension = getExtension(downloaded.filePath, mediaType === "photo" ? ".jpg" : ".mp4");
  const finalFileName = fileName ?? `draft-${shortId()}${extension}`;
  const storagePath = `${companyId}/telegram/${targetId}/${finalFileName}`;
  console.log("telegram file", { stage: "storage_upload", path: storagePath });
  const uploadResult = await withTimeout(
    supabase.storage.from(MEDIA_BUCKET).upload(storagePath, downloaded.buffer, {
      contentType: downloaded.contentType,
      upsert: false,
    }),
    30000,
    "Supabase storage upload timed out.",
  ) as { error?: unknown };
  const { error: uploadError } = uploadResult;
  if (uploadError) throw uploadError;
  const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(storagePath);
  return {
    media_type: mediaType,
    file_name: finalFileName,
    file_path: storagePath,
    public_url: data.publicUrl,
    file_size_bytes: downloaded.fileSize,
  } satisfies DraftMedia;
}

async function uploadDraftMediaFromMessage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  draft: TelegramDraft,
  message: TelegramMessage,
  nextStep: string,
) {
  const media = getMessageMedia(message);
  if (!media) return null;
  const item = await uploadTelegramMedia(supabase, draft.company_id, draft.id, media.fileId, media.mediaType);
  return updateDraft(supabase, draft, { media: [...(draft.media ?? []), item], step: nextStep });
}

async function buildUniqueSku(supabase: ReturnType<typeof getSupabaseAdmin>, company: Company, category: Category) {
  const randomDigits = company.sku_random_digits ?? 4;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sku = `${company.sku_prefix}-${category.code}-${generateSkuDigits(randomDigits)}`.toUpperCase();
    const { data, error } = await supabase.from("products").select("id").eq("company_id", company.id).eq("sku", sku);
    if (error) throw error;
    if (!data || data.length === 0) return sku;
  }
  return null;
}

async function getCompanyAndCategory(supabase: ReturnType<typeof getSupabaseAdmin>, draft: TelegramDraft) {
  if (!draft.category_id) throw new Error("Категория не выбрана.");
  const [{ data: companyData, error: companyError }, { data: categoryData, error: categoryError }] = await Promise.all([
    supabase.from("companies").select("*").eq("id", draft.company_id).maybeSingle(),
    supabase.from("categories").select("*").eq("company_id", draft.company_id).eq("id", draft.category_id).maybeSingle(),
  ]);
  if (companyError) throw companyError;
  if (categoryError) throw categoryError;
  const company = companyData as Company | null;
  const category = categoryData as Category | null;
  if (!company || !category) throw new Error("Компания или категория не найдены.");
  return { company, category };
}

async function getCustomFields(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string) {
  const cached = getCachedCompanyItems(customFieldCache, companyId);
  if (cached) {
    console.log("telegram cache", { type: "custom_fields", hit: true, companyId });
    return cached;
  }
  console.log("telegram cache", { type: "custom_fields", hit: false, companyId });

  const { data, error } = await supabase
    .from("custom_fields")
    .select("*")
    .eq("company_id", companyId)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  const fields = ((data ?? []) as CustomField[]) ?? [];
  setCachedCompanyItems(customFieldCache, companyId, fields, CUSTOM_FIELD_CACHE_TTL_MS);
  return fields;
}

function fieldType(field: CustomField) {
  return field.field_type as string;
}

function fieldOptions(field: CustomField) {
  return Array.isArray(field.options) ? field.options.filter((item): item is string => typeof item === "string") : [];
}

function formatCustomValue(field: CustomField, value: unknown) {
  if (value === undefined || value === null || value === "") return "—";
  if (fieldType(field) === "boolean") return value ? "Да" : "Нет";
  return String(value);
}

function parseCustomValue(field: CustomField, value: string) {
  const type = fieldType(field);
  if (type === "number") {
    const number = parsePrice(value);
    return number === null ? { error: "Введите число." } : { value: number };
  }
  if (type === "boolean") return { value: ["1", "true", "yes", "да"].includes(normalize(value)) };
  if (type === "date") {
    const normalized = value.trim();
    const match = normalized.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    const date = match ? `${match[3]}-${match[2]}-${match[1]}` : normalized;
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? { value: date } : { error: "Введите дату YYYY-MM-DD." };
  }
  return { value: value.trim() };
}

async function renderCustomFieldScreen(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft,
  field: CustomField,
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  const type = fieldType(field);
  if (type === "boolean") {
    await renderAddWizardScreen({
      supabase,
      chatId,
      draft,
      connection,
      rows: [
        [
          { text: "Да", callback_data: `cfb:${field.id}:1` },
          { text: "Нет", callback_data: `cfb:${field.id}:0` },
        ],
      ],
      messageId: options.messageId,
      forceNew: options.forceNew,
    });
    return;
  }
  if (type === "select") {
    await renderAddWizardScreen({
      supabase,
      chatId,
      draft,
      connection,
      rows: fieldOptions(field).map((option, index) => [{ text: option, callback_data: `cfo:${field.id}:${index}` }]),
      messageId: options.messageId,
      forceNew: options.forceNew,
    });
    return;
  }
  await renderAddWizardScreen({
    supabase,
    chatId,
    draft,
    connection,
    rows: [],
    messageId: options.messageId,
    forceNew: options.forceNew,
  });
}

async function askNextCustomField(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft,
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean } = {},
) {
  const fields = await getCustomFields(supabase, draft.company_id);
  const nextField = fields.find((field) => draft.custom_values?.[field.id] === undefined);
  if (!nextField) {
    await showAddPreview(supabase, chatId, await updateDraft(supabase, draft, { step: "preview", edit_field: null }), options);
    return;
  }

  const nextDraft = await updateDraft(supabase, draft, { step: "custom_fields", edit_field: nextField.id });
  await renderCustomFieldScreen(supabase, chatId, nextDraft, nextField, options);
}

async function showAddPreview(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft,
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean } = {},
) {
  const { company, category } = await getCompanyAndCategory(supabase, draft);
  const sku = await buildUniqueSku(supabase, company, category);
  if (!sku) {
    await sendMessage(chatId, "Не удалось сгенерировать SKU. Попробуйте ещё раз.");
    return;
  }
  const fields = await getCustomFields(supabase, draft.company_id);
  const customLines = fields
    .filter((field) => draft.custom_values?.[field.id] !== undefined)
    .map((field) => `▫️ ${field.name}: ${customFieldDisplayValue(field, draft.custom_values[field.id])}`);
  const text = [
    "Предпросмотр товара",
    "",
    `SKU: ${sku}`,
    `📦 Название: ${draft.name?.trim() || notSpecified("male")}`,
    `🏷 Категория: ${draftCategoryLabel(category)}`,
    `💰 Цена: ${formatMoney(draft.price)}`,
    `📦 Остаток: ${String(Number(draft.stock) || 0)}`,
    `📝 Описание: ${draft.description?.trim() || notSpecified()}`,
    `🖼 Медиа: ${(draft.media ?? []).length > 0 ? `загружено (${draft.media.length})` : "не загружено"}`,
    ...customLines,
  ].join("\n");
  console.log("telegram wizard", { action: "preview", step: draft.step, chatId, draftId: draft.id, mode: draft.mode });
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId: draft.company_id,
    connection: options.connection,
    screen: "preview",
    text,
    rows: [
      [
        { text: "✅ Сохранить товар", callback_data: `d:save:${sku}` },
        { text: "✏️ Изменить", callback_data: "d:edit" },
      ],
    ],
    preferMessageId: options.messageId,
    forceNew: options.forceNew,
  });
}

async function saveCustomValues(supabase: ReturnType<typeof getSupabaseAdmin>, draft: TelegramDraft, productId: string) {
  const fields = await getCustomFields(supabase, draft.company_id);
  const rows = fields.flatMap((field) => {
    const value = draft.custom_values?.[field.id];
    if (value === undefined || value === null || value === "") return [];
    const type = fieldType(field);
    return [{
      company_id: draft.company_id,
      product_id: productId,
      custom_field_id: field.id,
      value_text: type === "text" || type === "select" ? String(value) : null,
      value_number: type === "number" ? Number(value) : null,
      value_boolean: type === "boolean" ? Boolean(value) : null,
      value_date: type === "date" ? String(value) : null,
    }];
  });
  if (rows.length === 0) return;
  const { error } = await supabase.from("product_custom_values").insert(rows);
  if (error) throw error;
}

async function saveDraftAsProduct(supabase: ReturnType<typeof getSupabaseAdmin>, draft: TelegramDraft, preferredSku?: string) {
  if (!draft.name?.trim()) throw new Error("Название товара не заполнено.");
  const { company, category } = await getCompanyAndCategory(supabase, draft);
  const sku = preferredSku ?? (await buildUniqueSku(supabase, company, category));
  if (!sku) throw new Error("Не удалось сгенерировать уникальный SKU.");
  const { data: productData, error: productError } = await supabase
    .from("products")
    .insert({
      company_id: draft.company_id,
      category_id: category.id,
      sku,
      name: draft.name.trim(),
      price: Number(draft.price) || 0,
      stock: Number(draft.stock) || 0,
      status: "draft",
      description: draft.description?.trim() || null,
      keywords: Array.isArray(draft.keywords) ? draft.keywords : [],
      is_visible_in_api: false,
    })
    .select("id")
    .single();
  if (productError) throw productError;
  const productId = productData.id as string;
  const mediaRows = (draft.media ?? []).map((item, index) => {
    const extension = getExtension(item.file_name, item.media_type === "photo" ? ".jpg" : ".mp4");
    return {
      company_id: draft.company_id,
      product_id: productId,
      media_type: item.media_type,
      original_url: item.public_url,
      processed_url: item.public_url,
      thumbnail_url: item.media_type === "photo" ? item.public_url : null,
      file_name: `${sku}-${index + 1}${extension}`,
      file_size_bytes: item.file_size_bytes,
      status: "ready",
      sort_order: index,
    };
  });
  if (mediaRows.length > 0) {
    const { error } = await supabase.from("product_media").insert(mediaRows);
    if (error) throw error;
  }
  await saveCustomValues(supabase, draft, productId);
  await updateDraft(supabase, draft, { created_product_id: productId, step: "done" });
  return { sku, productId };
}

function productStatusLabel(status: string) {
  const labels: Record<string, string> = { active: "Активен", hidden: "Скрыт", draft: "Черновик", out_of_stock: "Нет в наличии" };
  return labels[status] ?? status;
}

function productApiSummary(product: Product) {
  return [
    "Товар:",
    `📦 Название: ${product.name?.trim() || "не указано"}`,
    `🆔 SKU: ${product.sku || "не указан"}`,
    `Статус: ${productStatusLabel(product.status || "hidden")}`,
    `API/Бот: ${product.is_visible_in_api ? "да" : "нет"}`,
  ];
}

async function getProduct(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string, productId: string) {
  const { data, error } = await supabase.from("products").select("*").eq("company_id", companyId).eq("id", productId).maybeSingle();
  if (error) throw error;
  return (data as Product | null) ?? null;
}

async function findProducts(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string, query: string) {
  const normalized = normalize(query);
  const { data, error } = await supabase
    .from("products")
    .select("id, company_id, sku, name, price, stock, status, is_visible_in_api, description, keywords, updated_at")
    .eq("company_id", companyId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (((data ?? []) as Product[]) ?? [])
    .filter((product) => {
      const haystack = [product.sku, product.name, product.description ?? "", ...(product.keywords ?? [])].join(" ").toLowerCase();
      return haystack.includes(normalized);
    })
    .slice(0, 5);
}

async function sendProductList(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  products: Product[],
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean; source?: ProductListSource; expired?: boolean } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  const companyId = connection?.company_id ?? products[0]?.company_id;
  const source = options.source ?? "search";
  if (products.length === 0) {
    if (!companyId) return sendMessage(chatId, "Товары не найдены.");
    await renderTelegramScreen({
      supabase,
      chatId,
      companyId,
      connection,
      screen: "search_results",
      text: options.expired ? "Результаты поиска устарели.\n\nТовары не найдены." : "Товары не найдены.",
      rows: [[{ text: "🏠 Главное меню", callback_data: "nav:menu" }]],
      preferMessageId: options.messageId,
      nav: false,
      forceNew: options.forceNew,
    });
    return;
  }
  if (source === "search") setSearchResultsCache(chatId, products[0].company_id, products);
  const title = source === "latest" ? "Последние товары" : options.expired ? "Результаты поиска устарели" : "Товары";
  const text = [title, ...products.map((product) => `${product.sku} — ${product.name}`)].join("\n");
  const rows = products.map((product) => [{ text: `${product.sku} — ${product.name}`, callback_data: productOpenCallback(product.id, source) }]);
  rows.push(source === "search"
    ? [
      { text: "⬅️ Назад", callback_data: "search:back" },
      { text: "🏠 Главное меню", callback_data: "nav:menu" },
    ]
    : [{ text: "🏠 Главное меню", callback_data: "nav:menu" }]);
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId: products[0].company_id,
    connection,
    screen: "search_results",
    text,
    rows,
    preferMessageId: options.messageId,
    nav: false,
    forceNew: options.forceNew,
  });
}

async function openProductCard(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean; source?: ProductListSource } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  const product = await getProduct(supabase, companyId, productId);
  if (!product) {
    await sendMessage(chatId, "Товар не найден.");
    return;
  }
  const [categoryResult, mediaResult, fieldsResult, valuesResult] = await Promise.all([
    product.category_id ? getCategory(supabase, companyId, product.category_id) : Promise.resolve(null),
    supabase.from("product_media").select("*").eq("company_id", companyId).eq("product_id", productId),
    getCustomFields(supabase, companyId),
    supabase.from("product_custom_values").select("*").eq("company_id", companyId).eq("product_id", productId),
  ]);
  const media = (((mediaResult.data ?? []) as ProductMedia[]) ?? []);
  const fields = fieldsResult;
  const values = (((valuesResult.data ?? []) as ProductCustomValue[]) ?? []);
  const customLines = values.flatMap((value) => {
    const field = fields.find((item) => item.id === value.custom_field_id);
    if (!field) return [];
    const type = fieldType(field);
    const displayValue = type === "number" ? value.value_number : type === "boolean" ? value.value_boolean : type === "date" ? value.value_date : value.value_text;
    return `${field.name}: ${formatCustomValue(field, displayValue)}`;
  });
  const text = [
    product.sku,
    product.name,
    `Категория: ${categoryResult ? categoryResult.name : "—"}`,
    `Цена: ${product.price}`,
    `Остаток: ${product.stock}`,
    `Статус: ${productStatusLabel(product.status)}`,
    `API/Бот: ${product.is_visible_in_api ? "да" : "нет"}`,
    `Описание: ${product.description || "—"}`,
    `Медиа: ${media.length}`,
    ...customLines,
  ].join("\n");
  const rows = [
    [
      { text: "✏️ Изменить", callback_data: `p:e:${product.id}` },
      { text: "💰 Цена", callback_data: `efp:price:${product.id}` },
    ],
    [
      { text: "📦 Остаток", callback_data: `efp:stock:${product.id}` },
      { text: "🤖 API", callback_data: `p:a:${product.id}:${sourceToCode(options.source ?? "unknown")}` },
    ],
    [
      { text: "🤖 AI", callback_data: `p:ai:screen:${product.id}:${sourceToCode(options.source ?? "unknown")}` },
    ],
    [
      { text: product.status === "hidden" ? "🙈 Показать" : "🙈 Скрыть", callback_data: `p:v:${product.id}` },
      { text: "🖼 Медиа", callback_data: `efp:media:${product.id}` },
    ],
    [
      { text: "⬅️ Назад", callback_data: productBackCallback(product.id, options.source ?? "unknown") },
      { text: "🏠 Главное меню", callback_data: "nav:menu" },
    ],
  ];
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection,
    screen: "product_card",
    text,
    rows,
    preferMessageId: options.messageId,
    nav: false,
    forceNew: options.forceNew,
  });
}

async function sendEditProductMenu(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  const product = await getProduct(supabase, companyId, productId);
  if (!product) {
    await sendMessage(chatId, "Товар не найден.");
    return;
  }
  const rows = [
    [
      { text: "Название", callback_data: `efp:name:${product.id}` },
      { text: "Категория", callback_data: `efp:category:${product.id}` },
    ],
    [
      { text: "Цена", callback_data: `efp:price:${product.id}` },
      { text: "Остаток", callback_data: `efp:stock:${product.id}` },
    ],
    [
      { text: "Описание", callback_data: `efp:description:${product.id}` },
      { text: "Статус", callback_data: `efp:status:${product.id}` },
    ],
    [
      { text: "API/Бот", callback_data: `p:a:${product.id}` },
      { text: "Медиа", callback_data: `efp:media:${product.id}` },
    ],
    [
      { text: "Custom fields", callback_data: `efp:custom:${product.id}` },
      { text: "Назад", callback_data: `p:o:${product.id}` },
    ],
  ];
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection,
    screen: "edit_menu",
    text: `Редактирование\n${product.sku} — ${product.name}`,
    rows,
    preferMessageId: options.messageId,
    cancel: false,
    forceNew: options.forceNew,
  });
}

async function startEditProduct(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean } = {},
) {
  await createDraft(supabase, companyId, chatId, "edit", "edit_menu", { product_id: productId });
  await sendEditProductMenu(supabase, chatId, companyId, productId, options);
}

type CallbackRenderOptions = { connection?: TelegramConnection; messageId?: number | null; callbackId?: string; source?: ProductListSource };

async function toggleVisibility(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  options: CallbackRenderOptions = {},
) {
  const product = await getProduct(supabase, companyId, productId);
  if (!product) return sendMessage(chatId, "Товар не найден.");
  if (product.status === "draft") return sendMessage(chatId, "Товар в черновике. Сначала откройте редактирование.");
  const nextStatus = product.status === "hidden" ? "active" : "hidden";
  const { error } = await supabase
    .from("products")
    .update(nextStatus === "hidden" ? { status: nextStatus, is_visible_in_api: false } : { status: nextStatus })
    .eq("company_id", companyId)
    .eq("id", productId);
  if (error) throw error;
  if (options.callbackId) await answerCallbackQuery(options.callbackId, nextStatus === "hidden" ? "Товар скрыт" : "Товар активирован", chatId);
  await openProductCard(supabase, chatId, companyId, productId, options);
}

async function showProductApiScreen(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  options: CallbackRenderOptions & { error?: boolean; retryAction?: "activate" | "activate_enable" | "enable" | "disable" } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  const product = await getProduct(supabase, companyId, productId);
  if (!product) return sendMessage(chatId, "Товар не найден.");

  const active = product.status === "active";
  const enabled = Boolean(product.is_visible_in_api);
  const sourceCode = sourceToCode(options.source ?? "unknown");
  console.log("telegram product api", {
    action: options.error ? "error_screen" : "screen",
    productId,
    chatId,
    enabled,
    active,
  });

  if (options.error) {
    return renderTelegramScreen({
      supabase,
      chatId,
      companyId,
      connection,
      screen: "product_api_error",
      text: [
        "Не удалось изменить API-доступ. Попробуйте ещё раз.",
        "",
        ...productApiSummary(product),
      ].join("\n"),
      rows: [
        [{ text: "🔄 Повторить", callback_data: options.retryAction ? `p:api:${options.retryAction}:${product.id}:${sourceCode}` : `p:a:${product.id}:${sourceCode}` }],
        [
          { text: "⬅️ Назад к товару", callback_data: `p:api:back:${product.id}:${sourceCode}` },
          { text: "🏠 Главное меню", callback_data: "nav:menu" },
        ],
      ],
      preferMessageId: options.messageId,
      nav: false,
    });
  }

  if (!active) {
    return renderTelegramScreen({
      supabase,
      chatId,
      companyId,
      connection,
      screen: "product_api_unavailable",
      text: [
        "⚠️ API-доступ недоступен",
        "",
        "Чтобы включить API/бот-доступ, сначала активируйте товар.",
        "",
        ...productApiSummary(product),
      ].join("\n"),
      rows: [
        [{ text: "✅ Активировать и включить API", callback_data: `p:api:activate_enable:${product.id}:${sourceCode}` }],
        [{ text: "✅ Только активировать", callback_data: `p:api:activate:${product.id}:${sourceCode}` }],
        [
          { text: "⬅️ Назад к товару", callback_data: `p:api:back:${product.id}:${sourceCode}` },
          { text: "🏠 Главное меню", callback_data: "nav:menu" },
        ],
      ],
      preferMessageId: options.messageId,
      nav: false,
    });
  }

  return renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection,
    screen: "product_api",
    text: [
      "🤖 API/Бот-доступ",
      "",
      ...productApiSummary(product),
    ].join("\n"),
    rows: [
      [
        enabled
          ? { text: "🚫 Отключить API", callback_data: `p:api:disable:${product.id}:${sourceCode}` }
          : { text: "✅ Включить API", callback_data: `p:api:enable:${product.id}:${sourceCode}` },
      ],
      [
        { text: "⬅️ Назад к товару", callback_data: `p:api:back:${product.id}:${sourceCode}` },
        { text: "🏠 Главное меню", callback_data: "nav:menu" },
      ],
    ],
    preferMessageId: options.messageId,
    nav: false,
  });
}

async function updateProductApiAccess(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  action: "activate" | "activate_enable" | "enable" | "disable",
  options: CallbackRenderOptions = {},
) {
  const enabled = action === "activate_enable" || action === "enable";
  const active = action === "activate" || action === "activate_enable";
  const payload =
    action === "activate"
      ? { status: "active" as ProductStatus }
      : action === "activate_enable"
        ? { status: "active" as ProductStatus, is_visible_in_api: true }
        : { is_visible_in_api: enabled };

  console.log("telegram product api", { action, productId, chatId, enabled, active });

  try {
    const { error } = await supabase
      .from("products")
      .update(payload)
      .eq("company_id", companyId)
      .eq("id", productId);
    if (error) throw error;
  } catch (error) {
    console.warn("telegram product api update failed", {
      action,
      productId,
      chatId,
      message: error instanceof Error ? error.message : String(error),
    });
    return showProductApiScreen(supabase, chatId, companyId, productId, { ...options, error: true, retryAction: action });
  }

  return openProductCard(supabase, chatId, companyId, productId, options);
}

async function toggleApi(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  options: CallbackRenderOptions = {},
) {
  return showProductApiScreen(supabase, chatId, companyId, productId, options);
}

function codeToAiAction(code: string | undefined): ProductAiAction | null {
  const actions: Record<string, ProductAiAction> = {
    id: "improve_description",
    wd: "write_description",
    in: "improve_name",
    kw: "generate_keywords",
    cat: "suggest_category",
  };
  return code ? actions[code] ?? null : null;
}

function aiCacheToken() {
  return createId().replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
}

function setProductAiCache(item: Omit<ProductAiCacheItem, "expiresAt">) {
  const token = aiCacheToken();
  productAiCache.set(token, { ...item, expiresAt: Date.now() + 10 * 60_000 });
  return token;
}

function getProductAiCache(token: string, chatId: string) {
  const item = productAiCache.get(token);
  if (!item || item.chatId !== chatId || item.expiresAt <= Date.now()) {
    if (item) productAiCache.delete(token);
    return null;
  }
  return item;
}

function productAiResultText(action: ProductAiAction, result: ProductAiResult) {
  if (action === "generate_keywords") {
    return result.keywords.length ? result.keywords.join(", ") : result.text;
  }
  if (action === "suggest_category") {
    return result.categoryName || result.text || "Категория не определена.";
  }
  return result.text;
}

async function buildProductAiInput(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  companyId: string,
  product: Product,
  category: Category | null,
): Promise<ProductAiInput> {
  const categories = await getCategories(supabase, companyId);
  return {
    name: product.name || "",
    sku: product.sku || "",
    category: category?.name ?? null,
    price: Number(product.price) || 0,
    stock: Number(product.stock) || 0,
    description: product.description ?? null,
    keywords: Array.isArray(product.keywords) ? product.keywords : [],
    categories: categories.map((item) => ({ id: item.id, name: item.name, code: item.code })),
  };
}

async function showProductAiScreen(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  options: CallbackRenderOptions = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  const product = await getProduct(supabase, companyId, productId);
  if (!product) return sendMessage(chatId, "Товар не найден.");
  const category = product.category_id ? await getCategory(supabase, companyId, product.category_id) : null;
  const sourceCode = sourceToCode(options.source ?? "unknown");
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection,
    screen: "product_ai",
    text: [
      "🤖 AI-помощник товара",
      "",
      "Товар:",
      `📦 Название: ${product.name?.trim() || "не указано"}`,
      `🏷 Категория: ${category?.name ?? "не указана"}`,
      `💰 Цена: ${Number.isFinite(Number(product.price)) ? product.price : 0}`,
      `📦 Остаток: ${Number.isFinite(Number(product.stock)) ? product.stock : 0}`,
      `📝 Описание: ${product.description?.trim() || "не указано"}`,
    ].join("\n"),
    rows: [
      [{ text: "✨ Улучшить описание", callback_data: `p:ai:r:id:${product.id}:${sourceCode}` }],
      [{ text: "📝 Написать описание", callback_data: `p:ai:r:wd:${product.id}:${sourceCode}` }],
      [{ text: "🏷 Предложить категорию", callback_data: `p:ai:r:cat:${product.id}:${sourceCode}` }],
      [{ text: "🔑 Ключевые слова", callback_data: `p:ai:r:kw:${product.id}:${sourceCode}` }],
      [{ text: "✍️ Улучшить название", callback_data: `p:ai:r:in:${product.id}:${sourceCode}` }],
      [
        { text: "⬅️ Назад к товару", callback_data: `p:ai:back:${product.id}:${sourceCode}` },
        { text: "🏠 Главное меню", callback_data: "nav:menu" },
      ],
    ],
    preferMessageId: options.messageId,
    nav: false,
  });
}

async function showProductAiGenerating(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  options: CallbackRenderOptions = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection,
    screen: "product_ai_generating",
    text: "🤖 Генерирую вариант...\nЭто может занять несколько секунд.",
    rows: [
      [
        { text: "⬅️ Назад к товару", callback_data: `p:ai:back:${productId}:${sourceToCode(options.source ?? "unknown")}` },
        { text: "🏠 Главное меню", callback_data: "nav:menu" },
      ],
    ],
    preferMessageId: options.messageId,
    nav: false,
  });
}

async function showProductAiPreview(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  token: string,
  item: ProductAiCacheItem,
  options: CallbackRenderOptions = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  const text = productAiResultText(item.action, item.result);
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection,
    screen: "product_ai_preview",
    text: [
      "AI предложил:",
      "",
      text || "Пустой результат.",
      item.action === "suggest_category" && item.result.categoryName ? `\nКатегория: ${item.result.categoryName}` : "",
    ].filter(Boolean).join("\n"),
    rows: [
      [
        { text: "✅ Применить", callback_data: `p:ai:ap:${token}` },
        { text: "🔄 Сгенерировать ещё", callback_data: `p:ai:rg:${token}` },
      ],
      [
        { text: "❌ Отмена", callback_data: `p:ai:s:${item.productId}:${sourceToCode(item.source)}` },
        { text: "⬅️ Назад к AI", callback_data: `p:ai:s:${item.productId}:${sourceToCode(item.source)}` },
      ],
    ],
    preferMessageId: options.messageId,
    nav: false,
  });
}

async function runProductAiAction(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  action: ProductAiAction,
  options: CallbackRenderOptions = {},
) {
  const startedAt = Date.now();
  await showProductAiGenerating(supabase, chatId, companyId, productId, options);
  try {
    const product = await getProduct(supabase, companyId, productId);
    if (!product) return sendMessage(chatId, "Товар не найден.");
    const category = product.category_id ? await getCategory(supabase, companyId, product.category_id) : null;
    const input = await buildProductAiInput(supabase, companyId, product, category);
    const result = await generateProductAi(action, input);
    const token = setProductAiCache({ chatId, companyId, productId, action, result, source: options.source ?? "unknown" });
    console.log("telegram ai", { action, productId, chatId, ms: Date.now() - startedAt });
    return showProductAiPreview(supabase, chatId, companyId, token, productAiCache.get(token) as ProductAiCacheItem, options);
  } catch (error) {
    const message = error instanceof AiUnavailableError ? error.message : "Не удалось выполнить AI-действие. Попробуйте ещё раз.";
    console.warn("telegram ai failed", { action, productId, chatId, message: error instanceof Error ? error.message : String(error) });
    return renderTelegramScreen({
      supabase,
      chatId,
      companyId,
      connection: options.connection,
      screen: "product_ai_unavailable",
      text: message,
      rows: [
        [
          { text: "⬅️ Назад к AI", callback_data: `p:ai:s:${productId}:${sourceToCode(options.source ?? "unknown")}` },
          { text: "🏠 Главное меню", callback_data: "nav:menu" },
        ],
      ],
      preferMessageId: options.messageId,
      nav: false,
    });
  }
}

async function applyProductAiResult(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  token: string,
  options: CallbackRenderOptions = {},
) {
  const item = getProductAiCache(token, chatId);
  if (!item) {
    console.warn("telegram ai failed", { action: "apply_expired", productId: undefined, chatId, message: "AI preview expired" });
    return showMainMenu(supabase, chatId, options.connection as TelegramConnection, { messageId: options.messageId });
  }

  const payload: Record<string, unknown> = {};
  if (item.action === "improve_description" || item.action === "write_description") payload.description = item.result.text || null;
  if (item.action === "improve_name") payload.name = item.result.text || undefined;
  if (item.action === "generate_keywords") payload.keywords = item.result.keywords;
  if (item.action === "suggest_category" && item.result.categoryId) {
    const category = await getCategory(supabase, item.companyId, item.result.categoryId);
    if (category) payload.category_id = category.id;
  }

  if (Object.keys(payload).length > 0) {
    const { error } = await supabase.from("products").update(payload).eq("company_id", item.companyId).eq("id", item.productId);
    if (error) {
      console.warn("telegram ai failed", { action: `apply_${item.action}`, productId: item.productId, chatId, message: error.message });
      return renderTelegramScreen({
        supabase,
        chatId,
        companyId: item.companyId,
        connection: options.connection,
        screen: "product_ai_apply_error",
        text: "Не удалось применить AI-результат. Попробуйте ещё раз.",
        rows: [
          [{ text: "🔄 Повторить", callback_data: `p:ai:ap:${token}` }],
          [
            { text: "⬅️ Назад к AI", callback_data: `p:ai:s:${item.productId}:${sourceToCode(item.source)}` },
            { text: "🏠 Главное меню", callback_data: "nav:menu" },
          ],
        ],
        preferMessageId: options.messageId,
        nav: false,
      });
    }
  }
  productAiCache.delete(token);
  console.log("telegram ai", { action: `apply_${item.action}`, productId: item.productId, chatId, ms: 0 });
  return openProductCard(supabase, chatId, item.companyId, item.productId, { connection: options.connection, messageId: options.messageId, source: item.source });
}

function voiceValueObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getVoiceAttributes(draft: TelegramDraft) {
  return Object.fromEntries(
    Object.entries(voiceValueObject(draft.custom_values?.[VOICE_ATTRIBUTES_KEY]))
      .flatMap(([key, value]) => {
        const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
        return key.trim() && text ? [[key.trim(), text]] : [];
      }),
  );
}

function getVoiceTranscript(draft: TelegramDraft) {
  const value = draft.custom_values?.[VOICE_TRANSCRIPT_KEY];
  return typeof value === "string" ? value : "";
}

function getVoiceWeight(draft: TelegramDraft) {
  const value = draft.custom_values?.[VOICE_WEIGHT_KEY];
  return typeof value === "string" ? value : "";
}

function getVoiceMissingRequired(draft: TelegramDraft) {
  const missing: string[] = [];
  if (!draft.name?.trim()) missing.push("название");
  if (!draft.category_id) missing.push("категория");
  if (!hasCompletedStep(draft, "wait_price")) missing.push("цена");
  if (!hasCompletedStep(draft, "wait_stock")) missing.push("остаток");
  return missing;
}

function parseAttributesText(text: string) {
  const attributes: Record<string, string> = {};
  for (const line of text.split(/\r?\n|,/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.includes(":") ? ":" : trimmed.includes("-") ? "-" : null;
    if (!separator) continue;
    const [rawKey, ...rawValue] = trimmed.split(separator);
    const key = rawKey.trim();
    const value = rawValue.join(separator).trim();
    if (key && value) attributes[key] = value;
  }
  return attributes;
}

function categoryNameScore(input: string, category: Category) {
  const needle = normalize(input);
  const haystack = normalize(`${category.name} ${category.code}`);
  if (!needle) return 0;
  if (normalize(category.name) === needle || normalize(category.code) === needle) return 1;
  if (haystack.includes(needle) || needle.includes(normalize(category.name))) return 0.82;
  const words = needle.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const matches = words.filter((word) => haystack.includes(word)).length;
  return matches / words.length * 0.7;
}

function matchVoiceCategory(categories: Category[], parsed: ProductVoiceParseResult) {
  if (!parsed.categoryName || parsed.confidence.category < 0.45) return null;
  const ranked = categories
    .map((category) => ({ category, score: categoryNameScore(parsed.categoryName as string, category) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 0.55) return null;
  return best.category;
}

function buildVoiceDraftContext(draft: TelegramDraft, category: Category | null): VoiceDraftContext {
  return {
    title: draft.name,
    categoryName: category?.name ?? null,
    price: hasCompletedStep(draft, "wait_price") ? Number(draft.price) : null,
    stock: hasCompletedStep(draft, "wait_stock") ? Number(draft.stock) : null,
    description: draft.description,
    weight: getVoiceWeight(draft) || null,
    attributes: getVoiceAttributes(draft),
    keywords: Array.isArray(draft.keywords) ? draft.keywords : [],
  };
}

function voiceCompletedSteps(parsed: ProductVoiceParseResult, category: Category | null) {
  const steps: string[] = ["wait_voice"];
  if (parsed.title) steps.push("wait_name");
  if (category) steps.push("choose_category");
  if (parsed.price !== null) steps.push("wait_price");
  if (parsed.stock !== null) steps.push("wait_stock");
  if (parsed.description) steps.push("wait_description");
  return steps;
}

function mergeStepHistory(history: string[], steps: string[]) {
  const result = [...history];
  for (const step of steps) {
    if (!result.includes(step)) result.push(step);
  }
  return result;
}

function voiceAttributesLines(attributes: Record<string, string>) {
  const entries = Object.entries(attributes);
  if (entries.length === 0) return ["Характеристики: не указаны"];
  return ["Характеристики:", ...entries.map(([key, value]) => `- ${key}: ${value}`)];
}

async function applyVoiceCustomValues(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  companyId: string,
  draft: TelegramDraft,
  parsed: ProductVoiceParseResult,
) {
  const fields = await getCustomFields(supabase, companyId);
  const nextValues: Record<string, unknown> = { ...(draft.custom_values ?? {}) };
  const attributes = { ...getVoiceAttributes(draft), ...parsed.attributes };
  if (parsed.weight) {
    attributes.вес = parsed.weight;
    nextValues[VOICE_WEIGHT_KEY] = parsed.weight;
  }
  nextValues[VOICE_ATTRIBUTES_KEY] = attributes;

  for (const field of fields) {
    const fieldKey = normalize(`${field.key} ${field.name}`);
    const attribute = Object.entries(attributes).find(([key]) => fieldKey.includes(normalize(key)) || normalize(key).includes(normalize(field.name)));
    if (!attribute) continue;
    const parsedValue = parseCustomValue(field, attribute[1]);
    if (!("error" in parsedValue)) nextValues[field.id] = parsedValue.value;
  }
  const weightField = fields.find(isWeightField);
  if (weightField && parsed.weight) {
    const parsedWeight = parseCustomValue(weightField, parsed.weight);
    if (!("error" in parsedWeight)) nextValues[weightField.id] = parsedWeight.value;
  }
  return nextValues;
}

async function showVoicePrompt(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  draft: TelegramDraft,
  options: { messageId?: number | null; forceNew?: boolean } = {},
) {
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId: connection.company_id,
    connection,
    screen: "voice_prompt",
    text: [
      "🎙 Продиктуйте товар",
      "",
      "Просто расскажите голосом:",
      "- что это за товар",
      "- цена",
      "- остаток",
      "- категория",
      "- важные характеристики",
      "- описание, если хотите",
      "",
      "Пример:",
      "«Кроссовки Nike Air Max, размер 42, черные, цена 5500, остаток 3, состояние новые.»",
    ].join("\n"),
    rows: [
      [
        { text: "⬅️ Назад", callback_data: "voice:back" },
        { text: "🏠 Главное меню", callback_data: "nav:menu" },
      ],
      [{ text: "❌ Отмена", callback_data: "draft:cancel" }],
    ],
    preferMessageId: options.messageId,
    forceNew: options.forceNew,
    nav: false,
  });
}

async function startVoiceWizard(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  options: { messageId?: number | null; forceNew?: boolean } = {},
) {
  const draft = await createDraft(supabase, connection.company_id, chatId, "add_voice", "wait_voice");
  console.log("telegram wizard", { action: "voice_start", step: draft.step, chatId, draftId: draft.id, mode: draft.mode });
  return showVoicePrompt(supabase, chatId, connection, draft, options);
}

async function renderVoiceStatus(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  text: string,
  options: { messageId?: number | null; forceNew?: boolean } = {},
) {
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId: connection.company_id,
    connection,
    screen: "voice_status",
    text,
    rows: [
      [
        { text: "✍️ Заполнить вручную", callback_data: "add:manual" },
        { text: "❌ Отмена", callback_data: "draft:cancel" },
      ],
      [{ text: "🏠 Главное меню", callback_data: "nav:menu" }],
    ],
    preferMessageId: options.messageId,
    forceNew: options.forceNew,
    nav: false,
  });
}

async function showVoicePreview(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft,
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  const category = draft.category_id ? await getCategory(supabase, draft.company_id, draft.category_id) : null;
  const missing = getVoiceMissingRequired(draft);
  const attributes = getVoiceAttributes(draft);
  const transcript = getVoiceTranscript(draft);
  const weight = getVoiceWeight(draft);
  const sku = missing.length === 0 ? await buildUniqueSku(supabase, (await getCompanyAndCategory(supabase, draft)).company, category as Category) : null;
  const rows: InlineButton[][] = [
    ...(missing.length === 0 && sku ? [[{ text: "✅ Сохранить", callback_data: `d:save:${sku}` }]] : []),
    [
      { text: "✏️ Исправить поле", callback_data: "voice:edit" },
      { text: "🎙 Продиктовать ещё", callback_data: "voice:again" },
    ],
    [{ text: "➡️ Заполнить недостающее вручную", callback_data: "voice:missing" }],
    [
      { text: "❌ Отмена", callback_data: "draft:cancel" },
      { text: "🏠 Главное меню", callback_data: "nav:menu" },
    ],
  ];
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId: draft.company_id,
    connection,
    screen: "voice_preview",
    text: [
      "🤖 Я распознал товар",
      "",
      "🎙 Текст:",
      `«${transcript || "не распознан"}»`,
      "",
      `📦 Название: ${draft.name?.trim() || notSpecified("male")}`,
      `🏷 Категория: ${category?.name ?? draft.custom_values?.[VOICE_CATEGORY_SUGGESTION_KEY] ?? notSpecified("female")}`,
      `💰 Цена: ${hasCompletedStep(draft, "wait_price") ? formatMoney(draft.price) : notSpecified("female")}`,
      `📦 Остаток: ${hasCompletedStep(draft, "wait_stock") ? String(Number(draft.stock) || 0) : notSpecified("male")}`,
      `⚖️ Вес: ${weight || notSpecified("male")}`,
      `📝 Описание: ${draft.description?.trim() || notSpecified()}`,
      ...voiceAttributesLines(attributes),
      ...(missing.length ? ["", "⚠️ Нужно уточнить:", ...missing.map((item) => `- ${item}`)] : []),
    ].join("\n"),
    rows,
    preferMessageId: options.messageId,
    forceNew: options.forceNew,
    nav: false,
  });
}

async function handleVoiceMessage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  draft: TelegramDraft | null,
  message: TelegramMessage,
) {
  const voice = getMessageVoiceMedia(message);
  if (!voice) return sendMessage(chatId, "Отправьте голосовое или аудио.");
  let workingDraft = draft;
  if (!workingDraft || (workingDraft.mode !== "add_voice" && workingDraft.step !== "wait_voice" && workingDraft.step !== "voice_preview")) {
    workingDraft = await createDraft(supabase, connection.company_id, chatId, "add_voice", "wait_voice");
  }

  const totalStartedAt = Date.now();
  let stage = "download";
  try {
    if (voice.fileSize && voice.fileSize > AI_VOICE_FILE_SIZE_LIMIT_BYTES) {
      throw new TelegramFileError("Voice file is too large.", "file_too_large", undefined, { file_size: voice.fileSize });
    }
    const downloadStartedAt = Date.now();
    const downloaded = await downloadTelegramVoiceFile(voice.fileId);
    console.log("telegram ai voice", { stage: "download", chatId, ms: Date.now() - downloadStartedAt, bytes: downloaded.fileSize });

    stage = "transcribe";
    const transcribeStartedAt = Date.now();
    const fileName = voice.fileName || `voice${getExtension(downloaded.filePath, ".oga")}`;
    const transcript = await transcribeAudio({ buffer: downloaded.buffer, fileName, contentType: downloaded.contentType ?? voice.contentType });
    console.log("telegram ai voice", { stage: "transcribe", chatId, ms: Date.now() - transcribeStartedAt, bytes: downloaded.fileSize });

    await renderVoiceStatus(supabase, chatId, connection, "🤖 Распознал речь. Разбираю товар...", { forceNew: true });

    const categories = await getCategories(supabase, connection.company_id);
    const currentCategory = workingDraft.category_id ? await getCategory(supabase, connection.company_id, workingDraft.category_id) : null;
    stage = "parse";
    const parseStartedAt = Date.now();
    const parsed = await parseProductVoiceTranscript(transcript, categories, buildVoiceDraftContext(workingDraft, currentCategory));
    const matchedCategory = matchVoiceCategory(categories, parsed);
    console.log("telegram ai parse", { chatId, ms: Date.now() - parseStartedAt, missingRequiredFields: parsed.missingRequiredFields });

    const customValues = await applyVoiceCustomValues(supabase, connection.company_id, workingDraft, parsed);
    customValues[VOICE_TRANSCRIPT_KEY] = transcript;
    if (parsed.categoryName && !matchedCategory) customValues[VOICE_CATEGORY_SUGGESTION_KEY] = parsed.categoryName;

    const nextDraft = await updateDraft(supabase, workingDraft, {
      step: "voice_preview",
      mode: "add_voice",
      name: parsed.title ?? workingDraft.name,
      category_id: matchedCategory?.id ?? workingDraft.category_id,
      price: parsed.price ?? workingDraft.price,
      stock: parsed.stock ?? workingDraft.stock,
      description: parsed.description ?? workingDraft.description,
      keywords: parsed.keywords.length ? parsed.keywords : workingDraft.keywords,
      custom_values: customValues,
      step_history: mergeStepHistory(workingDraft.step_history ?? [], voiceCompletedSteps(parsed, matchedCategory)),
    });
    const missing = getVoiceMissingRequired(nextDraft);
    await updateDraft(supabase, nextDraft, { custom_values: { ...(nextDraft.custom_values ?? {}), [VOICE_MISSING_KEY]: missing } });
    console.log("telegram ai voice", { stage: "total", chatId, ms: Date.now() - totalStartedAt, bytes: downloaded.fileSize });
    return showVoicePreview(supabase, chatId, { ...nextDraft, custom_values: { ...(nextDraft.custom_values ?? {}), [VOICE_MISSING_KEY]: missing } }, { connection, forceNew: true });
  } catch (error) {
    const message = error instanceof AiUnavailableError
      ? error.message
      : error instanceof TelegramFileError
        ? "Не удалось скачать голосовое. Попробуйте ещё раз."
        : stage === "parse"
          ? "Я распознал текст, но не смог разобрать товар. Можно заполнить вручную."
          : "Не удалось распознать голос. Попробуйте ещё раз или заполните вручную.";
    console.warn("telegram ai voice failed", { stage, chatId, message: getErrorMessage(error) });
    return renderVoiceStatus(supabase, chatId, connection, message, { forceNew: true });
  }
}

async function showVoiceEditMenu(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft | null,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  if (!draft) return sendMessage(chatId, "Черновик не найден.");
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId: draft.company_id,
    connection: options.connection,
    screen: "voice_edit_menu",
    text: "Что исправить?",
    rows: [
      [
        { text: "Название", callback_data: "voice:field:name" },
        { text: "Категория", callback_data: "voice:field:category" },
      ],
      [
        { text: "Цена", callback_data: "voice:field:price" },
        { text: "Остаток", callback_data: "voice:field:stock" },
      ],
      [
        { text: "Вес", callback_data: "voice:field:weight" },
        { text: "Описание", callback_data: "voice:field:description" },
      ],
      [{ text: "Характеристики", callback_data: "voice:field:attributes" }],
      [{ text: "⬅️ Назад к preview", callback_data: "voice:preview" }],
    ],
    preferMessageId: options.messageId,
    nav: false,
  });
}

async function handleVoiceFieldChoice(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  draft: TelegramDraft | null,
  field: string,
  messageId?: number | null,
) {
  if (!draft) return sendMessage(chatId, "Черновик не найден.");
  if (field === "category") {
    const nextDraft = await updateDraft(supabase, draft, { step: "choose_category", edit_field: "category" });
    return sendCategoryKeyboard(supabase, connection.company_id, chatId, "Выберите категорию товара.", { connection, messageId, draft: nextDraft });
  }
  if (field === "weight") {
    const nextDraft = await updateDraft(supabase, draft, { step: "wait_voice_weight", edit_field: "voice_weight" });
    return renderTelegramScreen({ supabase, chatId, companyId: connection.company_id, connection, screen: "voice_weight", text: "Введите вес товара.", rows: [], preferMessageId: messageId });
  }
  if (field === "attributes") {
    const nextDraft = await updateDraft(supabase, draft, { step: "wait_voice_attributes", edit_field: "voice_attributes" });
    return renderTelegramScreen({ supabase, chatId, companyId: connection.company_id, connection, screen: "voice_attributes", text: "Введите характеристики в формате:\nцвет: черный\nразмер: 42", rows: [], preferMessageId: messageId });
  }
  const stepByField: Record<string, string> = {
    name: "wait_name",
    price: "wait_price",
    stock: "wait_stock",
    description: "wait_description",
  };
  const step = stepByField[field];
  if (!step) return sendMessage(chatId, "Поле не найдено.");
  const nextDraft = await updateDraft(supabase, draft, { step, edit_field: field });
  return renderAddWizardScreen({ supabase, chatId, draft: nextDraft, connection, messageId });
}

async function fillVoiceMissingManually(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  draft: TelegramDraft | null,
  messageId?: number | null,
) {
  if (!draft) return sendMessage(chatId, "Черновик не найден.");
  const missing = getVoiceMissingRequired(draft);
  const first = missing[0];
  if (!first) return showVoicePreview(supabase, chatId, draft, { connection, messageId });
  const fieldByLabel: Record<string, string> = {
    название: "name",
    категория: "category",
    цена: "price",
    остаток: "stock",
  };
  return handleVoiceFieldChoice(supabase, chatId, connection, draft, fieldByLabel[first] ?? "name", messageId);
}

async function showStats(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  const startedAt = Date.now();
  const [
    totalResult,
    activeResult,
    draftResult,
    hiddenResult,
    noStockResult,
    apiResult,
    categoriesResult,
    telegramDraftsResult,
  ] = await Promise.all([
    supabase.from("products").select("id", { count: "exact", head: true }).eq("company_id", companyId),
    supabase.from("products").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "active"),
    supabase.from("products").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "draft"),
    supabase.from("products").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "hidden"),
    supabase.from("products").select("id", { count: "exact", head: true }).eq("company_id", companyId).lte("stock", 0),
    supabase.from("products").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("is_visible_in_api", true),
    supabase.from("categories").select("id", { count: "exact", head: true }).eq("company_id", companyId),
    supabase
      .from("telegram_product_drafts")
      .select("created_product_id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .not("created_product_id", "is", null),
  ]);
  console.log("telegram timing", { action: "stats_counts", ms: Date.now() - startedAt, chatId });
  if (totalResult.error) throw totalResult.error;
  if (activeResult.error) throw activeResult.error;
  if (draftResult.error) throw draftResult.error;
  if (hiddenResult.error) throw hiddenResult.error;
  if (noStockResult.error) throw noStockResult.error;
  if (apiResult.error) throw apiResult.error;
  if (categoriesResult.error) throw categoriesResult.error;
  if (telegramDraftsResult.error) throw telegramDraftsResult.error;
  const text = [
    `Товары: ${totalResult.count ?? 0}`,
    `Активные: ${activeResult.count ?? 0}`,
    `Черновики: ${draftResult.count ?? 0}`,
    `Скрытые: ${hiddenResult.count ?? 0}`,
    `Нет остатка: ${noStockResult.count ?? 0}`,
    `Доступны боту/API: ${apiResult.count ?? 0}`,
    `Категории: ${categoriesResult.count ?? 0}`,
    `Через Telegram: ${telegramDraftsResult.count ?? 0}`,
  ].join("\n");
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection,
    screen: "stats",
    text,
    rows: [[{ text: "🏠 Главное меню", callback_data: "nav:menu" }]],
    preferMessageId: options.messageId,
    nav: false,
    forceNew: options.forceNew,
  });
}

async function showHelp(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean } = {},
) {
  const companyId = options.connection?.company_id ?? (await getConnection(supabase, chatId))?.company_id;
  const text = "Отправьте фото, чтобы быстро добавить товар.\nИли используйте меню:\n➕ Добавить товар\n🔎 Найти товар\n📦 Последние товары\n✏️ Изменить товар\n\nКоманды:\n/menu\n/cancel\n/status";
  if (!companyId) return sendMessage(chatId, text);
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection: options.connection,
    screen: "help",
    text,
    rows: [[{ text: "🏠 Главное меню", callback_data: "nav:menu" }]],
    preferMessageId: options.messageId,
    nav: false,
    forceNew: options.forceNew,
  });
}

function isBusyDraft(draft: { step: string } | null) {
  return Boolean(draft && draft.step !== "idle" && draft.step !== "done");
}

function draftHasImportantData(draft: TelegramDraft | null) {
  if (!draft) return false;
  return Boolean(
    draft.name?.trim() ||
    draft.category_id ||
    draft.description?.trim() ||
    (draft.media ?? []).length > 0 ||
    Object.keys(draft.custom_values ?? {}).length > 0 ||
    hasCompletedStep(draft, "wait_price") ||
    hasCompletedStep(draft, "wait_stock"),
  );
}

async function showCancelConfirm(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  draft: TelegramDraft,
  options: { messageId?: number | null; forceNew?: boolean } = {},
) {
  const category = draft.category_id ? await getCategory(supabase, draft.company_id, draft.category_id) : null;
  const fields = await getCustomFields(supabase, draft.company_id);
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId: connection.company_id,
    connection,
    screen: "cancel_confirm",
    text: [
      "Удалить черновик?",
      "",
      ...draftSummaryLines(draft, category, fields),
      "",
      "Это действие нельзя отменить.",
    ].join("\n"),
    rows: [
      [
        { text: "🗑 Да, удалить", callback_data: "draft:cancel_confirm" },
        { text: "▶️ Продолжить", callback_data: "draft:resume" },
      ],
      [{ text: "🏠 Главное меню", callback_data: "nav:menu" }],
    ],
    preferMessageId: options.messageId,
    nav: false,
    forceNew: options.forceNew,
  });
}

async function showBusyMessage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  draft?: TelegramDraft | null,
  options: { messageId?: number | null; forceNew?: boolean } = {},
) {
  const fullDraft = draft ?? null;
  const category = fullDraft?.category_id ? await getCategory(supabase, fullDraft.company_id, fullDraft.category_id) : null;
  const fields = fullDraft ? await getCustomFields(supabase, fullDraft.company_id) : [];
  const rows = [
    [
      { text: "▶️ Продолжить", callback_data: "draft:resume" },
      { text: "🔄 Начать заново", callback_data: "draft:restart" },
    ],
    [{ text: "🗑 Удалить черновик", callback_data: "draft:cancel" }],
    [{ text: "🏠 Главное меню", callback_data: "nav:menu" }],
  ];
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId: connection.company_id,
    connection,
    screen: "draft_busy",
    text: [
      "У вас есть незавершённый товар",
      "",
      ...(fullDraft ? draftSummaryLines(fullDraft, category, fields) : ["Продолжите действие или начните заново."]),
    ].join("\n"),
    rows,
    preferMessageId: options.messageId,
    nav: false,
    forceNew: options.forceNew,
  });
}

async function showAddProductChoice(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  options: { messageId?: number | null; forceNew?: boolean } = {},
) {
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId: connection.company_id,
    connection,
    screen: "add_product_choice",
    text: "Как добавить товар?",
    rows: [
      [{ text: "✍️ Заполнить вручную", callback_data: "add:manual" }],
      [{ text: "🎙 Продиктовать товар", callback_data: "add:voice" }],
      [{ text: "🏠 Главное меню", callback_data: "nav:menu" }],
    ],
    preferMessageId: options.messageId,
    forceNew: options.forceNew,
    nav: false,
  });
}

async function startAddWizard(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  message?: TelegramMessage,
  options: { messageId?: number | null; forceNew?: boolean } = {},
) {
  const media = message ? getMessageMedia(message) : null;
  const draft = await createDraft(supabase, connection.company_id, chatId, "add", media ? "choose_category" : "wait_media");
  console.log("telegram wizard", { action: "start", step: draft.step, chatId, draftId: draft.id, mode: draft.mode });
  if (media) {
    try {
      const nextDraft = await uploadDraftMediaFromMessage(supabase, draft, message as TelegramMessage, "choose_category");
      if (!nextDraft) throw new Error("Медиа не найдено.");
      await sendCategoryKeyboard(supabase, connection.company_id, chatId, "Фото получил. Выберите категорию товара.", { connection, screen: "choose_category", forceNew: options.forceNew, draft: nextDraft });
    } catch (error) {
      logTelegramError("media_upload", error, { companyId: connection.company_id, chatId });
      const retryDraft = await updateDraft(supabase, draft, { step: "wait_media" });
      await renderMediaRetryScreen(supabase, chatId, connection.company_id, mediaUploadErrorMessage(error), connection, options.forceNew, retryDraft);
      return;
    }
    return;
  }
  await renderAddWizardScreen({
    supabase,
    chatId,
    draft,
    connection,
    rows: [],
    messageId: options.messageId,
    forceNew: options.forceNew,
  });
}

async function showEditFieldPrompt(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  field: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  if (field === "category") return sendCategoryKeyboard(supabase, companyId, chatId, "Выберите категорию", { connection, messageId: options.messageId, screen: "edit_category", forceNew: options.forceNew });
  if (field === "status") {
    return renderTelegramScreen({
      supabase,
      chatId,
      companyId,
      connection,
      screen: "edit_status",
      text: "Выберите статус",
      rows: [
        [
          { text: "Черновик", callback_data: `st:draft:${productId}` },
          { text: "Активен", callback_data: `st:active:${productId}` },
        ],
        [{ text: "Скрыт", callback_data: `st:hidden:${productId}` }],
      ],
      preferMessageId: options.messageId,
      forceNew: options.forceNew,
    });
  }
  if (field === "media") {
    return renderTelegramScreen({
      supabase,
      chatId,
      companyId,
      connection,
      screen: "edit_media",
      text: "Медиа",
      rows: [
        [
          { text: "Добавить фото/видео", callback_data: `med:add:${productId}` },
          { text: "Заменить все медиа", callback_data: `med:replace:${productId}` },
        ],
        [{ text: "Удалить медиа", callback_data: `med:delete:${productId}` }],
      ],
      preferMessageId: options.messageId,
      forceNew: options.forceNew,
    });
  }
  if (field === "custom") {
    const fields = await getCustomFields(supabase, companyId);
    if (fields.length === 0) return sendMessage(chatId, "Пользовательских полей нет.");
    return renderTelegramScreen({
      supabase,
      chatId,
      companyId,
      connection,
      screen: "edit_custom_fields",
      text: "Выберите поле",
      rows: fields.map((item) => [{ text: item.name, callback_data: `ecf:${item.id}:${productId}` }]),
      preferMessageId: options.messageId,
      forceNew: options.forceNew,
    });
  }
  const prompts: Record<string, string> = {
    name: "Введите новое название",
    price: "Введите цену",
    stock: "Введите остаток",
    description: "Введите описание",
  };
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection,
    screen: `edit_${field}`,
    text: prompts[field] ?? "Введите значение",
    rows: [],
    preferMessageId: options.messageId,
    forceNew: options.forceNew,
  });
}

async function askFieldValue(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  field: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  await createDraft(supabase, companyId, chatId, "edit", `edit_${field}`, { product_id: productId, edit_field: field, step_history: [`edit_menu:${productId}`] });
  return showEditFieldPrompt(supabase, chatId, companyId, productId, field, options);
}

async function handleEditText(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string, draft: TelegramDraft, text: string) {
  const connection = await getConnection(supabase, chatId);
  if (!draft.product_id || !draft.edit_field) return sendMessage(chatId, "Товар не найден.");
  const update: Record<string, unknown> = {};
  if (draft.edit_field === "name") update.name = text;
  if (draft.edit_field === "description") update.description = text;
  if (draft.edit_field === "price") {
    const price = parsePrice(text);
    if (price === null) return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "edit_price", text: "Введите цену числом.", rows: [], forceNew: true });
    update.price = price;
  }
  if (draft.edit_field === "stock") {
    const stock = parseStock(text);
    if (stock === null) return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "edit_stock", text: "Введите остаток целым числом.", rows: [], forceNew: true });
    update.stock = stock;
  }
  if (draft.edit_field.startsWith("custom:")) {
    const fieldId = draft.edit_field.slice(7);
    const field = (await getCustomFields(supabase, draft.company_id)).find((item) => item.id === fieldId);
    if (!field) return sendMessage(chatId, "Поле не найдено.");
    const parsed = parseCustomValue(field, text);
    if ("error" in parsed) return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "edit_custom", text: parsed.error ?? "Введите корректное значение.", rows: [], forceNew: true });
    await saveOneCustomValue(supabase, draft.company_id, draft.product_id, field, parsed.value);
    await clearDrafts(supabase, draft.company_id, chatId);
    await openProductCard(supabase, chatId, draft.company_id, draft.product_id, { connection: connection ?? undefined, forceNew: true });
    return;
  }
  const { error } = await supabase.from("products").update(update).eq("company_id", draft.company_id).eq("id", draft.product_id);
  if (error) throw error;
  await clearDrafts(supabase, draft.company_id, chatId);
  await openProductCard(supabase, chatId, draft.company_id, draft.product_id, { connection: connection ?? undefined, forceNew: true });
}

async function saveOneCustomValue(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  companyId: string,
  productId: string,
  field: CustomField,
  value: unknown,
) {
  const type = fieldType(field);
  const payload = {
    company_id: companyId,
    product_id: productId,
    custom_field_id: field.id,
    value_text: type === "text" || type === "select" ? String(value) : null,
    value_number: type === "number" ? Number(value) : null,
    value_boolean: type === "boolean" ? Boolean(value) : null,
    value_date: type === "date" ? String(value) : null,
  };
  const { data: existing, error: existingError } = await supabase
    .from("product_custom_values")
    .select("id")
    .eq("company_id", companyId)
    .eq("product_id", productId)
    .eq("custom_field_id", field.id)
    .maybeSingle();
  if (existingError) throw existingError;
  const result = existing
    ? await supabase.from("product_custom_values").update(payload).eq("id", existing.id).eq("company_id", companyId)
    : await supabase.from("product_custom_values").insert(payload);
  if (result.error) throw result.error;
}

async function handleAddDraftText(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string, draft: TelegramDraft, text: string) {
  const connection = await getConnection(supabase, chatId);
  console.log("telegram wizard", { action: "text", step: draft.step, chatId, draftId: draft.id, mode: draft.mode });
  const showEditedPreview = (nextDraft: TelegramDraft) => draft.mode === "add_voice"
    ? showVoicePreview(supabase, chatId, nextDraft, { connection, forceNew: true })
    : showAddPreview(supabase, chatId, nextDraft, { connection, forceNew: true });

  if ((draft.mode === "add" || draft.mode === "add_voice") && draft.edit_field && ["name", "price", "stock", "description"].includes(draft.edit_field)) {
    if (draft.edit_field === "name") {
      if (!text.trim()) return renderAddWizardScreen({ supabase, chatId, draft, connection, forceNew: true, error: "Название не может быть пустым. Введите название ещё раз." });
      const nextDraft = await updateDraft(supabase, draft, { name: text.trim(), step: draft.mode === "add_voice" ? "voice_preview" : "preview", edit_field: null });
      return showEditedPreview(nextDraft);
    }
    if (draft.edit_field === "price") {
      const price = parsePrice(text);
      if (price === null) return renderAddWizardScreen({ supabase, chatId, draft, connection, forceNew: true, error: "Цена должна быть числом. Введите цену ещё раз." });
      const nextDraft = await updateDraft(supabase, draft, { price, step: draft.mode === "add_voice" ? "voice_preview" : "preview", edit_field: null });
      return showEditedPreview(nextDraft);
    }
    if (draft.edit_field === "stock") {
      const stock = parseStock(text);
      if (stock === null) return renderAddWizardScreen({ supabase, chatId, draft, connection, forceNew: true, error: "Остаток должен быть целым числом. Введите остаток ещё раз." });
      const nextDraft = await updateDraft(supabase, draft, { stock, step: draft.mode === "add_voice" ? "voice_preview" : "preview", edit_field: null });
      return showEditedPreview(nextDraft);
    }
    if (draft.edit_field === "description") {
      const nextDraft = await updateDraft(supabase, draft, { description: text.trim() || null, step: draft.mode === "add_voice" ? "voice_preview" : "preview", edit_field: null });
      return showEditedPreview(nextDraft);
    }
  }

  if (draft.step === "wait_voice_weight") {
    const nextDraft = await updateDraft(supabase, draft, {
      step: "voice_preview",
      edit_field: null,
      custom_values: {
        ...(draft.custom_values ?? {}),
        [VOICE_WEIGHT_KEY]: text.trim(),
        [VOICE_ATTRIBUTES_KEY]: { ...getVoiceAttributes(draft), вес: text.trim() },
      },
    });
    return showVoicePreview(supabase, chatId, nextDraft, { connection, forceNew: true });
  }

  if (draft.step === "wait_voice_attributes") {
    const attributes = parseAttributesText(text);
    const nextDraft = await updateDraft(supabase, draft, {
      step: "voice_preview",
      edit_field: null,
      custom_values: {
        ...(draft.custom_values ?? {}),
        [VOICE_ATTRIBUTES_KEY]: { ...getVoiceAttributes(draft), ...attributes },
      },
    });
    return showVoicePreview(supabase, chatId, nextDraft, { connection, forceNew: true });
  }

  if (draft.step === "wait_name") {
    if (!text.trim()) return renderAddWizardScreen({ supabase, chatId, draft, connection, forceNew: true, error: "Название не может быть пустым. Введите название ещё раз." });
    const nextDraft = await updateDraft(supabase, draft, { name: text.trim(), step: "wait_price" });
    return renderAddWizardScreen({ supabase, chatId, draft: nextDraft, connection, forceNew: true });
  }
  if (draft.step === "wait_price") {
    const price = parsePrice(text);
    if (price === null) return renderAddWizardScreen({ supabase, chatId, draft, connection, forceNew: true, error: "Цена должна быть числом. Введите цену ещё раз." });
    const nextDraft = await updateDraft(supabase, draft, { price, step: "wait_stock" });
    return renderAddWizardScreen({ supabase, chatId, draft: nextDraft, connection, forceNew: true });
  }
  if (draft.step === "wait_stock") {
    const stock = parseStock(text);
    if (stock === null) return renderAddWizardScreen({ supabase, chatId, draft, connection, forceNew: true, error: "Остаток должен быть целым числом. Введите остаток ещё раз." });
    const nextDraft = await updateDraft(supabase, draft, { stock, step: "wait_description" });
    return renderAddWizardScreen({ supabase, chatId, draft: nextDraft, connection, forceNew: true });
  }
  if (draft.step === "wait_description") {
    const nextDraft = await updateDraft(supabase, draft, { description: text.trim() || null });
    return askNextCustomField(supabase, chatId, nextDraft, { connection, forceNew: true });
  }
  if (draft.step === "custom_fields" && draft.edit_field) {
    const field = (await getCustomFields(supabase, draft.company_id)).find((item) => item.id === draft.edit_field);
    if (!field) return sendMessage(chatId, "Поле не найдено.");
    const parsed = parseCustomValue(field, text);
    if ("error" in parsed) return renderAddWizardScreen({ supabase, chatId, draft, connection, forceNew: true, error: parsed.error ?? "Введите корректное значение." });
    const nextDraft = await updateDraft(supabase, draft, {
      custom_values: { ...(draft.custom_values ?? {}), [field.id]: parsed.value },
    });
    return askNextCustomField(supabase, chatId, nextDraft, { connection, forceNew: true });
  }
  if (draft.step === "wait_find" || draft.step === "wait_edit_search") {
    const products = await findProducts(supabase, draft.company_id, text);
    await clearDrafts(supabase, draft.company_id, chatId);
    if (draft.step === "wait_edit_search" && products.length === 1) return startEditProduct(supabase, chatId, draft.company_id, products[0].id, { forceNew: true });
    return sendProductList(supabase, chatId, products, { connection, forceNew: true, source: "search" });
  }
  await renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: draft.step, text: "Нажмите кнопку под сообщением.", rows: [], forceNew: true });
}

async function handleDraftMedia(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string, draft: TelegramDraft, message: TelegramMessage) {
  if (draft.mode === "edit" && draft.product_id && (draft.step === "edit_media_add" || draft.step === "edit_media_replace")) {
    const product = await getProduct(supabase, draft.company_id, draft.product_id);
    if (!product) return sendMessage(chatId, "Товар не найден.");
    const media = getMessageMedia(message);
    if (!media) return sendMessage(chatId, "Отправьте фото или видео.");
    const connection = await getConnection(supabase, chatId);
    try {
      if (draft.step === "edit_media_replace") {
        await supabase.from("product_media").delete().eq("company_id", draft.company_id).eq("product_id", draft.product_id);
      }
      const countResult = await supabase.from("product_media").select("id").eq("company_id", draft.company_id).eq("product_id", draft.product_id);
      const index = (countResult.data?.length ?? 0) + 1;
      const ext = media.mediaType === "photo" ? ".jpg" : ".mp4";
      const item = await uploadTelegramMedia(supabase, draft.company_id, product.id, media.fileId, media.mediaType, `${product.sku}-${index}${ext}`);
      const { error } = await supabase.from("product_media").insert({
        company_id: draft.company_id,
        product_id: product.id,
        media_type: item.media_type,
        original_url: item.public_url,
        processed_url: item.public_url,
        thumbnail_url: item.media_type === "photo" ? item.public_url : null,
        file_name: item.file_name,
        file_size_bytes: item.file_size_bytes,
        status: "ready",
        sort_order: index - 1,
      });
      if (error) throw error;
      await clearDrafts(supabase, draft.company_id, chatId);
      return openProductCard(supabase, chatId, draft.company_id, product.id, { connection: connection ?? undefined, forceNew: true });
    } catch (error) {
      return renderMediaRetryScreen(supabase, chatId, draft.company_id, mediaUploadErrorMessage(error), connection, true);
    }
  }
  if (draft.mode === "add" && (draft.step === "wait_media" || draft.step === "choose_category")) {
    const nextStep = draft.step === "wait_media" ? "choose_category" : "choose_category";
    const connection = await getConnection(supabase, chatId);
    try {
      const nextDraft = await uploadDraftMediaFromMessage(supabase, draft, message, nextStep);
      if (!nextDraft) return sendMessage(chatId, "Отправьте фото или видео.");
      if (draft.edit_field === "media") {
        const previewDraft = await updateDraft(supabase, nextDraft, { step: "preview", edit_field: null });
        return showAddPreview(supabase, chatId, previewDraft, { connection, forceNew: true });
      }
      return sendCategoryKeyboard(supabase, draft.company_id, chatId, "Фото получил. Выберите категорию товара.", { connection, forceNew: true, draft: nextDraft });
    } catch (error) {
      const retryDraft = await updateDraft(supabase, draft, { step: "wait_media" });
      return renderMediaRetryScreen(supabase, chatId, draft.company_id, mediaUploadErrorMessage(error), connection, true, retryDraft);
    }
  }
  await sendMessage(chatId, "Сейчас ожидаю текст или кнопку.");
}

async function handleMenuAction(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  action: string,
  messageId?: number,
  forceNew?: boolean,
) {
  if (action === "menu") return showMainMenu(supabase, chatId, connection, { messageId, forceNew });
  if (action === "help") return showHelp(supabase, chatId, { connection, messageId, forceNew });

  const activeDraft = await getActiveDraft(supabase, connection.company_id, chatId);
  if (isBusyDraft(activeDraft)) return showBusyMessage(supabase, chatId, connection, activeDraft, { messageId, forceNew });
  if (action === "add_product" || action === "add") return showAddProductChoice(supabase, chatId, connection, { messageId, forceNew });
  if (action === "find_product" || action === "find") {
    await createDraft(supabase, connection.company_id, chatId, "find", "wait_find");
    return renderTelegramScreen({ supabase, chatId, companyId: connection.company_id, connection, screen: "search_prompt", text: "Введите название, SKU или ключевое слово.", rows: [], preferMessageId: messageId, forceNew });
  }
  if (action === "edit_product" || action === "edit") {
    await createDraft(supabase, connection.company_id, chatId, "edit_search", "wait_edit_search");
    return renderTelegramScreen({ supabase, chatId, companyId: connection.company_id, connection, screen: "edit_search_prompt", text: "Введите SKU или название товара.", rows: [], preferMessageId: messageId, forceNew });
  }
  if (action === "latest_products") {
    return showLatestProductsScreen(supabase, chatId, connection, { messageId, forceNew });
  }
  if (action === "stats") return showStats(supabase, chatId, connection.company_id, { connection, messageId, forceNew });
}

async function showDraftNavigationMenu(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  messageId?: number,
) {
  return showMainMenu(supabase, chatId, connection, { messageId });
}

async function restartDraft(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string, connection: TelegramConnection, draft: TelegramDraft | null) {
  const mode = draft?.mode;
  const productId = draft?.product_id;
  await clearDrafts(supabase, connection.company_id, chatId);
  if (mode === "find") {
    await createDraft(supabase, connection.company_id, chatId, "find", "wait_find");
    return renderTelegramScreen({ supabase, chatId, companyId: connection.company_id, connection, screen: "search_prompt", text: "Введите название, SKU или ключевое слово.", rows: [] });
  }
  if (mode === "edit_search") {
    await createDraft(supabase, connection.company_id, chatId, "edit_search", "wait_edit_search");
    return renderTelegramScreen({ supabase, chatId, companyId: connection.company_id, connection, screen: "edit_search_prompt", text: "Введите SKU или название товара.", rows: [] });
  }
  if (mode === "add_voice") return startVoiceWizard(supabase, chatId, connection);
  if (mode === "edit" && productId) return startEditProduct(supabase, chatId, connection.company_id, productId);
  return startAddWizard(supabase, chatId, connection);
}

async function showLatestProductsScreen(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  options: { messageId?: number | null; forceNew?: boolean } = {},
) {
  const { data, error } = await supabase
    .from("products")
    .select("id, company_id, sku, name, price, stock, status, is_visible_in_api, updated_at")
    .eq("company_id", connection.company_id)
    .order("updated_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  return sendProductList(supabase, chatId, ((data ?? []) as Product[]) ?? [], {
    connection,
    messageId: options.messageId,
    forceNew: options.forceNew,
    source: "latest",
  });
}

async function showExpiredSearchFallback(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  messageId?: number | null,
) {
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId: connection.company_id,
    connection,
    screen: "main_menu",
    text: "Результаты поиска устарели.\n\nГлавное меню",
    rows: mainMenuRows(),
    preferMessageId: messageId,
    nav: false,
  });
}

async function handleProductBack(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  productId: string,
  source: ProductListSource,
  messageId?: number | null,
) {
  const fromScreen = "product_card";
  if (source === "search") {
    const cached = getSearchResultsCache(chatId, connection.company_id);
    console.log("telegram nav back", { chatId, context: "product", fromScreen, toScreen: cached ? "search_results" : "main_menu", productId });
    if (cached) return sendProductList(supabase, chatId, cached, { connection, messageId, source: "search" });
    console.warn("telegram nav back fallback", { chatId, reason: "search_results_expired", action: "p:b" });
    return showExpiredSearchFallback(supabase, chatId, connection, messageId);
  }

  if (source === "latest") {
    console.log("telegram nav back", { chatId, context: "product", fromScreen, toScreen: "latest_products", productId });
    return showLatestProductsScreen(supabase, chatId, connection, { messageId });
  }

  console.warn("telegram nav back fallback", { chatId, reason: "unknown_product_source", action: "p:b" });
  console.log("telegram nav back", { chatId, context: "product", fromScreen, toScreen: "main_menu", productId });
  return showMainMenu(supabase, chatId, connection, { messageId });
}

async function handleProductApiBack(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  productId: string,
  source: ProductListSource,
  messageId?: number | null,
) {
  console.log("telegram nav back", { chatId, context: "product_api", fromScreen: "product_api", toScreen: "product_card", productId });
  return openProductCard(supabase, chatId, connection.company_id, productId, { connection, messageId, source });
}

function parseStepHistoryEntry(entry: string) {
  const separatorIndex = entry.indexOf(":");
  if (separatorIndex === -1) return { step: entry, editField: null as string | null };
  return {
    step: entry.slice(0, separatorIndex),
    editField: entry.slice(separatorIndex + 1) || null,
  };
}

function fallbackWizardBackTarget(draft: TelegramDraft) {
  if (draft.mode === "add") {
    const previousStepByStep: Record<string, string> = {
      choose_category: "wait_media",
      wait_name: "choose_category",
      wait_price: "wait_name",
      wait_stock: "wait_price",
      wait_description: "wait_stock",
      custom_fields: "wait_description",
      preview: "wait_description",
    };
    const step = previousStepByStep[draft.step];
    return step ? { step, editField: null as string | null } : null;
  }

  if (draft.mode === "find" || draft.mode === "edit_search") return null;
  if (draft.mode === "edit" && draft.product_id) {
    if (draft.step === "edit_menu") return { step: `product:${draft.product_id}`, editField: null as string | null };
    if (draft.step.startsWith("edit_")) return { step: "edit_menu", editField: null as string | null };
  }

  return null;
}

async function renderBackTarget(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  if (draft.mode === "add") {
    if (draft.step === "choose_category") {
      return sendCategoryKeyboard(supabase, draft.company_id, chatId, "Выберите категорию товара.", { connection, messageId: options.messageId, draft });
    }
    if (["wait_media", "wait_name", "wait_price", "wait_stock", "wait_description"].includes(draft.step)) {
      return renderAddWizardScreen({ supabase, chatId, draft, connection, messageId: options.messageId });
    }
    if (draft.step === "custom_fields" && draft.edit_field) {
      const field = (await getCustomFields(supabase, draft.company_id)).find((item) => item.id === draft.edit_field);
      if (field) return renderCustomFieldScreen(supabase, chatId, draft, field, { connection, messageId: options.messageId });
    }
    if (draft.step === "preview") return showAddPreview(supabase, chatId, draft, { connection, messageId: options.messageId });
  }

  return resumeDraft(supabase, chatId, draft, { connection, messageId: options.messageId });
}

async function handleWizardBack(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft | null,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  if (!draft) {
    console.warn("telegram wizard back ignored", { chatId, currentStep: null, reason: "no_draft" });
    return;
  }

  const history = Array.isArray(draft.step_history) ? draft.step_history : [];
  const historyPrevious = history.at(-1);
  const fallbackPrevious = historyPrevious ? null : fallbackWizardBackTarget(draft);
  let previous = historyPrevious ? parseStepHistoryEntry(historyPrevious) : fallbackPrevious;
  if (previous?.step === "custom_fields" && !previous.editField) {
    previous = { step: "wait_description", editField: null };
  }
  if (!previous) {
    console.warn("telegram wizard back ignored", { chatId, draftId: draft.id, currentStep: draft.step, reason: "first_step" });
    return connection ? showMainMenu(supabase, chatId, connection, { messageId: options.messageId }) : resumeDraft(supabase, chatId, draft, options);
  }

  const stepHistory = historyPrevious ? history.slice(0, -1) : history;
  const { step, editField } = previous;
  console.log("telegram wizard back", {
    chatId,
    draftId: draft.id,
    fromStep: draft.step,
    toStep: step,
    historyLength: stepHistory.length,
  });

  if (step.startsWith("product:")) {
    const productId = step.slice("product:".length);
    await updateDraft(supabase, { ...draft, step_history: stepHistory } as TelegramDraft, {
      step: "edit_menu",
      edit_field: null,
      step_history: stepHistory,
    });
    return openProductCard(supabase, chatId, draft.company_id, productId, { connection: connection ?? undefined, messageId: options.messageId });
  }
  if (step === "edit_menu" && draft.product_id) {
    await updateDraft(supabase, { ...draft, step_history: stepHistory } as TelegramDraft, {
      step: "edit_menu",
      edit_field: null,
      step_history: stepHistory,
    });
    return sendEditProductMenu(supabase, chatId, draft.company_id, draft.product_id, options);
  }
  const nextDraft = await updateDraft(supabase, { ...draft, step_history: stepHistory } as TelegramDraft, {
    step,
    edit_field: editField,
    step_history: stepHistory,
  });
  return renderBackTarget(supabase, chatId, nextDraft, { connection, messageId: options.messageId });
}

async function handleCallback(supabase: ReturnType<typeof getSupabaseAdmin>, callback: TelegramCallbackQuery, callbackAnswered = false) {
  const startedAt = Date.now();
  const chatId = callback.message?.chat.id ? String(callback.message.chat.id) : "";
  const data = callback.data ?? "";
  if (!chatId) return answerCallbackQuery(callback.id, "Чат не найден.");
  if (!callbackAnswered) {
    await answerCallbackQuery(callback.id, undefined, chatId);
    callbackAnswered = true;
    logTiming("answer_callback", startedAt, chatId);
  }
  const callbackIdForAction = callbackAnswered ? undefined : callback.id;
  const getConnectionStartedAt = Date.now();
  const connection = await getConnection(supabase, chatId);
  logTiming("get connection", getConnectionStartedAt, chatId);
  if (!connection) return sendMessage(chatId, NOT_CONNECTED);

  if (data === "nav:menu") return showDraftNavigationMenu(supabase, chatId, connection, callback.message?.message_id);

  if (data.startsWith("menu:") || data.startsWith("m:")) {
    const actionMap: Record<string, string> = {
      add: "add_product",
      find: "find_product",
      last: "latest_products",
      edit: "edit_product",
    };
    const rawAction = data.includes(":") ? data.split(":")[1] : "menu";
    const action = actionMap[rawAction] ?? rawAction;

    if (action === "menu") {
      const responseStartedAt = Date.now();
      await showMainMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
      logTiming("telegram response", responseStartedAt, chatId);
      logTiming("handle action menu", startedAt, chatId);
      return;
    }

    const actionStartedAt = Date.now();
    await handleMenuAction(supabase, chatId, connection, action, callback.message?.message_id);
    logTiming(`handle action ${action}`, actionStartedAt, chatId);
    return;
  }

  if (data === "add:manual") {
    return startAddWizard(supabase, chatId, connection, undefined, { messageId: callback.message?.message_id });
  }
  if (data === "add:voice") {
    return startVoiceWizard(supabase, chatId, connection, { messageId: callback.message?.message_id });
  }

  if (data.startsWith("p:o:")) {
    const [, , productId, sourceCode] = data.split(":");
    await clearDrafts(supabase, connection.company_id, chatId);
    return openProductCard(supabase, chatId, connection.company_id, productId, {
      connection,
      messageId: callback.message?.message_id,
      source: codeToSource(sourceCode),
    });
  }
  if (data.startsWith("p:b:")) {
    const [, , productId, sourceCode] = data.split(":");
    return handleProductBack(supabase, chatId, connection, productId, codeToSource(sourceCode), callback.message?.message_id);
  }
  if (data.startsWith("p:api:back:")) {
    const [, , , productId, sourceCode] = data.split(":");
    return handleProductApiBack(supabase, chatId, connection, productId, codeToSource(sourceCode), callback.message?.message_id);
  }
  if (data.startsWith("p:api:")) {
    const [, , apiAction, productId, sourceCode] = data.split(":");
    if (!productId) return sendMessage(chatId, "Товар не найден.");
    if (apiAction === "activate" || apiAction === "activate_enable" || apiAction === "enable" || apiAction === "disable") {
      return updateProductApiAccess(supabase, chatId, connection.company_id, productId, apiAction, {
        connection,
        messageId: callback.message?.message_id,
        source: codeToSource(sourceCode),
      });
    }
    return sendMessage(chatId, "Действие API не найдено.");
  }
  if (data.startsWith("p:ai:")) {
    const [, , aiAction, a, b, c] = data.split(":");
    if (aiAction === "screen" || aiAction === "s") {
      return showProductAiScreen(supabase, chatId, connection.company_id, a, {
        connection,
        messageId: callback.message?.message_id,
        source: codeToSource(b),
      });
    }
    if (aiAction === "back") {
      return openProductCard(supabase, chatId, connection.company_id, a, {
        connection,
        messageId: callback.message?.message_id,
        source: codeToSource(b),
      });
    }
    if (aiAction === "r") {
      const action = codeToAiAction(a);
      if (!action) return sendMessage(chatId, "AI-действие не найдено.");
      return runProductAiAction(supabase, chatId, connection.company_id, b, action, {
        connection,
        messageId: callback.message?.message_id,
        source: codeToSource(c),
      });
    }
    if (aiAction === "ap") {
      return applyProductAiResult(supabase, chatId, a, { connection, messageId: callback.message?.message_id });
    }
    if (aiAction === "rg") {
      const item = getProductAiCache(a, chatId);
      if (!item) return showMainMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
      return runProductAiAction(supabase, chatId, item.companyId, item.productId, item.action, {
        connection,
        messageId: callback.message?.message_id,
        source: item.source,
      });
    }
    return sendMessage(chatId, "AI-действие не найдено.");
  }
  if (data.startsWith("p:a:")) {
    const [, , productId, sourceCode] = data.split(":");
    return toggleApi(supabase, chatId, connection.company_id, productId, {
      connection,
      messageId: callback.message?.message_id,
      callbackId: callbackIdForAction,
      source: codeToSource(sourceCode),
    });
  }
  if (data === "search:back") {
    console.log("telegram nav back", { chatId, context: "search", fromScreen: "search_results", toScreen: "search_prompt" });
    await createDraft(supabase, connection.company_id, chatId, "find", "wait_find");
    return renderTelegramScreen({
      supabase,
      chatId,
      companyId: connection.company_id,
      connection,
      screen: "search_prompt",
      text: "Введите название, SKU или ключевое слово.",
      rows: [],
      preferMessageId: callback.message?.message_id,
    });
  }

  const draft = await getActiveDraft(supabase, connection.company_id, chatId);
  if (data === "voice:back") return showAddProductChoice(supabase, chatId, connection, { messageId: callback.message?.message_id });
  if (data === "voice:again") {
    if (!draft) return startVoiceWizard(supabase, chatId, connection, { messageId: callback.message?.message_id });
    const nextDraft = await updateDraft(supabase, draft, { step: "wait_voice", edit_field: null });
    return showVoicePrompt(supabase, chatId, connection, nextDraft, { messageId: callback.message?.message_id });
  }
  if (data === "voice:preview") {
    return draft ? showVoicePreview(supabase, chatId, draft, { connection, messageId: callback.message?.message_id }) : showAddProductChoice(supabase, chatId, connection, { messageId: callback.message?.message_id });
  }
  if (data === "voice:edit") return showVoiceEditMenu(supabase, chatId, draft, { connection, messageId: callback.message?.message_id });
  if (data === "voice:missing") return fillVoiceMissingManually(supabase, chatId, connection, draft, callback.message?.message_id);
  if (data.startsWith("voice:field:")) {
    return handleVoiceFieldChoice(supabase, chatId, connection, draft, data.slice("voice:field:".length), callback.message?.message_id);
  }
  if (data === "wizard:back") return handleWizardBack(supabase, chatId, draft, { connection, messageId: callback.message?.message_id });
  if (data === "nav:back") {
    if (draft) return handleWizardBack(supabase, chatId, draft, { connection, messageId: callback.message?.message_id });
    console.warn("telegram nav back fallback", { chatId, reason: "legacy_nav_back_without_draft", action: "nav:back" });
    return;
  }
  if (data === "draft:resume") return draft ? resumeDraft(supabase, chatId, draft, { connection, messageId: callback.message?.message_id }) : showMainMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  if (data === "draft:restart") return restartDraft(supabase, chatId, connection, draft);
  if (data === "draft:cancel") {
    if (draftHasImportantData(draft)) return showCancelConfirm(supabase, chatId, connection, draft as TelegramDraft, { messageId: callback.message?.message_id });
    await clearDrafts(supabase, connection.company_id, chatId);
    if (callbackIdForAction) await answerCallbackQuery(callbackIdForAction, "Действие отменено", chatId);
    return showCancelledMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  }
  if (data === "draft:cancel_confirm") {
    await clearDrafts(supabase, connection.company_id, chatId);
    if (callbackIdForAction) await answerCallbackQuery(callbackIdForAction, "Действие отменено", chatId);
    return showCancelledMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  }
  if (data === "busy:cont") return draft ? resumeDraft(supabase, chatId, draft, { connection, messageId: callback.message?.message_id }) : showMainMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  if (data === "busy:new") {
    await clearDrafts(supabase, connection.company_id, chatId);
    if (callbackIdForAction) await answerCallbackQuery(callbackIdForAction, "Начните заново", chatId);
    return showMainMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  }
  if (data === "busy:menu") return showMainMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  if (data === "media:skip") {
    if (!draft) return sendMessage(chatId, "Черновик не найден.");
    if (draft.edit_field === "media") {
      const previewDraft = await updateDraft(supabase, draft, { step: "preview", edit_field: null });
      return showAddPreview(supabase, chatId, previewDraft, { connection, messageId: callback.message?.message_id });
    }
    const nextDraft = await updateDraft(supabase, draft, { step: "choose_category" });
    return sendCategoryKeyboard(supabase, connection.company_id, chatId, "Выберите категорию товара.", { connection, messageId: callback.message?.message_id, draft: nextDraft });
  }
  if (data.startsWith("cat:")) {
    if (!draft) return sendMessage(chatId, "Черновик не найден.");
    const categoryId = data.slice(4);
    const category = await getCategory(supabase, connection.company_id, categoryId);
    if (!category) return sendMessage(chatId, "Категория не найдена.");
    if (draft.mode === "edit" && draft.product_id) {
      const { error } = await supabase.from("products").update({ category_id: categoryId }).eq("company_id", connection.company_id).eq("id", draft.product_id);
      if (error) throw error;
      await clearDrafts(supabase, connection.company_id, chatId);
      if (callbackIdForAction) await answerCallbackQuery(callbackIdForAction, "Сохранено", chatId);
      return openProductCard(supabase, chatId, connection.company_id, draft.product_id, { connection, messageId: callback.message?.message_id });
    }
    const nextDraft = await updateDraft(supabase, draft, { category_id: categoryId, step: draft.edit_field === "category" ? (draft.mode === "add_voice" ? "voice_preview" : "preview") : "wait_name", ...(draft.edit_field === "category" ? { edit_field: null } : {}) });
    if (draft.edit_field === "category" || nextDraft.name) {
      if (draft.mode === "add_voice") {
        const previewDraft = nextDraft.step === "voice_preview" ? nextDraft : await updateDraft(supabase, nextDraft, { step: "voice_preview" });
        return showVoicePreview(supabase, chatId, previewDraft, { connection, messageId: callback.message?.message_id });
      }
      const previewDraft = nextDraft.step === "preview" ? nextDraft : await updateDraft(supabase, nextDraft, { step: "preview" });
      return showAddPreview(supabase, chatId, previewDraft, { connection, messageId: callback.message?.message_id });
    }
    return renderAddWizardScreen({ supabase, chatId, draft: nextDraft, connection, messageId: callback.message?.message_id });
  }
  if (data === "desc:skip") {
    if (!draft) return sendMessage(chatId, "Черновик не найден.");
    const nextDraft = await updateDraft(supabase, draft, { description: null, ...(draft.edit_field === "description" ? { step: "preview", edit_field: null } : {}) });
    if (draft.edit_field === "description") {
      if (draft.mode === "add_voice") {
        const previewDraft = nextDraft.step === "voice_preview" ? nextDraft : await updateDraft(supabase, nextDraft, { step: "voice_preview" });
        return showVoicePreview(supabase, chatId, previewDraft, { connection, messageId: callback.message?.message_id });
      }
      return showAddPreview(supabase, chatId, nextDraft, { connection, messageId: callback.message?.message_id });
    }
    if (draft.mode === "add") return askNextCustomField(supabase, chatId, nextDraft, { connection, messageId: callback.message?.message_id });
    const previewDraft = await updateDraft(supabase, draft, { step: "preview" });
    return showAddPreview(supabase, chatId, previewDraft, { connection, messageId: callback.message?.message_id });
  }
  if (data.startsWith("cfb:") || data.startsWith("cfo:") || data.startsWith("cfs:")) return handleCustomCallback(supabase, chatId, data, draft, { connection, messageId: callback.message?.message_id });
  if (data.startsWith("d:save:")) {
    if (!draft) return sendMessage(chatId, "Черновик не найден.");
    const result = await saveDraftAsProduct(supabase, draft, data.slice(7));
    if (callbackIdForAction) await answerCallbackQuery(callbackIdForAction, `Товар сохранён как черновик: ${result.sku}`, chatId);
    return showMainMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  }
  if (data === "d:cancel") {
    if (draftHasImportantData(draft)) return showCancelConfirm(supabase, chatId, connection, draft as TelegramDraft, { messageId: callback.message?.message_id });
    await clearDrafts(supabase, connection.company_id, chatId);
    if (callbackIdForAction) await answerCallbackQuery(callbackIdForAction, "Действие отменено", chatId);
    return showCancelledMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  }
  if (data === "d:edit") return sendDraftEditMenu(supabase, chatId, draft, { connection, messageId: callback.message?.message_id });
  if (data.startsWith("de:")) return handleDraftEditChoice(supabase, chatId, connection.company_id, draft, data.slice(3), { connection, messageId: callback.message?.message_id });
  if (data.startsWith("p:e:")) return startEditProduct(supabase, chatId, connection.company_id, data.slice(4), { connection, messageId: callback.message?.message_id });
  if (data.startsWith("p:v:")) return toggleVisibility(supabase, chatId, connection.company_id, data.slice(4), { connection, messageId: callback.message?.message_id, callbackId: callbackIdForAction });
  if (data.startsWith("efp:")) {
    const [, field, productId] = data.split(":");
    return askFieldValue(supabase, chatId, connection.company_id, productId, field, { connection, messageId: callback.message?.message_id });
  }
  if (data.startsWith("st:")) return updateProductStatus(supabase, chatId, connection.company_id, data, { connection, messageId: callback.message?.message_id, callbackId: callbackIdForAction });
  if (data.startsWith("med:")) return handleMediaCallback(supabase, chatId, connection.company_id, data, { connection, messageId: callback.message?.message_id, callbackId: callbackIdForAction });
  if (data.startsWith("ecf:")) return handleEditCustomFieldChoice(supabase, chatId, connection.company_id, data, { connection, messageId: callback.message?.message_id });
  if (data.startsWith("ecfb:") || data.startsWith("ecfo:")) return handleEditCustomCallback(supabase, chatId, connection.company_id, data, { connection, messageId: callback.message?.message_id, callbackId: callbackIdForAction });
}

async function resumeDraft(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  if (draft.mode === "add_voice" && draft.step === "wait_voice") {
    return connection ? showVoicePrompt(supabase, chatId, connection, draft, { messageId: options.messageId }) : renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "voice_prompt", text: "Продиктуйте товар голосом.", rows: [], preferMessageId: options.messageId });
  }
  if (draft.mode === "add_voice" && (draft.step === "voice_preview" || draft.step === "preview")) return showVoicePreview(supabase, chatId, draft, { connection, messageId: options.messageId });
  if (draft.mode === "add_voice" && (draft.step === "wait_voice_weight" || draft.step === "wait_voice_attributes")) {
    return renderTelegramScreen({
      supabase,
      chatId,
      companyId: draft.company_id,
      connection,
      screen: draft.step,
      text: draft.step === "wait_voice_weight" ? "Введите вес товара." : "Введите характеристики в формате:\nцвет: черный\nразмер: 42",
      rows: [],
      preferMessageId: options.messageId,
    });
  }
  if (draft.mode === "add" && ["wait_media", "wait_name", "wait_price", "wait_stock", "wait_description"].includes(draft.step)) {
    return renderAddWizardScreen({ supabase, chatId, draft, connection, messageId: options.messageId });
  }
  if (draft.step === "choose_category") return sendCategoryKeyboard(supabase, draft.company_id, chatId, "Выберите категорию товара.", { connection, messageId: options.messageId, draft });
  if (draft.step === "wait_find") return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "search_prompt", text: "Введите название, SKU или ключевое слово.", rows: [], preferMessageId: options.messageId });
  if (draft.step === "wait_edit_search") return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "edit_search_prompt", text: "Введите SKU или название товара.", rows: [], preferMessageId: options.messageId });
  if (draft.step === "custom_fields") return askNextCustomField(supabase, chatId, draft, { connection, messageId: options.messageId });
  if (draft.step === "edit_menu" && draft.product_id) return sendEditProductMenu(supabase, chatId, draft.company_id, draft.product_id, { connection, messageId: options.messageId });
  if (draft.mode === "edit" && draft.product_id && draft.step.startsWith("edit_")) {
    const field = draft.edit_field ?? draft.step.slice(5);
    return showEditFieldPrompt(supabase, chatId, draft.company_id, draft.product_id, field, { connection, messageId: options.messageId });
  }
  if (draft.step === "preview") return showAddPreview(supabase, chatId, draft, { connection, messageId: options.messageId });
  return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: draft.step, text: "Продолжайте текущий шаг.", rows: [], preferMessageId: options.messageId });
}

async function sendDraftEditMenu(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft | null,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  if (!draft) return sendMessage(chatId, "Черновик не найден.");
  const [category, fields] = await Promise.all([
    draft.category_id ? getCategory(supabase, draft.company_id, draft.category_id) : Promise.resolve(null),
    getCustomFields(supabase, draft.company_id),
  ]);
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId: draft.company_id,
    connection: options.connection,
    screen: "draft_edit_menu",
    text: [
      "Что изменить?",
      "",
      ...draftSummaryLines(draft, category, fields),
    ].join("\n"),
    rows: [
    [
      { text: "📦 Название", callback_data: "de:name" },
      { text: "🏷 Категория", callback_data: "de:category" },
    ],
    [
      { text: "💰 Цена", callback_data: "de:price" },
      { text: "📦 Остаток", callback_data: "de:stock" },
    ],
    [
      { text: "📝 Описание", callback_data: "de:description" },
      { text: "🖼 Фото/видео", callback_data: "de:media" },
    ],
    ],
    preferMessageId: options.messageId,
  });
}

async function handleDraftEditChoice(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  draft: TelegramDraft | null,
  field: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  if (!draft) return sendMessage(chatId, "Черновик не найден.");
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  if (field === "category") {
    const nextDraft = await updateDraft(supabase, draft, { step: "choose_category", edit_field: "category" });
    return sendCategoryKeyboard(supabase, companyId, chatId, "Выберите категорию товара.", { connection, messageId: options.messageId, draft: nextDraft });
  }
  if (field === "media") {
    const nextDraft = await updateDraft(supabase, draft, { step: "wait_media", media: [], edit_field: "media" });
    return renderAddWizardScreen({ supabase, chatId, draft: nextDraft, connection, messageId: options.messageId });
  }
  const nextDraft = await updateDraft(supabase, draft, { step: `wait_${field}`, edit_field: field });
  return renderAddWizardScreen({
    supabase,
    chatId,
    draft: nextDraft,
    connection,
    messageId: options.messageId,
  });
}

async function handleCustomCallback(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  data: string,
  draft: TelegramDraft | null,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  if (!draft) return sendMessage(chatId, "Черновик не найден.");
  const [kind, fieldId, raw] = data.split(":");
  const fields = await getCustomFields(supabase, draft.company_id);
  const field = fields.find((item) => item.id === fieldId);
  if (!field) return sendMessage(chatId, "Поле не найдено.");
  let value: unknown;
  if (kind === "cfs") value = "";
  if (kind === "cfb") value = raw === "1";
  if (kind === "cfo") value = fieldOptions(field)[Number(raw)] ?? "";
  const nextDraft = await updateDraft(supabase, draft, { custom_values: { ...(draft.custom_values ?? {}), [field.id]: value } });
  return askNextCustomField(supabase, chatId, nextDraft, options);
}

async function updateProductStatus(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  data: string,
  options: CallbackRenderOptions = {},
) {
  const [, status, productId] = data.split(":") as [string, ProductStatus, string];
  const payload = status === "hidden" || status === "draft" ? { status, is_visible_in_api: false } : { status };
  const { error } = await supabase.from("products").update(payload).eq("company_id", companyId).eq("id", productId);
  if (error) throw error;
  if (options.callbackId) await answerCallbackQuery(options.callbackId, "Сохранено", chatId);
  await openProductCard(supabase, chatId, companyId, productId, options);
}

async function handleMediaCallback(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  data: string,
  options: CallbackRenderOptions = {},
) {
  const [, action, productId] = data.split(":");
  if (action === "delete") {
    const { error } = await supabase.from("product_media").delete().eq("company_id", companyId).eq("product_id", productId);
    if (error) throw error;
    if (options.callbackId) await answerCallbackQuery(options.callbackId, "Сохранено", chatId);
    return openProductCard(supabase, chatId, companyId, productId, options);
  }
  await createDraft(supabase, companyId, chatId, "edit", action === "replace" ? "edit_media_replace" : "edit_media_add", { product_id: productId, edit_field: "media" });
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection: options.connection,
    screen: "edit_media_upload",
    text: "Отправьте фото или видео.",
    rows: [],
    preferMessageId: options.messageId,
  });
}

async function handleEditCustomFieldChoice(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  data: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  const [, fieldId, productId] = data.split(":");
  const field = (await getCustomFields(supabase, companyId)).find((item) => item.id === fieldId);
  if (!field) return sendMessage(chatId, "Поле не найдено.");
  await createDraft(supabase, companyId, chatId, "edit", `edit_custom`, { product_id: productId, edit_field: `custom:${field.id}` });
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  const type = fieldType(field);
  if (type === "boolean") {
    return renderTelegramScreen({
      supabase,
      chatId,
      companyId,
      connection,
      screen: "edit_custom",
      text: field.name,
      rows: [[
        { text: "Да", callback_data: `ecfb:${field.id}:${productId}:1` },
        { text: "Нет", callback_data: `ecfb:${field.id}:${productId}:0` },
      ]],
      preferMessageId: options.messageId,
    });
  }
  if (type === "select") {
    return renderTelegramScreen({
      supabase,
      chatId,
      companyId,
      connection,
      screen: "edit_custom",
      text: field.name,
      rows: fieldOptions(field).map((option, index) => [{ text: option, callback_data: `ecfo:${field.id}:${productId}:${index}` }]),
      preferMessageId: options.messageId,
    });
  }
  await renderTelegramScreen({ supabase, chatId, companyId, connection, screen: "edit_custom", text: field.name, rows: [], preferMessageId: options.messageId });
}

async function handleEditCustomCallback(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  data: string,
  options: CallbackRenderOptions = {},
) {
  const [kind, fieldId, productId, raw] = data.split(":");
  const field = (await getCustomFields(supabase, companyId)).find((item) => item.id === fieldId);
  if (!field) return sendMessage(chatId, "Поле не найдено.");
  const value = kind === "ecfb" ? raw === "1" : fieldOptions(field)[Number(raw)] ?? "";
  await saveOneCustomValue(supabase, companyId, productId, field, value);
  if (options.callbackId) await answerCallbackQuery(options.callbackId, "Сохранено", chatId);
  await openProductCard(supabase, chatId, companyId, productId, options);
}

async function handleMessage(supabase: ReturnType<typeof getSupabaseAdmin>, message: TelegramMessage) {
  const startedAt = Date.now();
  const chatId = String(message.chat.id);
  const text = message.text?.trim() ?? "";
  const media = getMessageMedia(message);
  const voiceMedia = getMessageVoiceMedia(message);
  if (text === "/disconnect") {
    const { error } = await supabase
      .from("telegram_connections")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("telegram_chat_id", chatId)
      .eq("is_active", true);
    if (error) throw error;
    clearConnectionCache(chatId);
    return sendMessage(chatId, "Бот отключён от компании.");
  }
  if (text === "/start") {
    const getConnectionStartedAt = Date.now();
    const connection = await getConnection(supabase, chatId);
    logTiming("get connection", getConnectionStartedAt, chatId);
    if (!connection) return sendMessage(chatId, "Отправьте код подключения из CRM.");
    const result = await showMainMenu(supabase, chatId, connection, { forceNew: true });
    logTiming("handle action start", startedAt, chatId);
    return result;
  }
  if (text === "/status") {
    const connection = await getConnection(supabase, chatId);
    return sendMessage(chatId, connection ? "Бот подключён к компании." : "Бот не подключён.");
  }
  const getConnectionStartedAt = Date.now();
  const connection = await getConnection(supabase, chatId);
  logTiming("get connection", getConnectionStartedAt, chatId);
  if (!connection) {
    if (/^[0-9]{6}$/.test(text)) {
      const connected = await connectByCode(supabase, chatId, message.from, text);
      if (connected) {
        const nextConnection = await getConnection(supabase, chatId);
        if (nextConnection) return showMainMenu(supabase, chatId, nextConnection, { forceNew: true });
        return sendMessage(chatId, "Бот успешно подключён к компании.");
      }
      return sendMessage(chatId, "Код неверный или истёк. Сгенерируйте новый код в CRM.");
    }
    return sendMessage(chatId, media || voiceMedia || text === "/addproduct" ? NOT_CONNECTED : "Отправьте код подключения из CRM.");
  }
  if (text === "/menu" || normalize(text) === normalize("Главное меню")) {
    const responseStartedAt = Date.now();
    const result = await showMainMenu(supabase, chatId, connection, { forceNew: true });
    logTiming("telegram response", responseStartedAt, chatId);
    logTiming("handle action menu", startedAt, chatId);
    return result;
  }
  if (text === "/help") return showHelp(supabase, chatId, { connection, forceNew: true });
  if (text === "/cancel") {
    const draft = await getActiveDraft(supabase, connection.company_id, chatId);
    if (draftHasImportantData(draft)) return showCancelConfirm(supabase, chatId, connection, draft as TelegramDraft, { forceNew: true });
    await clearDrafts(supabase, connection.company_id, chatId);
    return showCancelledMenu(supabase, chatId, connection, { forceNew: true });
  }
  if (text === "/find") return handleMenuAction(supabase, chatId, connection, "find", undefined, true);
  if (text === "/addproduct") return handleMenuAction(supabase, chatId, connection, "add", undefined, true);
  const draft = await getActiveDraft(supabase, connection.company_id, chatId);
  if (voiceMedia) return handleVoiceMessage(supabase, chatId, connection, draft, message);
  if (media) {
    if (!draft) return startAddWizard(supabase, chatId, connection, message, { forceNew: true });
    return handleDraftMedia(supabase, chatId, draft, message);
  }
  if (!draft) return showMainMenu(supabase, chatId, connection, { forceNew: true });
  if (draft.mode === "edit") return handleEditText(supabase, chatId, draft, text);
  return handleAddDraftText(supabase, chatId, draft, text);
}

export async function processTelegramUpdate(update: TelegramUpdate) {
  const startedAt = Date.now();
  let chatId: string | undefined;
  let action = "unknown";

  try {
    chatId = update.callback_query?.message?.chat.id
      ? String(update.callback_query.message.chat.id)
      : update.message?.chat.id
        ? String(update.message.chat.id)
        : undefined;
    action = update.callback_query?.data ?? update.message?.text ?? (update.message?.voice || update.message?.audio || update.message?.video_note ? "voice" : update.message?.photo || update.message?.video ? "media" : "unknown");

    let callbackAnswered = false;
    if (update.callback_query) {
      const now = Date.now();
      const cold = lastCallbackAt === 0 || now - lastCallbackAt > CALLBACK_COLD_AFTER_MS;
      lastCallbackAt = now;
      const answerStartedAt = Date.now();
      void answerCallbackQuery(update.callback_query.id, undefined, chatId).then(() => {
        const ms = Date.now() - answerStartedAt;
        console.log("telegram timing", { action: "answer_callback", ms, chatId, cold });
        if (cold && ms > 1000) console.warn("telegram slow first callback", { ms, chatId });
      });
      callbackAnswered = true;
    }
    if (isDuplicateUpdate(update)) {
      logTotalTiming(`duplicate ${String(action)}`, startedAt, chatId);
      return;
    }
    await enqueueChatWork(chatId, async () => {
      const supabase = getSupabaseAdmin();
      if (update.callback_query) await handleCallback(supabase, update.callback_query, callbackAnswered);
      else if (update.message) await handleMessage(supabase, update.message);
      else {
        console.log("telegram unknown update", {
          updateId: update.update_id,
          keys: Object.keys(update as Record<string, unknown>),
        });
      }
    });
    logTiming(String(action), startedAt, chatId);
    logTotalTiming(String(action), startedAt, chatId);
  } catch (error) {
    logTelegramError("webhook_async", error, { action, chatId });
    logTiming("webhook_error", startedAt);
    logTotalTiming("webhook_error", startedAt);
  } finally {
    console.log("telegram async processing", { ms: Date.now() - startedAt });
  }
}

export function logTelegramWebhookParseError(error: unknown) {
  logTelegramError("webhook_parse", error);
}
