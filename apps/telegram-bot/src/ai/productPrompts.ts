export type ProductAiAction =
  | "improve_description"
  | "write_description"
  | "improve_name"
  | "generate_keywords"
  | "suggest_category";

export type ProductAiInput = {
  name: string;
  sku: string;
  category: string | null;
  price: number;
  stock: number;
  description: string | null;
  keywords: string[];
  categories: Array<{ id: string; name: string; code: string }>;
};

const actionInstructions: Record<ProductAiAction, string> = {
  improve_description: "Улучши текущее описание товара. Сохрани факты, не выдумывай характеристики.",
  write_description: "Напиши описание товара с нуля на основе доступных данных.",
  improve_name: "Улучши название товара. Сделай его понятным и пригодным для каталога.",
  generate_keywords: "Сгенерируй ключевые слова для поиска товара.",
  suggest_category: "Предложи одну наиболее подходящую категорию из списка.",
};

export function buildProductPrompt(action: ProductAiAction, input: ProductAiInput) {
  const categories = input.categories.length
    ? input.categories.map((category) => `${category.id} | ${category.code} | ${category.name}`).join("\n")
    : "Категорий нет.";

  return [
    "Ты помогаешь малому бизнесу заполнять карточку товара в каталоге.",
    "Язык ответа: русский.",
    "Стиль: простой, понятный, для Telegram/каталога.",
    "Пиши продающе, но без вранья. Не выдумывай характеристики, которых нет в данных.",
    "Если данных мало, используй универсальную аккуратную формулировку.",
    "",
    `Задача: ${actionInstructions[action]}`,
    "",
    "Товар:",
    `Название: ${input.name || "не указано"}`,
    `SKU: ${input.sku || "не указан"}`,
    `Категория: ${input.category || "не указана"}`,
    `Цена: ${Number.isFinite(input.price) ? input.price : 0}`,
    `Остаток: ${Number.isFinite(input.stock) ? input.stock : 0}`,
    `Описание: ${input.description || "не указано"}`,
    `Ключевые слова: ${input.keywords.length ? input.keywords.join(", ") : "не указаны"}`,
    "",
    "Доступные категории:",
    categories,
    "",
    "Верни только JSON без markdown.",
    "Формат:",
    '{"text":"основной результат","keywords":["слово"],"categoryId":"id категории или null","categoryName":"название категории или null"}',
  ].join("\n");
}
