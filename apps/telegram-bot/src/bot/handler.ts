import { getSupabaseAdmin } from "../supabase/admin.js";
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate, TelegramUser } from "../telegram/types.js";
import type { Category, Company, CustomField, Product, ProductCustomValue, ProductMedia, ProductStatus } from "./database.js";
import { createId, getErrorMessage } from "./utils.js";

const MEDIA_BUCKET = "product-media";
const NOT_CONNECTED = "Сначала подключите бота. Откройте CRM → Настройки → Telegram-бот и отправьте сюда код подключения.";

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
type DraftBrief = Pick<TelegramDraft, "id" | "step" | "mode" | "product_id" | "category_id" | "step_history">;

const CONNECTION_CACHE_TTL_MS = 60_000;
const RECENT_UPDATE_TTL_MS = 120_000;
const connectionCache = new Map<string, { value: CachedConnection | null; expiresAt: number }>();
const recentUpdates = new Map<string, number>();

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

function getTelegramToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing.");
  return token;
}

function logTelegramError(stage: string, error: unknown, details?: Record<string, unknown>) {
  console.error("Telegram bot error", { stage, message: getErrorMessage(error), details });
}

async function telegramApi<T>(method: string, payload: Record<string, unknown>, action = method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`https://api.telegram.org/bot${getTelegramToken()}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!response.ok || !body.ok) throw new Error(body.description ?? `Telegram API ${method} failed`);
    return body.result as T;
  } catch (error) {
    logTelegramError("telegram_api", error, { method, action });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegramMessage(chatId: string, text: string, replyMarkup?: Record<string, unknown>, action = "send_message") {
  return telegramApi<TelegramMessage>("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup }, action);
}

async function editTelegramMessage(
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
  action = "edit_message",
) {
  return telegramApi(
    "editMessageText",
    { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup },
    action,
  );
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  try {
    return await telegramApi("answerCallbackQuery", { callback_query_id: callbackQueryId, text }, "answer_callback");
  } catch {
    return null;
  }
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
      if (getErrorMessage(error).includes("message is not modified")) {
        return { mode: "edit" as const, messageId };
      }
    }
  }

  const sent = await sendTelegramMessage(chatId, text, replyMarkup, action);
  return { mode: "send" as const, messageId: sent.message_id };
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
  const result = await safeEditOrSend(chatId, targetMessageId, text, replyMarkup, `render_screen:${screen}`);

  if (screenConnection) {
    await updateConnectionMessageIds(supabase, chatId, screenConnection, {
      active_screen_message_id: result.messageId,
      last_bot_message_id: result.messageId,
      ...(screen === "main_menu" ? { last_menu_message_id: result.messageId } : {}),
    });
  }

  console.log("telegram screen render", { mode: result.mode, screen, chatId, messageId: result.messageId });
  return result;
}

async function showMainMenu(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  options: { messageId?: number | null } = {},
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
  });
  console.log("telegram menu render", { mode: result.mode, chatId, messageId: result.messageId });
  return result;
}

async function showCancelledMenu(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  options: { messageId?: number | null } = {},
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
  });
}

function getMessageMedia(message: TelegramMessage) {
  const photo = message.photo?.[message.photo.length - 1] ?? null;
  const video = message.video ?? null;
  if (!photo && !video) return null;
  return { fileId: photo?.file_id ?? video?.file_id ?? "", mediaType: photo ? ("photo" as const) : ("video" as const) };
}

async function downloadTelegramFile(fileId: string) {
  const file = await telegramApi<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram did not return file_path.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`https://api.telegram.org/file/bot${getTelegramToken()}/${file.file_path}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Telegram file download failed with status ${response.status}.`);
    return {
      buffer: await response.arrayBuffer(),
      filePath: file.file_path,
      fileSize: file.file_size ?? null,
      contentType: response.headers.get("content-type") ?? undefined,
    };
  } catch (error) {
    logTelegramError("telegram_file_download", error, { action: "download_file", fileId });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

async function getConnection(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string) {
  const cacheStartedAt = Date.now();
  const cached = connectionCache.get(chatId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    logTiming("get connection cache", cacheStartedAt, chatId);
    return cached.value?.is_active ? cachedConnectionToConnection(chatId, cached.value) : null;
  }
  if (cached) connectionCache.delete(chatId);

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

async function getActiveDraftBrief(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string, chatId: string) {
  const { data, error } = await supabase
    .from("telegram_product_drafts")
    .select("id, step, mode, product_id, category_id, step_history")
    .eq("company_id", companyId)
    .eq("telegram_chat_id", chatId)
    .neq("step", "done")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data?.[0] ?? null) as DraftBrief | null) ?? null;
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
  if (draft.step === "custom_fields" && draft.edit_field) return `custom_fields:${draft.edit_field}`;
  return draft.step;
}

