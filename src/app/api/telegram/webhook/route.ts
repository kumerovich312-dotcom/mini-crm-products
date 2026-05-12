import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { createId } from "@/lib/create-id";
import { getErrorMessage } from "@/lib/errors";
import type { Category, Company } from "@/types/database";

const MEDIA_BUCKET = "product-media";

type TelegramUser = {
  id: number;
  username?: string;
};

type TelegramChat = {
  id: number;
};

type TelegramPhotoSize = {
  file_id: string;
  file_size?: number;
};

type TelegramVideo = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  photo?: TelegramPhotoSize[];
  video?: TelegramVideo;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

type TelegramUpdate = {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramConnection = {
  id: string;
  company_id: string;
  telegram_chat_id: string;
  telegram_user_id: string | null;
  telegram_username: string | null;
  is_active: boolean;
};

type DraftMedia = {
  media_type: "photo" | "video";
  file_name: string;
  file_path: string;
  public_url: string;
  file_size_bytes: number | null;
};

type TelegramProductDraft = {
  id: string;
  company_id: string;
  telegram_chat_id: string;
  step: string;
  category_id: string | null;
  name: string | null;
  price: number;
  stock: number;
  description: string | null;
  keywords: string[];
  media: DraftMedia[];
  created_product_id: string | null;
  status: string;
};

type InlineButton = {
  text: string;
  callback_data: string;
};

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase admin env variables are missing.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function getTelegramToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing.");
  }

  return token;
}

function logTelegramError(stage: string, error: unknown, details?: Record<string, unknown>) {
  console.error("Telegram connection error", {
    stage,
    message: getErrorMessage(error),
    details,
  });
}

async function telegramApi<T>(method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${getTelegramToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as { ok: boolean; result?: T; description?: string };

  if (!response.ok || !body.ok) {
    throw new Error(body.description ?? `Telegram API ${method} failed`);
  }

  return body.result as T;
}

async function sendMessage(chatId: string, text: string, replyMarkup?: Record<string, unknown>) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
  });
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  return telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

function inlineKeyboard(rows: InlineButton[][]) {
  return {
    inline_keyboard: rows,
  };
}

async function sendInlineKeyboard(chatId: string, text: string, rows: InlineButton[][]) {
  return sendMessage(chatId, text, inlineKeyboard(rows));
}

async function downloadTelegramFile(fileId: string) {
  const file = await telegramApi<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });

  if (!file.file_path) {
    throw new Error("Telegram did not return file_path.");
  }

  const response = await fetch(`https://api.telegram.org/file/bot${getTelegramToken()}/${file.file_path}`);

  if (!response.ok) {
    throw new Error(`Telegram file download failed with status ${response.status}.`);
  }

  return {
    buffer: await response.arrayBuffer(),
    filePath: file.file_path,
    fileSize: file.file_size ?? null,
    contentType: response.headers.get("content-type") ?? undefined,
  };
}

function shortId() {
  return createId().replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 6);
}

function getExtension(filePath: string, fallback: string) {
  const cleanPath = filePath.split("?")[0] ?? "";
  const dotIndex = cleanPath.lastIndexOf(".");

  if (dotIndex === -1) {
    return fallback;
  }

  return cleanPath.slice(dotIndex).toLowerCase();
}

function generateSkuDigits(length: number) {
  const max = 10 ** length;

  return Math.floor(Math.random() * max)
    .toString()
    .padStart(length, "0");
}

async function getConnection(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string) {
  const { data, error } = await supabase
    .from("telegram_connections")
    .select("*")
    .eq("telegram_chat_id", chatId)
    .eq("is_active", true)
    .limit(1);

  if (error) {
    throw error;
  }

  return ((data?.[0] ?? null) as TelegramConnection | null) ?? null;
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

  if (error) {
    throw error;
  }

  return ((data?.[0] ?? null) as TelegramProductDraft | null) ?? null;
}

