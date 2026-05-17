import { getSupabaseAdmin } from "../supabase/admin.js";
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
      { text: "⬅️ Назад", callback_data: "nav:back" },
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
      if (isNonCriticalTelegramError(error)) {
        return { mode: "edit" as const, messageId };
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

async function flushScreenCleanupQueue(chatId: string, action: string) {
  const queued = screenCleanupQueue.get(chatId);
  if (!queued?.length) return;

  screenCleanupQueue.delete(chatId);
  const remaining: number[] = [];
  for (const messageId of queued) {
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

  void flushScreenCleanupQueue(chatId, `cleanup_queue:${screen}`);

  let result: { mode: string; messageId: number };
  let oldMessageId: number | null | undefined;
  if (forceNew) {
    oldMessageId = targetMessageId;
    const sent = await sendTelegramMessage(chatId, text, replyMarkup, `render_screen:${screen}`);
    result = { mode: "force_new", messageId: sent.message_id };
    console.log("telegram screen render", { mode: "force_new", screen, chatId, oldMessageId, newMessageId: sent.message_id });
  } else {
    const editResult = await safeEditOrSend(chatId, targetMessageId, text, replyMarkup, `render_screen:${screen}`);
    result = editResult;
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
      keywords: [],
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
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  const companyId = connection?.company_id ?? products[0]?.company_id;
  if (products.length === 0) {
    if (!companyId) return sendMessage(chatId, "Товары не найдены.");
    await renderTelegramScreen({
      supabase,
      chatId,
      companyId,
      connection,
      screen: "search_results",
      text: "Товары не найдены.",
      rows: [[{ text: "🏠 Главное меню", callback_data: "nav:menu" }]],
      preferMessageId: options.messageId,
      nav: false,
      forceNew: options.forceNew,
    });
    return;
  }
  const text = ["Товары", ...products.map((product) => `${product.sku} — ${product.name}`)].join("\n");
  const rows = products.map((product) => [{ text: `${product.sku} — ${product.name}`, callback_data: `p:o:${product.id}` }]);
  rows.push([{ text: "🏠 Главное меню", callback_data: "nav:menu" }]);
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
  options: { connection?: TelegramConnection | null; messageId?: number | null; forceNew?: boolean } = {},
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
      { text: "🤖 API", callback_data: `p:a:${product.id}` },
    ],
    [
      { text: product.status === "hidden" ? "🙈 Показать" : "🙈 Скрыть", callback_data: `p:v:${product.id}` },
      { text: "🖼 Медиа", callback_data: `efp:media:${product.id}` },
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
    cancel: false,
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

type CallbackRenderOptions = { connection?: TelegramConnection; messageId?: number | null; callbackId?: string };

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

async function toggleApi(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  options: CallbackRenderOptions = {},
) {
  const product = await getProduct(supabase, companyId, productId);
  if (!product) return sendMessage(chatId, "Товар не найден.");
  if (product.status !== "active") return sendMessage(chatId, "Сначала активируйте товар.");
  if (product.stock <= 0) return sendMessage(chatId, "Нельзя включить API: остаток 0.");
  const nextValue = !product.is_visible_in_api;
  const { error } = await supabase.from("products").update({ is_visible_in_api: nextValue }).eq("company_id", companyId).eq("id", productId);
  if (error) throw error;
  if (options.callbackId) await answerCallbackQuery(options.callbackId, nextValue ? "API включён" : "API выключен", chatId);
  await openProductCard(supabase, chatId, companyId, productId, options);
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

  if (draft.mode === "add" && draft.edit_field && ["name", "price", "stock", "description"].includes(draft.edit_field)) {
    if (draft.edit_field === "name") {
      if (!text.trim()) return renderAddWizardScreen({ supabase, chatId, draft, connection, forceNew: true, error: "Название не может быть пустым. Введите название ещё раз." });
      const nextDraft = await updateDraft(supabase, draft, { name: text.trim(), step: "preview", edit_field: null });
      return showAddPreview(supabase, chatId, nextDraft, { connection, forceNew: true });
    }
    if (draft.edit_field === "price") {
      const price = parsePrice(text);
      if (price === null) return renderAddWizardScreen({ supabase, chatId, draft, connection, forceNew: true, error: "Цена должна быть числом. Введите цену ещё раз." });
      const nextDraft = await updateDraft(supabase, draft, { price, step: "preview", edit_field: null });
      return showAddPreview(supabase, chatId, nextDraft, { connection, forceNew: true });
    }
    if (draft.edit_field === "stock") {
      const stock = parseStock(text);
      if (stock === null) return renderAddWizardScreen({ supabase, chatId, draft, connection, forceNew: true, error: "Остаток должен быть целым числом. Введите остаток ещё раз." });
      const nextDraft = await updateDraft(supabase, draft, { stock, step: "preview", edit_field: null });
      return showAddPreview(supabase, chatId, nextDraft, { connection, forceNew: true });
    }
    if (draft.edit_field === "description") {
      const nextDraft = await updateDraft(supabase, draft, { description: text.trim() || null, step: "preview", edit_field: null });
      return showAddPreview(supabase, chatId, nextDraft, { connection, forceNew: true });
    }
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
    return sendProductList(supabase, chatId, products, { forceNew: true });
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
  if (action === "add_product" || action === "add") return startAddWizard(supabase, chatId, connection, undefined, { messageId, forceNew });
  if (action === "find_product" || action === "find") {
    await createDraft(supabase, connection.company_id, chatId, "find", "wait_find");
    return renderTelegramScreen({ supabase, chatId, companyId: connection.company_id, connection, screen: "search_prompt", text: "Введите название, SKU или ключевое слово.", rows: [], preferMessageId: messageId, forceNew });
  }
  if (action === "edit_product" || action === "edit") {
    await createDraft(supabase, connection.company_id, chatId, "edit_search", "wait_edit_search");
    return renderTelegramScreen({ supabase, chatId, companyId: connection.company_id, connection, screen: "edit_search_prompt", text: "Введите SKU или название товара.", rows: [], preferMessageId: messageId, forceNew });
  }
  if (action === "latest_products") {
    const { data, error } = await supabase
      .from("products")
      .select("id, company_id, sku, name, price, stock, status, is_visible_in_api, updated_at")
      .eq("company_id", connection.company_id)
      .order("updated_at", { ascending: false })
      .limit(5);
    if (error) throw error;
    return sendProductList(supabase, chatId, ((data ?? []) as Product[]) ?? [], { connection, messageId, forceNew });
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
  if (mode === "edit" && productId) return startEditProduct(supabase, chatId, connection.company_id, productId);
  return startAddWizard(supabase, chatId, connection);
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
    return connection ? showMainMenu(supabase, chatId, connection, { messageId: options.messageId }) : sendMessage(chatId, "Нечего возвращать назад.");
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

  const draft = await getActiveDraft(supabase, connection.company_id, chatId);
  if (data === "nav:back") return handleWizardBack(supabase, chatId, draft, { connection, messageId: callback.message?.message_id });
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
    const nextDraft = await updateDraft(supabase, draft, { category_id: categoryId, step: draft.edit_field === "category" ? "preview" : "wait_name", ...(draft.edit_field === "category" ? { edit_field: null } : {}) });
    if (draft.edit_field === "category" || nextDraft.name) {
      const previewDraft = nextDraft.step === "preview" ? nextDraft : await updateDraft(supabase, nextDraft, { step: "preview" });
      return showAddPreview(supabase, chatId, previewDraft, { connection, messageId: callback.message?.message_id });
    }
    return renderAddWizardScreen({ supabase, chatId, draft: nextDraft, connection, messageId: callback.message?.message_id });
  }
  if (data === "desc:skip") {
    if (!draft) return sendMessage(chatId, "Черновик не найден.");
    const nextDraft = await updateDraft(supabase, draft, { description: null, ...(draft.edit_field === "description" ? { step: "preview", edit_field: null } : {}) });
    if (draft.edit_field === "description") return showAddPreview(supabase, chatId, nextDraft, { connection, messageId: callback.message?.message_id });
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
  if (data.startsWith("p:o:")) {
    await clearDrafts(supabase, connection.company_id, chatId);
    return openProductCard(supabase, chatId, connection.company_id, data.slice(4), { connection, messageId: callback.message?.message_id });
  }
  if (data.startsWith("p:e:")) return startEditProduct(supabase, chatId, connection.company_id, data.slice(4), { connection, messageId: callback.message?.message_id });
  if (data.startsWith("p:a:")) return toggleApi(supabase, chatId, connection.company_id, data.slice(4), { connection, messageId: callback.message?.message_id, callbackId: callbackIdForAction });
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
    return sendMessage(chatId, media || text === "/addproduct" ? NOT_CONNECTED : "Отправьте код подключения из CRM.");
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
    action = update.callback_query?.data ?? update.message?.text ?? (update.message?.photo || update.message?.video ? "media" : "unknown");

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