function draftValuesWithHistory(draft: TelegramDraft, values: Record<string, unknown>) {
  if ("step_history" in values) return values;
  const nextStep = typeof values.step === "string" ? values.step : draft.step;
  const nextEditField = typeof values.edit_field === "string" ? values.edit_field : draft.edit_field;
  const isSameStep = nextStep === draft.step;
  const isSameCustomField = draft.step === "custom_fields" && nextStep === "custom_fields" && nextEditField === draft.edit_field;
  if (isSameStep && (draft.step !== "custom_fields" || isSameCustomField)) return values;
  const currentKey = getDraftHistoryKey(draft);
  const history = Array.isArray(draft.step_history) ? draft.step_history : [];
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
  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Category[]) ?? [];
}

async function getCategory(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string, categoryId: string) {
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
  options: { connection?: TelegramConnection | null; messageId?: number | null; screen?: string } = {},
) {
  const categories = await getCategories(supabase, companyId);
  if (categories.length === 0) {
    await sendMessage(chatId, "Сначала создайте категорию в CRM.");
    return false;
  }
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection: options.connection,
    screen: options.screen ?? "choose_category",
    text,
    rows: categories.map((category) => [{ text: `${category.code} · ${category.name}`, callback_data: `cat:${category.id}` }]),
    preferMessageId: options.messageId,
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
  const { error: uploadError } = await supabase.storage.from(MEDIA_BUCKET).upload(storagePath, downloaded.buffer, {
    contentType: downloaded.contentType,
    upsert: false,
  });
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
  const { data, error } = await supabase
    .from("custom_fields")
    .select("*")
    .eq("company_id", companyId)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as CustomField[]) ?? [];
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

async function askNextCustomField(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  const fields = await getCustomFields(supabase, draft.company_id);
  const nextField = fields.find((field) => draft.custom_values?.[field.id] === undefined);
  if (!nextField) {
    await showAddPreview(supabase, chatId, await updateDraft(supabase, draft, { step: "preview" }), options);
    return;
  }

  await updateDraft(supabase, draft, { step: "custom_fields", edit_field: nextField.id });
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  const suffix = nextField.is_required ? "" : " или нажмите Пропустить";
  const prompt = `${nextField.name}${suffix}`;
  const type = fieldType(nextField);
  if (type === "boolean") {
    await renderTelegramScreen({
      supabase,
      chatId,
      companyId: draft.company_id,
      connection,
      screen: "custom_fields",
      text: prompt,
      rows: [
        [
          { text: "Да", callback_data: `cfb:${nextField.id}:1` },
          { text: "Нет", callback_data: `cfb:${nextField.id}:0` },
        ],
        ...(!nextField.is_required ? [[{ text: "Пропустить", callback_data: `cfs:${nextField.id}` }]] : []),
      ],
      preferMessageId: options.messageId,
    });
    return;
  }
  if (type === "select") {
    const rows = fieldOptions(nextField).map((option, index) => [{ text: option, callback_data: `cfo:${nextField.id}:${index}` }]);
    if (!nextField.is_required) rows.push([{ text: "Пропустить", callback_data: `cfs:${nextField.id}` }]);
    await renderTelegramScreen({
      supabase,
      chatId,
      companyId: draft.company_id,
      connection,
      screen: "custom_fields",
      text: prompt,
      rows,
      preferMessageId: options.messageId,
    });
    return;
  }
  const rows = !nextField.is_required ? [[{ text: "Пропустить", callback_data: `cfs:${nextField.id}` }]] : undefined;
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId: draft.company_id,
    connection,
    screen: "custom_fields",
    text: prompt,
    rows: rows ?? [],
    preferMessageId: options.messageId,
  });
}

