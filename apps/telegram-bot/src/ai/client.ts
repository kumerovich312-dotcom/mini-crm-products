import type { ProductAiAction, ProductAiInput } from "./productPrompts.js";
import { buildProductPrompt } from "./productPrompts.js";

export type ProductAiResult = {
  text: string;
  keywords: string[];
  categoryId: string | null;
  categoryName: string | null;
};

export class AiUnavailableError extends Error {
  constructor() {
    super("AI-функции пока не подключены.");
    this.name = "AiUnavailableError";
  }
}

function getOpenAiConfig() {
  const enabled = process.env.AI_ENABLED === "true";
  const apiKey = process.env.OPENAI_API_KEY;
  if (!enabled || !apiKey) throw new AiUnavailableError();
  return {
    apiKey,
    model: process.env.AI_TEXT_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini",
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("timeout") ||
    message.includes("aborted") ||
    message.includes("econnreset") ||
    message.includes("etimedout")
  );
}

async function requestOpenAiJson<T>(prompt: string, options: { model?: string; timeoutMs?: number; temperature?: number } = {}) {
  const { apiKey, model } = getOpenAiConfig();

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: options.model ?? model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Ты аккуратный AI-помощник для товарного каталога. Отвечай только валидным JSON." },
            { role: "user", content: prompt },
          ],
          ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        }),
        signal: controller.signal,
      });

      const body = await response.json() as {
        error?: { message?: string };
        choices?: Array<{ message?: { content?: string } }>;
      };
      if (!response.ok) throw new Error(body.error?.message || `OpenAI request failed with status ${response.status}`);

      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenAI returned empty response.");
      return JSON.parse(content) as T;
    } catch (error) {
      if (attempt < 2 && isRetryable(error)) {
        await sleep(500);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("OpenAI request failed.");
}

export async function generateProductAi(action: ProductAiAction, input: ProductAiInput): Promise<ProductAiResult> {
  const prompt = buildProductPrompt(action, input);
  const parsed = await requestOpenAiJson<Partial<ProductAiResult>>(prompt, { timeoutMs: 30000 });
  const result = {
    text: typeof parsed.text === "string" ? parsed.text.trim() : "",
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((item): item is string => typeof item === "string").slice(0, 12) : [],
    categoryId: typeof parsed.categoryId === "string" ? parsed.categoryId : null,
    categoryName: typeof parsed.categoryName === "string" ? parsed.categoryName : null,
  };
  if (!result.text && result.keywords.length === 0 && !result.categoryId) throw new Error("OpenAI returned empty result.");
  return result;
}

export async function transcribeAudio(input: { buffer: ArrayBuffer; fileName: string; contentType?: string }): Promise<string> {
  const { apiKey } = getOpenAiConfig();
  const model = process.env.AI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const form = new FormData();
      form.append("model", model);
      form.append("file", new Blob([input.buffer], { type: input.contentType || "application/octet-stream" }), input.fileName);

      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });

      const body = await response.json() as {
        error?: { message?: string };
        text?: string;
      };
      if (!response.ok) throw new Error(body.error?.message || `OpenAI transcription failed with status ${response.status}`);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) throw new Error("OpenAI returned empty transcription.");
      return text;
    } catch (error) {
      if (attempt < 2 && isRetryable(error)) {
        await sleep(500);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("OpenAI transcription failed.");
}

export { requestOpenAiJson };