async function getCategory(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string, categoryId: string) {
  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .eq("company_id", companyId)
    .eq("id", categoryId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as Category | null) ?? null;
}

async function sendCategoryKeyboard(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string, chatId: string) {
  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    throw error;
  }

  const categories = ((data ?? []) as Category[]) ?? [];

  if (categories.length === 0) {
    await sendMessage(chatId, "В компании пока нет категорий. Создайте категорию в CRM и повторите /addproduct.");
    return;
  }

  await sendInlineKeyboard(
    chatId,
    "Выберите категорию товара:",
    categories.map((category) => [{ text: `${category.code} · ${category.name}`, callback_data: `cat:${category.id}` }]),
  );
}

async function connectByCode(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  user: TelegramUser | undefined,
  code: string,
) {
  const { data: codeData, error: codeError } = await supabase
    .from("telegram_connection_codes")
    .select("id, company_id, expires_at, used_at")
    .eq("code", code)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (codeError) {
    throw codeError;
  }

  if (!codeData) {
    return false;
  }

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

  if (error) {
    throw error;
  }

  const { error: codeUpdateError } = await supabase
    .from("telegram_connection_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("id", codeData.id);

  if (codeUpdateError) {
    throw codeUpdateError;
  }

  return true;
}

async function uploadTelegramMedia(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  draft: TelegramProductDraft,
  fileId: string,
  mediaType: "photo" | "video",
) {
  let downloaded: Awaited<ReturnType<typeof downloadTelegramFile>>;

  try {
    downloaded = await downloadTelegramFile(fileId);
  } catch (error) {
    logTelegramError("telegram_file_download", error, { companyId: draft.company_id, draftId: draft.id, mediaType });
    throw error;
  }

  const extension = getExtension(downloaded.filePath, mediaType === "photo" ? ".jpg" : ".mp4");
  const fileName = `draft-${shortId()}${extension}`;
  const storagePath = `${draft.company_id}/telegram-drafts/${draft.id}/${fileName}`;
  const { error: uploadError } = await supabase.storage.from(MEDIA_BUCKET).upload(storagePath, downloaded.buffer, {
    contentType: downloaded.contentType,
    upsert: false,
  });

  if (uploadError) {
    logTelegramError("storage_upload", uploadError, { bucket: MEDIA_BUCKET, path: storagePath, mediaType });
    throw uploadError;
  }

  const { data: publicUrlData } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(storagePath);
  const media: DraftMedia = {
    media_type: mediaType,
    file_name: fileName,
    file_path: storagePath,
    public_url: publicUrlData.publicUrl,
    file_size_bytes: downloaded.fileSize,
  };

  const nextMedia = [...(draft.media ?? []), media];
  const { error } = await supabase
    .from("telegram_product_drafts")
    .update({
      media: nextMedia,
      step: "wait_name",
    })
    .eq("id", draft.id)
    .eq("company_id", draft.company_id);

  if (error) {
    logTelegramError("telegram_draft_media_update", error, { draftId: draft.id, companyId: draft.company_id });
    throw error;
  }
}

async function buildUniqueSku(supabase: ReturnType<typeof getSupabaseAdmin>, company: Company, category: Category) {
  const randomDigits = company.sku_random_digits ?? 4;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sku = `${company.sku_prefix}-${category.code}-${generateSkuDigits(randomDigits)}`.toUpperCase();
    const { data, error } = await supabase
      .from("products")
      .select("id")
      .eq("company_id", company.id)
      .eq("sku", sku);

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return sku;
    }
  }

  return null;
}