async function showAddPreview(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
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
    .map((field) => `${field.name}: ${formatCustomValue(field, draft.custom_values[field.id])}`);
  const text = [
    "Проверьте товар",
    `SKU: ${sku}`,
    `Категория: ${category.code} · ${category.name}`,
    `Название: ${draft.name ?? ""}`,
    `Цена: ${draft.price ?? 0}`,
    `Остаток: ${draft.stock ?? 0}`,
    `Описание: ${draft.description || "—"}`,
    `Медиа: ${(draft.media ?? []).length} файлов`,
    ...customLines,
  ].join("\n");
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId: draft.company_id,
    connection: options.connection,
    screen: "preview",
    text,
    rows: [
      [
        { text: "✅ Сохранить", callback_data: `d:save:${sku}` },
        { text: "✏️ Изменить", callback_data: "d:edit" },
      ],
    ],
    preferMessageId: options.messageId,
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
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
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
  });
}

async function openProductCard(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
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
  });
}

async function sendEditProductMenu(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
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
  });
}

async function startEditProduct(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
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
  if (options.callbackId) await answerCallbackQuery(options.callbackId, nextStatus === "hidden" ? "Товар скрыт" : "Товар активирован");
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
  if (options.callbackId) await answerCallbackQuery(options.callbackId, nextValue ? "API включён" : "API выключен");
  await openProductCard(supabase, chatId, companyId, productId, options);
}

async function showStats(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
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
  });
}

async function showHelp(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
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
  });
}

function isBusyDraft(draft: { step: string } | null) {
  return Boolean(draft && draft.step !== "idle" && draft.step !== "done");
}

async function showBusyMessage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  messageId?: number,
) {
  const rows = [
    [
      { text: "Продолжить", callback_data: "draft:resume" },
      { text: "Начать заново", callback_data: "draft:restart" },
    ],
    [{ text: "Удалить черновик", callback_data: "draft:cancel" }],
  ];
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId: connection.company_id,
    connection,
    screen: "draft_busy",
    text: "У вас есть незавершённое действие",
    rows,
    preferMessageId: messageId,
    nav: false,
  });
}

async function startAddWizard(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  message?: TelegramMessage,
  options: { messageId?: number | null } = {},
) {
  const media = message ? getMessageMedia(message) : null;
  const draft = await createDraft(supabase, connection.company_id, chatId, "add", media ? "choose_category" : "wait_media");
  if (media) {
    try {
      await uploadDraftMediaFromMessage(supabase, draft, message as TelegramMessage, "choose_category");
    } catch (error) {
      logTelegramError("media_upload", error, { companyId: connection.company_id, chatId });
      await sendMessage(chatId, "Не удалось загрузить фото. Попробуйте ещё раз.");
      return;
    }
    await sendCategoryKeyboard(supabase, connection.company_id, chatId, "Фото получил ✅ Выберите категорию товара:", { connection, screen: "choose_category" });
    return;
  }
  const rows = [[{ text: "Пропустить медиа", callback_data: "media:skip" }]];
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId: connection.company_id,
    connection,
    screen: "wait_media",
    text: "Отправьте фото или видео",
    rows,
    preferMessageId: options.messageId,
  });
}

