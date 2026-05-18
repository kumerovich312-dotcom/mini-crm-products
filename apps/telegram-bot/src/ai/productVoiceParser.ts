import { requestOpenAiJson } from "./client.js";

export type VoiceParserCategory = {
  id: string;
  name: string;
  code: string;
};

export type VoiceDraftContext = {
  title?: string | null;
  categoryName?: string | null;
  price?: number | null;
  stock?: number | null;
  description?: string | null;
  weight?: string | null;
  attributes?: Record<string, string>;
  keywords?: string[];
};

export type ProductVoiceParseResult = {
  title: string | null;
  categoryName: string | null;
  price: number | null;
  stock: number | null;
  description: string | null;
  weight: string | null;
  attributes: Record<string, string>;
  keywords: string[];
  confidence: {
    title: number;
    category: number;
    price: number;
    stock: number;
  };
  missingRequiredFields: string[];
};

function clampConfidence(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(",", ".").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeAttributes(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .flatMap(([key, item]) => {
        const text = normalizeString(item);
        return key.trim() && text ? [[key.trim(), text]] : [];
      })
      .slice(0, 20),
  );
}

function buildPrompt(transcript: string, categories: VoiceParserCategory[], currentDraft?: VoiceDraftContext | null) {
  const categoryLines = categories.length
    ? categories.map((category) => `${category.code} | ${category.name}`).join("\n")
    : "Категорий нет.";
  const current = currentDraft
    ? [
      `Название: ${currentDraft.title || "не указано"}`,
      `Категория: ${currentDraft.categoryName || "не указана"}`,
      `Цена: ${currentDraft.price ?? "не указана"}`,
      `Остаток: ${currentDraft.stock ?? "не указан"}`,
      `Вес: ${currentDraft.weight || "не указан"}`,
      `Описание: ${currentDraft.description || "не указано"}`,
      `Keywords: ${currentDraft.keywords?.length ? currentDraft.keywords.join(", ") : "не указаны"}`,
      `Атрибуты: ${JSON.stringify(currentDraft.attributes ?? {})}`,
    ].join("\n")
    : "Черновик пустой.";

  return [
    "Ты извлекаешь поля товара из голосовой расшифровки для Telegram-бота товарной CRM.",
    "Язык: русский.",
    "Не выдумывай факты. Если поле не названо явно или не следует из текста уверенно, верни null.",
    "Если пользователь просит изменить уже заполненное поле, верни новое значение только для этого поля.",
    "Цена '5 тысяч' означает 5000. 'Один в наличии' означает stock = 1.",
    "Если названа валюта, число положи в price, а валюту добавь в attributes.currency или в описание.",
    "Характеристики вроде цвет, размер, пробег, состояние, материал положи в attributes.",
    "Описание сделай аккуратным продающим текстом только на основе сказанного.",
    "Категорию выбирай только из доступных категорий. Если уверенность низкая, верни categoryName null.",
    "",
    "Текущий черновик:",
    current,
    "",
    "Доступные категории:",
    categoryLines,
    "",
    "Расшифровка:",
    transcript,
    "",
    "Верни только JSON без markdown.",
    "Формат:",
    '{"title":null,"categoryName":null,"price":null,"stock":null,"description":null,"weight":null,"attributes":{},"keywords":[],"confidence":{"title":0,"category":0,"price":0,"stock":0},"missingRequiredFields":[]}',
  ].join("\n");
}

export async function parseProductVoiceTranscript(
  transcript: string,
  categories: VoiceParserCategory[],
  currentDraft?: VoiceDraftContext | null,
): Promise<ProductVoiceParseResult> {
  const parsed = await requestOpenAiJson<Partial<ProductVoiceParseResult>>(buildPrompt(transcript, categories, currentDraft), {
    timeoutMs: 30000,
  });
  const confidence = parsed.confidence ?? { title: 0, category: 0, price: 0, stock: 0 };
  return {
    title: normalizeString(parsed.title),
    categoryName: normalizeString(parsed.categoryName),
    price: normalizeNumber(parsed.price),
    stock: normalizeNumber(parsed.stock),
    description: normalizeString(parsed.description),
    weight: normalizeString(parsed.weight),
    attributes: normalizeAttributes(parsed.attributes),
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 12) : [],
    confidence: {
      title: clampConfidence(confidence.title),
      category: clampConfidence(confidence.category),
      price: clampConfidence(confidence.price),
      stock: clampConfidence(confidence.stock),
    },
    missingRequiredFields: Array.isArray(parsed.missingRequiredFields)
      ? parsed.missingRequiredFields.filter((item): item is string => typeof item === "string")
      : [],
  };
}