async function saveDraftAsProduct(supabase: ReturnType<typeof getSupabaseAdmin>, draft: TelegramProductDraft) {
  if (!draft.category_id) {
    throw new Error("Категория не выбрана.");
  }

  if (!draft.name?.trim()) {
    throw new Error("Название товара не заполнено.");
  }

  const [{ data: companyData, error: companyError }, { data: categoryData, error: categoryError }] = await Promise.all([
    supabase.from("companies").select("*").eq("id", draft.company_id).maybeSingle(),
    supabase.from("categories").select("*").eq("company_id", draft.company_id).eq("id", draft.category_id).maybeSingle(),
  ]);

  if (companyError) {
    throw companyError;
  }

  if (categoryError) {
    throw categoryError;
  }

  const company = companyData as Company | null;
  const category = categoryData as Category | null;

  if (!company || !category) {
    throw new Error("Компания или категория не найдены.");
  }

  const sku = await buildUniqueSku(supabase, company, category);

  if (!sku) {
    throw new Error("Не удалось сгенерировать уникальный артикул, попробуйте ещё раз.");
  }

  const { data: productData, error: productError } = await supabase
    .from("products")
    .insert({
      company_id: draft.company_id,
      category_id: draft.category_id,
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

  if (productError) {
    logTelegramError("product_insert", productError, { companyId: draft.company_id, draftId: draft.id });
    throw productError;
  }

  const productId = productData.id as string;
  const mediaRows = (draft.media ?? []).map((item, index) => ({
    company_id: draft.company_id,
    product_id: productId,
    media_type: item.media_type,
    original_url: item.public_url,
    processed_url: item.public_url,
    thumbnail_url: item.media_type === "photo" ? item.public_url : null,
    file_name: item.file_name,
    file_size_bytes: item.file_size_bytes,
    status: "ready",
    sort_order: index,
  }));

  if (mediaRows.length > 0) {
    const { error: mediaError } = await supabase.from("product_media").insert(mediaRows);

    if (mediaError) {
      logTelegramError("product_media_insert", mediaError, {
        companyId: draft.company_id,
        productId,
        mediaCount: mediaRows.length,
      });
      throw mediaError;
    }
  }

  const { error: draftError } = await supabase
    .from("telegram_product_drafts")
    .update({
      created_product_id: productId,
      step: "done",
    })
    .eq("id", draft.id)
    .eq("company_id", draft.company_id);

  if (draftError) {
    logTelegramError("telegram_draft_done_update", draftError, { draftId: draft.id, productId });
    throw draftError;
  }

  return { sku, productId };
}

function parsePrice(value: string) {
  const normalized = value.replace(",", ".").trim();
  const price = Number(normalized);

  return Number.isFinite(price) && price >= 0 ? price : null;
}

function parseStock(value: string) {
  const stock = Number(value.trim());

  return Number.isInteger(stock) && stock >= 0 ? stock : null;
}

async function handleStart(supabase: ReturnType<typeof getSupabaseAdmin>, message: TelegramMessage, chatId: string) {
  const connection = await getConnection(supabase, chatId);

  if (connection) {
    await sendMessage(chatId, "Бот уже подключён к компании.");
    return;
  }

  await sendMessage(chatId, "Отправьте код подключения из CRM.");
}

async function handleAddProduct(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string) {
  const connection = await getConnection(supabase, chatId);

  if (!connection) {
    await sendMessage(chatId, "Сначала подключите бота в настройках CRM.");
    return;
  }

  await sendMessage(chatId, "Добавление товара скоро будет доступно.");
}

async function handleStatus(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string) {
  const connection = await getConnection(supabase, chatId);

  await sendMessage(chatId, connection ? "Бот подключён к компании." : "Бот не подключён. Отправьте код из CRM.");
}

async function handleDisconnect(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string) {
  const { error } = await supabase
    .from("telegram_connections")
    .update({ is_active: false })
    .eq("telegram_chat_id", chatId)
    .eq("is_active", true);

  if (error) {
    throw error;
  }

  await sendMessage(chatId, "Бот отключён от компании.");
}

async function handleCancel(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string) {
  const connection = await getConnection(supabase, chatId);

  if (connection) {
    await supabase
      .from("telegram_product_drafts")
      .delete()
      .eq("company_id", connection.company_id)
      .eq("telegram_chat_id", chatId)
      .neq("step", "done");
  }

  await sendMessage(chatId, "Добавление товара отменено.");
}

async function handleCallback(supabase: ReturnType<typeof getSupabaseAdmin>, callback: TelegramCallbackQuery) {
  const chatId = callback.message?.chat.id ? String(callback.message.chat.id) : "";
  const data = callback.data ?? "";

  if (!chatId) {
    await answerCallbackQuery(callback.id, "Чат не найден.");
    return;
  }

  const connection = await getConnection(supabase, chatId);

  if (!connection) {
    await answerCallbackQuery(callback.id, "Сначала подключите бота.");
    await sendMessage(chatId, "Сначала подключите бота в настройках CRM.");
    return;
  }

  const draft = await getActiveDraft(supabase, connection.company_id, chatId);

  if (!draft) {
    await answerCallbackQuery(callback.id, "Черновик не найден.");
    await sendMessage(chatId, "Начните заново командой /addproduct.");
    return;
  }

  if (data.startsWith("cat:")) {
    const categoryId = data.slice(4);
    const category = await getCategory(supabase, connection.company_id, categoryId);

    if (!category) {
      await answerCallbackQuery(callback.id, "Категория не найдена.");
      await sendMessage(chatId, "Категория не найдена. Запустите /addproduct ещё раз.");
      return;
    }

    const { error } = await supabase
      .from("telegram_product_drafts")
      .update({
        category_id: category.id,
        step: "wait_media",
      })
      .eq("id", draft.id)
      .eq("company_id", connection.company_id);

    if (error) {
      throw error;
    }

    await answerCallbackQuery(callback.id, "Категория выбрана.");
    await sendMessage(chatId, "Отправьте фото или видео товара.");
    return;
  }

  if (data === "draft:cancel") {
    await supabase.from("telegram_product_drafts").delete().eq("id", draft.id).eq("company_id", connection.company_id);
    await answerCallbackQuery(callback.id, "Отменено.");
    await sendMessage(chatId, "Отменено.");
    return;
  }

  if (data === "draft:save") {
    const result = await saveDraftAsProduct(supabase, draft);
    await answerCallbackQuery(callback.id, "Сохранено.");
    await sendMessage(chatId, `Товар сохранён как черновик: SKU ${result.sku}`);
    return;
  }

  await answerCallbackQuery(callback.id);
}

function buildPreview(category: Category | null, draft: TelegramProductDraft) {
  return [
    "Проверьте товар:",
    `Категория: ${category ? `${category.code} · ${category.name}` : "не выбрана"}`,
    `Название: ${draft.name ?? ""}`,
    `Цена: ${draft.price ?? 0}`,
    `Остаток: ${draft.stock ?? 0}`,
    `Описание: ${draft.description ?? ""}`,
    `Медиа: ${(draft.media ?? []).length}`,
  ].join("\n");
}

async function handleDraftMessage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  message: TelegramMessage,
  chatId: string,
  connection: TelegramConnection,
) {
  const draft = await getActiveDraft(supabase, connection.company_id, chatId);

  if (!draft) {
    await sendMessage(chatId, "Отправьте /addproduct, чтобы начать добавление товара.");
    return;
  }

  if (draft.step === "choose_category") {
    await sendCategoryKeyboard(supabase, connection.company_id, chatId);
    return;
  }

  if (draft.step === "wait_media") {
    const photo = message.photo?.[message.photo.length - 1] ?? null;
    const video = message.video ?? null;

    if (!photo && !video) {
      await sendMessage(chatId, "Отправьте фото или видео товара.");
      return;
    }

    await uploadTelegramMedia(supabase, draft, photo?.file_id ?? video?.file_id ?? "", photo ? "photo" : "video");
    await sendMessage(chatId, "Медиа загружено. Теперь отправьте название товара.");
    return;
  }

  const text = message.text?.trim() ?? "";

  if (!text) {
    await sendMessage(chatId, "Отправьте текстовое значение для текущего шага.");
    return;
  }

  if (draft.step === "wait_name") {
    const { error } = await supabase
      .from("telegram_product_drafts")
      .update({ name: text, step: "wait_price" })
      .eq("id", draft.id)
      .eq("company_id", connection.company_id);

    if (error) {
      throw error;
    }

    await sendMessage(chatId, "Укажите цену товара.");
    return;
  }

  if (draft.step === "wait_price") {
    const price = parsePrice(text);

    if (price === null) {
      await sendMessage(chatId, "Цена должна быть числом. Например: 2500");
      return;
    }

    const { error } = await supabase
      .from("telegram_product_drafts")
      .update({ price, step: "wait_stock" })
      .eq("id", draft.id)
      .eq("company_id", connection.company_id);

    if (error) {
      throw error;
    }

    await sendMessage(chatId, "Укажите остаток товара числом.");
    return;
  }

  if (draft.step === "wait_stock") {
    const stock = parseStock(text);

    if (stock === null) {
      await sendMessage(chatId, "Остаток должен быть целым числом. Например: 3");
      return;
    }

    const { error } = await supabase
      .from("telegram_product_drafts")
      .update({ stock, step: "wait_description" })
      .eq("id", draft.id)
      .eq("company_id", connection.company_id);

    if (error) {
      throw error;
    }

    await sendMessage(chatId, "Добавьте описание товара.");
    return;
  }

  if (draft.step === "wait_description") {
    const { data, error } = await supabase
      .from("telegram_product_drafts")
      .update({ description: text, step: "confirm" })
      .eq("id", draft.id)
      .eq("company_id", connection.company_id)
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    const nextDraft = data as TelegramProductDraft;
    const category = nextDraft.category_id ? await getCategory(supabase, connection.company_id, nextDraft.category_id) : null;
    await sendInlineKeyboard(chatId, buildPreview(category, nextDraft), [
      [
        { text: "Сохранить", callback_data: "draft:save" },
        { text: "Отменить", callback_data: "draft:cancel" },
      ],
    ]);
    return;
  }

  if (draft.step === "confirm") {
    await sendMessage(chatId, "Нажмите “Сохранить” или “Отменить” под предпросмотром.");
    return;
  }

  await sendMessage(chatId, "Начните добавление товара командой /addproduct.");
}

async function handleMessage(supabase: ReturnType<typeof getSupabaseAdmin>, message: TelegramMessage) {
  const chatId = String(message.chat.id);
  const text = message.text?.trim() ?? "";

  if (text === "/start") {
    await handleStart(supabase, message, chatId);
    return;
  }

  if (text === "/addproduct") {
    await handleAddProduct(supabase, chatId);
    return;
  }

  if (text === "/cancel") {
    await handleCancel(supabase, chatId);
    return;
  }

  if (text === "/status") {
    await handleStatus(supabase, chatId);
    return;
  }

  if (text === "/disconnect") {
    await handleDisconnect(supabase, chatId);
    return;
  }

  const connection = await getConnection(supabase, chatId);

  if (!connection) {
    if (/^[0-9]{5,6}$/.test(text)) {
      const connected = await connectByCode(supabase, chatId, message.from, text);
      await sendMessage(
        chatId,
        connected ? "Бот успешно подключён к компании." : "Код неверный или истёк. Сгенерируйте новый код в CRM.",
      );
      return;
    }

    await sendMessage(chatId, "Сначала подключите бота в настройках CRM.");
    return;
  }

  await handleDraftMessage(supabase, message, chatId, connection);
}

export async function POST(request: Request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const actualSecret = request.headers.get("x-telegram-bot-api-secret-token");

  if (!expectedSecret || actualSecret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const update = (await request.json()) as TelegramUpdate;
    const supabase = getSupabaseAdmin();

    if (update.callback_query) {
      await handleCallback(supabase, update.callback_query);
    } else if (update.message) {
      await handleMessage(supabase, update.message);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logTelegramError("webhook", error);

    return NextResponse.json({ ok: true });
  }
}