async function showEditFieldPrompt(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  companyId: string,
  productId: string,
  field: string,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  if (field === "category") return sendCategoryKeyboard(supabase, companyId, chatId, "Выберите категорию", { connection, messageId: options.messageId, screen: "edit_category" });
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
    if (price === null) return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "edit_price", text: "Введите цену числом.", rows: [] });
    update.price = price;
  }
  if (draft.edit_field === "stock") {
    const stock = parseStock(text);
    if (stock === null) return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "edit_stock", text: "Введите остаток целым числом.", rows: [] });
    update.stock = stock;
  }
  if (draft.edit_field.startsWith("custom:")) {
    const fieldId = draft.edit_field.slice(7);
    const field = (await getCustomFields(supabase, draft.company_id)).find((item) => item.id === fieldId);
    if (!field) return sendMessage(chatId, "Поле не найдено.");
    const parsed = parseCustomValue(field, text);
    if ("error" in parsed) return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "edit_custom", text: parsed.error ?? "Введите корректное значение.", rows: [] });
    await saveOneCustomValue(supabase, draft.company_id, draft.product_id, field, parsed.value);
    await clearDrafts(supabase, draft.company_id, chatId);
    await openProductCard(supabase, chatId, draft.company_id, draft.product_id, { connection: connection ?? undefined });
    return;
  }
  const { error } = await supabase.from("products").update(update).eq("company_id", draft.company_id).eq("id", draft.product_id);
  if (error) throw error;
  await clearDrafts(supabase, draft.company_id, chatId);
  await openProductCard(supabase, chatId, draft.company_id, draft.product_id, { connection: connection ?? undefined });
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
  if (draft.step === "wait_name") {
    await updateDraft(supabase, draft, { name: text, step: "wait_price" });
    return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "wait_price", text: "Введите цену", rows: [] });
  }
  if (draft.step === "wait_price") {
    const price = parsePrice(text);
    if (price === null) return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "wait_price", text: "Введите цену числом.", rows: [] });
    await updateDraft(supabase, draft, { price, step: "wait_stock" });
    return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "wait_stock", text: "Введите остаток", rows: [] });
  }
  if (draft.step === "wait_stock") {
    const stock = parseStock(text);
    if (stock === null) return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "wait_stock", text: "Введите остаток целым числом.", rows: [] });
    await updateDraft(supabase, draft, { stock, step: "wait_description" });
    return renderTelegramScreen({
      supabase,
      chatId,
      companyId: draft.company_id,
      connection,
      screen: "wait_description",
      text: "Добавьте описание или нажмите Пропустить",
      rows: [[{ text: "Пропустить", callback_data: "desc:skip" }]],
    });
  }
  if (draft.step === "wait_description") {
    const nextDraft = await updateDraft(supabase, draft, { description: text });
    return askNextCustomField(supabase, chatId, nextDraft, { connection });
  }
  if (draft.step === "custom_fields" && draft.edit_field) {
    const field = (await getCustomFields(supabase, draft.company_id)).find((item) => item.id === draft.edit_field);
    if (!field) return sendMessage(chatId, "Поле не найдено.");
    const parsed = parseCustomValue(field, text);
    if ("error" in parsed) return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "custom_fields", text: parsed.error ?? "Введите корректное значение.", rows: [] });
    const nextDraft = await updateDraft(supabase, draft, {
      custom_values: { ...(draft.custom_values ?? {}), [field.id]: parsed.value },
      edit_field: null,
    });
    return askNextCustomField(supabase, chatId, nextDraft, { connection });
  }
  if (draft.step === "wait_find" || draft.step === "wait_edit_search") {
    const products = await findProducts(supabase, draft.company_id, text);
    await clearDrafts(supabase, draft.company_id, chatId);
    if (draft.step === "wait_edit_search" && products.length === 1) return startEditProduct(supabase, chatId, draft.company_id, products[0].id);
    return sendProductList(supabase, chatId, products);
  }
  await renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: draft.step, text: "Нажмите кнопку под сообщением.", rows: [] });
}

