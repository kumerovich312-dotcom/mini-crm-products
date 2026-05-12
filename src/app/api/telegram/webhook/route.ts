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

function getMessageMedia(message: TelegramMessage) {
  const photo = message.photo?.[message.photo.length - 1] ?? null;
  const video = message.video ?? null;

  if (!photo && !video) {
    return null;
  }

  return {
    fileId: photo?.file_id ?? video?.file_id ?? "",
    mediaType: photo ? ("photo" as const) : ("video" as const),
  };
}

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

async function sendCategoryKeyboard(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  companyId: string,
  chatId: string,
  text = "Выберите категорию",
) {
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
    await sendMessage(chatId, "Сначала создайте категорию в CRM.");
    return;
  }

  await sendInlineKeyboard(
    chatId,
    text,
    categories.map((category) => [{ text: `${category.code} · ${category.name}`, callback_data: `cat:${category.id}` }]),
  );
}

async function createDraft(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string, chatId: string, step = "choose_category") {
  await supabase
    .from("telegram_product_drafts")
    .delete()
    .eq("company_id", companyId)
    .eq("telegram_chat_id", chatId)
    .neq("step", "done");

  const { data, error } = await supabase
    .from("telegram_product_drafts")
    .insert({
      company_id: companyId,
      telegram_chat_id: chatId,
      step,
      status: "draft",
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as TelegramProductDraft;
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
  nextStep = "wait_name",
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
      step: nextStep,
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

async function isSkuAvailable(supabase: ReturnType<typeof getSupabaseAdmin>, companyId: string, sku: string) {
  const { data, error } = await supabase.from("products").select("id").eq("company_id", companyId).eq("sku", sku);

  if (error) {
    throw error;
  }

  return !data || data.length === 0;
}

async function getDraftCompanyAndCategory(supabase: ReturnType<typeof getSupabaseAdmin>, draft: TelegramProductDraft) {
  if (!draft.category_id) {
    throw new Error("Категория не выбрана.");
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

  return { company, category };
}

async function saveDraftAsProduct(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  draft: TelegramProductDraft,
  preferredSku?: string,
) {
  if (!draft.category_id) {
    throw new Error("Категория не выбрана.");
  }

  if (!draft.name?.trim()) {
    throw new Error("Название товара не заполнено.");
  }

  const { company, category } = await getDraftCompanyAndCategory(supabase, draft);
  const sku =
    preferredSku && (await isSkuAvailable(supabase, draft.company_id, preferredSku))
      ? preferredSku
      : await buildUniqueSku(supabase, company, category);

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
    await sendMessage(
      chatId,
      "Сначала подключите бота. Откройте CRM → Настройки → Telegram-бот и отправьте сюда код подключения.",
    );
    return;
  }

  await createDraft(supabase, connection.company_id, chatId);
  await sendCategoryKeyboard(supabase, connection.company_id, chatId, "Выберите категорию");
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
    await sendMessage(
      chatId,
      "Сначала подключите бота. Откройте CRM → Настройки → Telegram-бот и отправьте сюда код подключения.",
    );
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

    const nextStep = draft.step === "edit_category" ? "preview" : (draft.media ?? []).length > 0 ? "wait_name" : "wait_media";
    const { data: updatedDraft, error } = await supabase
      .from("telegram_product_drafts")
      .update({
        category_id: category.id,
        step: nextStep,
      })
      .eq("id", draft.id)
      .eq("company_id", connection.company_id)
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    await answerCallbackQuery(callback.id, "Категория выбрана.");

    if (draft.step === "edit_category") {
      await sendPreview(supabase, chatId, updatedDraft as TelegramProductDraft);
      return;
    }

    await sendMessage(chatId, (draft.media ?? []).length > 0 ? "Введите название" : "Отправьте фото или видео");
    return;
  }

  if (data === "desc:skip") {
    await answerCallbackQuery(callback.id);
    await updateDraftAndPreview(supabase, chatId, draft, { description: null });
    return;
  }

  if (data === "draft:cancel") {
    await supabase.from("telegram_product_drafts").delete().eq("id", draft.id).eq("company_id", connection.company_id);
    await answerCallbackQuery(callback.id, "Отменено.");
    await sendMessage(chatId, "Отменено.");
    return;
  }

  if (data.startsWith("draft:save")) {
    const preferredSku = data.split(":")[2];
    const result = await saveDraftAsProduct(supabase, draft, preferredSku);
    await answerCallbackQuery(callback.id, "Сохранено.");
    await sendMessage(chatId, `Товар сохранён как черновик ✅ SKU: ${result.sku}\nПроверьте карточку в CRM перед публикацией.`);
    return;
  }

  if (data === "draft:edit") {
    await answerCallbackQuery(callback.id);
    await sendInlineKeyboard(chatId, "Что изменить?", [
      [
        { text: "Название", callback_data: "edit:name" },
        { text: "Категория", callback_data: "edit:category" },
      ],
      [
        { text: "Цена", callback_data: "edit:price" },
        { text: "Остаток", callback_data: "edit:stock" },
      ],
      [
        { text: "Описание", callback_data: "edit:description" },
        { text: "Медиа", callback_data: "edit:media" },
      ],
    ]);
    return;
  }

  if (data.startsWith("edit:")) {
    const field = data.slice(5);
    await answerCallbackQuery(callback.id);

    if (field === "category") {
      await supabase
        .from("telegram_product_drafts")
        .update({ step: "edit_category" })
        .eq("id", draft.id)
        .eq("company_id", connection.company_id);
      await sendCategoryKeyboard(supabase, connection.company_id, chatId, "Выберите категорию");
      return;
    }

    if (field === "media") {
      await supabase
        .from("telegram_product_drafts")
        .update({ step: "edit_media" })
        .eq("id", draft.id)
        .eq("company_id", connection.company_id);
      await sendMessage(chatId, "Отправьте фото или видео");
      return;
    }

    const stepByField: Record<string, string> = {
      name: "edit_name",
      price: "edit_price",
      stock: "edit_stock",
      description: "edit_description",
    };
    const promptByField: Record<string, string> = {
      name: "Введите название",
      price: "Введите цену",
      stock: "Введите остаток",
      description: "Добавьте описание или нажмите Пропустить",
    };
    const nextStep = stepByField[field];

    if (nextStep) {
      await supabase
        .from("telegram_product_drafts")
        .update({ step: nextStep })
        .eq("id", draft.id)
        .eq("company_id", connection.company_id);

      if (field === "description") {
        await sendInlineKeyboard(chatId, promptByField[field], [[{ text: "Пропустить", callback_data: "desc:skip" }]]);
      } else {
        await sendMessage(chatId, promptByField[field]);
      }
    }
    return;
  }

  await answerCallbackQuery(callback.id);
}

function buildPreview(category: Category | null, draft: TelegramProductDraft, sku: string) {
  return [
    "Проверьте товар",
    `Медиа: ${(draft.media ?? []).length} файлов`,
    `Категория: ${category ? `${category.code} · ${category.name}` : "не выбрана"}`,
    `Название: ${draft.name ?? ""}`,
    `Цена: ${draft.price ?? 0}`,
    `Остаток: ${draft.stock ?? 0}`,
    `Описание: ${draft.description || "—"}`,
    `Будущий SKU: ${sku}`,
  ].join("\n");
}

async function sendPreview(supabase: ReturnType<typeof getSupabaseAdmin>, chatId: string, draft: TelegramProductDraft) {
  const { company, category } = await getDraftCompanyAndCategory(supabase, draft);
  const previewSku = await buildUniqueSku(supabase, company, category);

  if (!previewSku) {
    await sendMessage(chatId, "Не удалось сгенерировать SKU. Попробуйте ещё раз.");
    return;
  }

  await sendInlineKeyboard(chatId, buildPreview(category, draft, previewSku), [
    [
      { text: "Сохранить", callback_data: `draft:save:${previewSku}` },
      { text: "Изменить", callback_data: "draft:edit" },
    ],
    [{ text: "Отмена", callback_data: "draft:cancel" }],
  ]);
}

async function updateDraftAndPreview(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chatId: string,
  draft: TelegramProductDraft,
  values: Record<string, unknown>,
) {
  const { data, error } = await supabase
    .from("telegram_product_drafts")
    .update({ ...values, step: "preview" })
    .eq("id", draft.id)
    .eq("company_id", draft.company_id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  await sendPreview(supabase, chatId, data as TelegramProductDraft);
}

async function handleDraftMessage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  message: TelegramMessage,
  chatId: string,
  connection: TelegramConnection,
) {
  const draft = await getActiveDraft(supabase, connection.company_id, chatId);
  const media = getMessageMedia(message);

  if (!draft) {
    if (!media) {
      await sendMessage(chatId, "Отправьте фото или видео товара.");
      return;
    }

    const nextDraft = await createDraft(supabase, connection.company_id, chatId);

    try {
      await uploadTelegramMedia(supabase, nextDraft, media.fileId, media.mediaType, "choose_category");
    } catch {
      await sendMessage(chatId, "Не смог загрузить фото. Попробуйте ещё раз.");
      return;
    }

    await sendCategoryKeyboard(supabase, connection.company_id, chatId, "Фото получил ✅ Выберите категорию товара:");
    return;
  }

  if (draft.step === "choose_category") {
    if (media) {
      try {
        await uploadTelegramMedia(supabase, draft, media.fileId, media.mediaType, "choose_category");
      } catch {
        await sendMessage(chatId, "Не смог загрузить фото. Попробуйте ещё раз.");
        return;
      }
    }

    await sendCategoryKeyboard(supabase, connection.company_id, chatId, "Выберите категорию");
    return;
  }

  if (draft.step === "wait_media" || draft.step === "edit_media") {
    if (!media) {
      await sendMessage(chatId, "Отправьте фото или видео");
      return;
    }

    try {
      await uploadTelegramMedia(supabase, draft, media.fileId, media.mediaType, draft.step === "edit_media" ? "preview" : "wait_name");
    } catch {
      await sendMessage(chatId, "Не смог загрузить фото. Попробуйте ещё раз.");
      return;
    }

    if (draft.step === "edit_media") {
      const nextDraft = await getActiveDraft(supabase, connection.company_id, chatId);

      if (nextDraft) {
        await sendPreview(supabase, chatId, nextDraft);
      }
      return;
    }

    await sendMessage(chatId, "Введите название");
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

    await sendMessage(chatId, "Введите цену");
    return;
  }

  if (draft.step === "wait_price") {
    const price = parsePrice(text);

    if (price === null) {
      await sendMessage(chatId, "Введите цену числом.");
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

    await sendMessage(chatId, "Введите остаток");
    return;
  }

  if (draft.step === "wait_stock") {
    const stock = parseStock(text);

    if (stock === null) {
      await sendMessage(chatId, "Введите остаток целым числом.");
      return;
    }

    const { error } = await supabase
      .from("telegram_product_drafts")
      .update({ stock, step: "optional_description" })
      .eq("id", draft.id)
      .eq("company_id", connection.company_id);

    if (error) {
      throw error;
    }

    await sendInlineKeyboard(chatId, "Добавьте описание или нажмите Пропустить", [[{ text: "Пропустить", callback_data: "desc:skip" }]]);
    return;
  }

  if (draft.step === "optional_description") {
    const { data, error } = await supabase
      .from("telegram_product_drafts")
      .update({ description: text, step: "preview" })
      .eq("id", draft.id)
      .eq("company_id", connection.company_id)
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    await sendPreview(supabase, chatId, data as TelegramProductDraft);
    return;
  }

  if (draft.step === "edit_name") {
    await updateDraftAndPreview(supabase, chatId, draft, { name: text });
    return;
  }

  if (draft.step === "edit_price") {
    const price = parsePrice(text);

    if (price === null) {
      await sendMessage(chatId, "Введите цену числом.");
      return;
    }

    await updateDraftAndPreview(supabase, chatId, draft, { price });
    return;
  }

  if (draft.step === "edit_stock") {
    const stock = parseStock(text);

    if (stock === null) {
      await sendMessage(chatId, "Введите остаток целым числом.");
      return;
    }

    await updateDraftAndPreview(supabase, chatId, draft, { stock });
    return;
  }

  if (draft.step === "edit_description") {
    await updateDraftAndPreview(supabase, chatId, draft, { description: text });
    return;
  }

  if (draft.step === "preview") {
    await sendMessage(chatId, "Нажмите кнопку под предпросмотром.");
    return;
  }

  await sendMessage(chatId, "Отправьте фото или видео товара.");
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

    await sendMessage(
      chatId,
      "Сначала подключите бота. Откройте CRM → Настройки → Telegram-бот и отправьте сюда код подключения.",
    );
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