async function handleDraftMedia(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string, draft: TelegramDraft, message: TelegramMessage) {
  if (draft.mode === "edit" && draft.product_id && (draft.step === "edit_media_add" || draft.step === "edit_media_replace")) {
    const product = await getProduct(supabase, draft.company_id, draft.product_id);
    if (!product) return sendMessage(chatId, "Товар не найден.");
    if (draft.step === "edit_media_replace") {
      await supabase.from("product_media").delete().eq("company_id", draft.company_id).eq("product_id", draft.product_id);
    }
    const media = getMessageMedia(message);
    if (!media) return sendMessage(chatId, "Отправьте фото или видео.");
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
    const connection = await getConnection(supabase, chatId);
    return openProductCard(supabase, chatId, draft.company_id, product.id, { connection: connection ?? undefined });
  }
  if (draft.mode === "add" && (draft.step === "wait_media" || draft.step === "choose_category")) {
    const nextStep = draft.step === "wait_media" ? "choose_category" : "choose_category";
    const nextDraft = await uploadDraftMediaFromMessage(supabase, draft, message, nextStep);
    if (!nextDraft) return sendMessage(chatId, "Отправьте фото или видео.");
    const connection = await getConnection(supabase, chatId);
    return sendCategoryKeyboard(supabase, draft.company_id, chatId, "Фото получил ✅ Выберите категорию товара:", { connection });
  }
  await sendMessage(chatId, "Сейчас ожидаю текст или кнопку.");
}

async function handleMenuAction(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  connection: TelegramConnection,
  action: string,
  messageId?: number,
) {
  if (action === "menu") return showMainMenu(supabase, chatId, connection, { messageId });
  if (action === "help") return showHelp(supabase, chatId, { connection, messageId });

  const activeDraft = await getActiveDraftBrief(supabase, connection.company_id, chatId);
  if (isBusyDraft(activeDraft)) return showBusyMessage(supabase, chatId, connection, messageId);
  if (action === "add_product" || action === "add") return startAddWizard(supabase, chatId, connection, undefined, { messageId });
  if (action === "find_product" || action === "find") {
    await createDraft(supabase, connection.company_id, chatId, "find", "wait_find");
    return renderTelegramScreen({ supabase, chatId, companyId: connection.company_id, connection, screen: "search_prompt", text: "Введите название, SKU или ключевое слово.", rows: [], preferMessageId: messageId });
  }
  if (action === "edit_product" || action === "edit") {
    await createDraft(supabase, connection.company_id, chatId, "edit_search", "wait_edit_search");
    return renderTelegramScreen({ supabase, chatId, companyId: connection.company_id, connection, screen: "edit_search_prompt", text: "Введите SKU или название товара.", rows: [], preferMessageId: messageId });
  }
  if (action === "latest_products") {
    const { data, error } = await supabase
      .from("products")
      .select("id, company_id, sku, name, price, stock, status, is_visible_in_api, updated_at")
      .eq("company_id", connection.company_id)
      .order("updated_at", { ascending: false })
      .limit(5);
    if (error) throw error;
    return sendProductList(supabase, chatId, ((data ?? []) as Product[]) ?? [], { connection, messageId });
  }
  if (action === "stats") return showStats(supabase, chatId, connection.company_id, { connection, messageId });
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

async function handleDraftBack(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft | null,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  if (!draft) return sendMessage(chatId, "Нечего возвращать назад.");
  const history = Array.isArray(draft.step_history) ? draft.step_history : [];
  const previous = history.at(-1);
  if (!previous) return resumeDraft(supabase, chatId, draft, options);

  const stepHistory = history.slice(0, -1);
  const [step, editField] = previous.split(":");
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
    step_history: stepHistory,
    ...(step === "custom_fields" ? { edit_field: editField ?? draft.edit_field } : {}),
  });
  return resumeDraft(supabase, chatId, nextDraft, options);
}

async function handleCallback(supabase: ReturnType<typeof getSupabaseAdmin>, callback: TelegramCallbackQuery, callbackAnswered = false) {
  const startedAt = Date.now();
  const chatId = callback.message?.chat.id ? String(callback.message.chat.id) : "";
  const data = callback.data ?? "";
  if (!chatId) return answerCallbackQuery(callback.id, "Чат не найден.");
  if (!callbackAnswered) {
    await answerCallbackQuery(callback.id);
    logTiming("answer_callback", startedAt, chatId);
  }
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
  if (data === "nav:back") return handleDraftBack(supabase, chatId, draft, { connection, messageId: callback.message?.message_id });
  if (data === "draft:resume") return draft ? resumeDraft(supabase, chatId, draft, { connection, messageId: callback.message?.message_id }) : showMainMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  if (data === "draft:restart") return restartDraft(supabase, chatId, connection, draft);
  if (data === "draft:cancel") {
    await clearDrafts(supabase, connection.company_id, chatId);
    await answerCallbackQuery(callback.id, "Действие отменено");
    return showCancelledMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  }
  if (data === "busy:cont") return draft ? resumeDraft(supabase, chatId, draft, { connection, messageId: callback.message?.message_id }) : showMainMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  if (data === "busy:new") {
    await clearDrafts(supabase, connection.company_id, chatId);
    await answerCallbackQuery(callback.id, "Начните заново");
    return showMainMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  }
  if (data === "busy:menu") return showMainMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  if (data === "media:skip") {
    if (!draft) return sendMessage(chatId, "Черновик не найден.");
    await updateDraft(supabase, draft, { step: "choose_category" });
    return sendCategoryKeyboard(supabase, connection.company_id, chatId, "Выберите категорию", { connection, messageId: callback.message?.message_id });
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
      await answerCallbackQuery(callback.id, "Сохранено");
      return openProductCard(supabase, chatId, connection.company_id, draft.product_id, { connection, messageId: callback.message?.message_id });
    }
    const nextDraft = await updateDraft(supabase, draft, { category_id: categoryId, step: "wait_name" });
    if (nextDraft.name) return showAddPreview(supabase, chatId, nextDraft, { connection, messageId: callback.message?.message_id });
    return renderTelegramScreen({ supabase, chatId, companyId: connection.company_id, connection, screen: "wait_name", text: "Введите название", rows: [], preferMessageId: callback.message?.message_id });
  }
  if (data === "desc:skip") {
    if (!draft) return sendMessage(chatId, "Черновик не найден.");
    const nextDraft = await updateDraft(supabase, draft, { description: null });
    if (draft.mode === "add") return askNextCustomField(supabase, chatId, nextDraft, { connection, messageId: callback.message?.message_id });
    const previewDraft = await updateDraft(supabase, draft, { step: "preview" });
    return showAddPreview(supabase, chatId, previewDraft, { connection, messageId: callback.message?.message_id });
  }
  if (data.startsWith("cfb:") || data.startsWith("cfo:") || data.startsWith("cfs:")) return handleCustomCallback(supabase, chatId, data, draft, { connection, messageId: callback.message?.message_id });
  if (data.startsWith("d:save:")) {
    if (!draft) return sendMessage(chatId, "Черновик не найден.");
    const result = await saveDraftAsProduct(supabase, draft, data.slice(7));
    await answerCallbackQuery(callback.id, `Товар сохранён как черновик: ${result.sku}`);
    return showMainMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  }
  if (data === "d:cancel") {
    await clearDrafts(supabase, connection.company_id, chatId);
    await answerCallbackQuery(callback.id, "Действие отменено");
    return showCancelledMenu(supabase, chatId, connection, { messageId: callback.message?.message_id });
  }
  if (data === "d:edit") return sendDraftEditMenu(supabase, chatId, draft, { connection, messageId: callback.message?.message_id });
  if (data.startsWith("de:")) return handleDraftEditChoice(supabase, chatId, connection.company_id, draft, data.slice(3), { connection, messageId: callback.message?.message_id });
  if (data.startsWith("p:o:")) {
    await clearDrafts(supabase, connection.company_id, chatId);
    return openProductCard(supabase, chatId, connection.company_id, data.slice(4), { connection, messageId: callback.message?.message_id });
  }
  if (data.startsWith("p:e:")) return startEditProduct(supabase, chatId, connection.company_id, data.slice(4), { connection, messageId: callback.message?.message_id });
  if (data.startsWith("p:a:")) return toggleApi(supabase, chatId, connection.company_id, data.slice(4), { connection, messageId: callback.message?.message_id, callbackId: callback.id });
  if (data.startsWith("p:v:")) return toggleVisibility(supabase, chatId, connection.company_id, data.slice(4), { connection, messageId: callback.message?.message_id, callbackId: callback.id });
  if (data.startsWith("efp:")) {
    const [, field, productId] = data.split(":");
    return askFieldValue(supabase, chatId, connection.company_id, productId, field, { connection, messageId: callback.message?.message_id });
  }
  if (data.startsWith("st:")) return updateProductStatus(supabase, chatId, connection.company_id, data, { connection, messageId: callback.message?.message_id, callbackId: callback.id });
  if (data.startsWith("med:")) return handleMediaCallback(supabase, chatId, connection.company_id, data, { connection, messageId: callback.message?.message_id, callbackId: callback.id });
  if (data.startsWith("ecf:")) return handleEditCustomFieldChoice(supabase, chatId, connection.company_id, data, { connection, messageId: callback.message?.message_id });
  if (data.startsWith("ecfb:") || data.startsWith("ecfo:")) return handleEditCustomCallback(supabase, chatId, connection.company_id, data, { connection, messageId: callback.message?.message_id, callbackId: callback.id });
}

async function resumeDraft(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramDraft,
  options: { connection?: TelegramConnection | null; messageId?: number | null } = {},
) {
  const connection = options.connection ?? (await getConnection(supabase, chatId));
  if (draft.step === "wait_media") return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "wait_media", text: "Отправьте фото или видео", rows: [[{ text: "Пропустить медиа", callback_data: "media:skip" }]], preferMessageId: options.messageId });
  if (draft.step === "choose_category") return sendCategoryKeyboard(supabase, draft.company_id, chatId, "Выберите категорию", { connection, messageId: options.messageId });
  if (draft.step === "wait_name") return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "wait_name", text: "Введите название", rows: [], preferMessageId: options.messageId });
  if (draft.step === "wait_price") return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "wait_price", text: "Введите цену", rows: [], preferMessageId: options.messageId });
  if (draft.step === "wait_stock") return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "wait_stock", text: "Введите остаток", rows: [], preferMessageId: options.messageId });
  if (draft.step === "wait_description") return renderTelegramScreen({ supabase, chatId, companyId: draft.company_id, connection, screen: "wait_description", text: "Добавьте описание или нажмите Пропустить", rows: [[{ text: "Пропустить", callback_data: "desc:skip" }]], preferMessageId: options.messageId });
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
  await renderTelegramScreen({
    supabase,
    chatId,
    companyId: draft.company_id,
    connection: options.connection,
    screen: "draft_edit_menu",
    text: "Что изменить?",
    rows: [
    [
      { text: "Название", callback_data: "de:name" },
      { text: "Категория", callback_data: "de:category" },
    ],
    [
      { text: "Цена", callback_data: "de:price" },
      { text: "Остаток", callback_data: "de:stock" },
    ],
    [
      { text: "Описание", callback_data: "de:description" },
      { text: "Медиа", callback_data: "de:media" },
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
    await updateDraft(supabase, draft, { step: "choose_category" });
    return sendCategoryKeyboard(supabase, companyId, chatId, "Выберите категорию", { connection, messageId: options.messageId });
  }
  if (field === "media") {
    await updateDraft(supabase, draft, { step: "wait_media", media: [] });
    return renderTelegramScreen({ supabase, chatId, companyId, connection, screen: "wait_media", text: "Отправьте фото или видео", rows: [[{ text: "Пропустить медиа", callback_data: "media:skip" }]], preferMessageId: options.messageId });
  }
  await updateDraft(supabase, draft, { step: `wait_${field}` });
  const prompts: Record<string, string> = { name: "Введите название", price: "Введите цену", stock: "Введите остаток", description: "Добавьте описание или нажмите Пропустить" };
  return renderTelegramScreen({
    supabase,
    chatId,
    companyId,
    connection,
    screen: `wait_${field}`,
    text: prompts[field] ?? "Введите значение",
    rows: field === "description" ? [[{ text: "Пропустить", callback_data: "desc:skip" }]] : [],
    preferMessageId: options.messageId,
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
  const nextDraft = await updateDraft(supabase, draft, { custom_values: { ...(draft.custom_values ?? {}), [field.id]: value }, edit_field: null });
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
  if (options.callbackId) await answerCallbackQuery(options.callbackId, "Сохранено");
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
    if (options.callbackId) await answerCallbackQuery(options.callbackId, "Сохранено");
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
  if (options.callbackId) await answerCallbackQuery(options.callbackId, "Сохранено");
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
    const result = await showMainMenu(supabase, chatId, connection);
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
        if (nextConnection) return showMainMenu(supabase, chatId, nextConnection);
        return sendMessage(chatId, "Бот успешно подключён к компании.");
      }
      return sendMessage(chatId, "Код неверный или истёк. Сгенерируйте новый код в CRM.");
    }
    return sendMessage(chatId, media || text === "/addproduct" ? NOT_CONNECTED : "Отправьте код подключения из CRM.");
  }
  if (text === "/menu" || normalize(text) === normalize("Главное меню")) {
    const responseStartedAt = Date.now();
    const result = await showMainMenu(supabase, chatId, connection);
    logTiming("telegram response", responseStartedAt, chatId);
    logTiming("handle action menu", startedAt, chatId);
    return result;
  }
  if (text === "/help") return showHelp(supabase, chatId, { connection });
  if (text === "/cancel") {
    await clearDrafts(supabase, connection.company_id, chatId);
    return showCancelledMenu(supabase, chatId, connection);
  }
  if (text === "/find") return handleMenuAction(supabase, chatId, connection, "find");
  if (text === "/addproduct") return handleMenuAction(supabase, chatId, connection, "add");
  const draft = await getActiveDraft(supabase, connection.company_id, chatId);
  if (media) {
    if (!draft) return startAddWizard(supabase, chatId, connection, message);
    return handleDraftMedia(supabase, chatId, draft, message);
  }
  if (!draft) return showMainMenu(supabase, chatId, connection);
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
      const answerStartedAt = Date.now();
      await answerCallbackQuery(update.callback_query.id);
      callbackAnswered = true;
      logTiming("answer_callback", answerStartedAt, chatId);
    }
    if (isDuplicateUpdate(update)) {
      logTotalTiming(`duplicate ${String(action)}`, startedAt, chatId);
      return;
    }
    const supabase = getSupabaseAdmin();
    if (update.callback_query) await handleCallback(supabase, update.callback_query, callbackAnswered);
    else if (update.message) await handleMessage(supabase, update.message);
    logTiming(String(action), startedAt, chatId);
    logTotalTiming(String(action), startedAt, chatId);
  } catch (error) {
    logTelegramError("webhook_async", error, { action, chatId });
    logTiming("webhook_error", startedAt);
    logTotalTiming("webhook_error", startedAt);
    throw error;
  } finally {
    console.log("telegram async processing", { ms: Date.now() - startedAt });
  }
}

export function logTelegramWebhookParseError(error: unknown) {
  logTelegramError("webhook_parse", error);
}
