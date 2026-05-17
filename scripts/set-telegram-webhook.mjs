import dns from "node:dns";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

dns.setDefaultResultOrder("ipv4first");

const WEBHOOK_URL = "https://serenebot.ru/telegram/webhook";
const ENV_PATH = resolve(process.cwd(), ".env.local");
const RETRY_DELAYS_MS = [1000, 3000, 5000, 10000, 15000];

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function loadEnv() {
  const fileEnv = parseEnv(await readFile(ENV_PATH, "utf8"));
  return { ...fileEnv, ...process.env };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function errorCause(error) {
  return error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
}

async function telegramFetch(token, method, payload, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(async () => ({ raw: await response.text() }));
    if (!response.ok || !body.ok) {
      const error = new Error(body.description ?? `Telegram ${method} failed`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function withRetry(label, fn) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      console.log("telegram webhook setup", { label, attempt });
      return await fn();
    } catch (error) {
      lastError = error;
      console.warn("telegram webhook setup retry", {
        label,
        attempt,
        status: error?.status,
        message: error instanceof Error ? error.message : String(error),
        cause: errorCause(error),
      });
      if (attempt < 5) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1));
    }
  }
  throw lastError;
}

const env = await loadEnv();
const token = env.TELEGRAM_BOT_TOKEN;
const secret = env.TELEGRAM_WEBHOOK_SECRET;

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing in .env.local or process env.");
if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET is missing in .env.local or process env.");

await withRetry("setWebhook", () => telegramFetch(token, "setWebhook", {
  url: WEBHOOK_URL,
  secret_token: secret,
  drop_pending_updates: true,
}));

const info = await withRetry("getWebhookInfo", () => telegramFetch(token, "getWebhookInfo", {}));
console.log("telegram webhook info", JSON.stringify(info, null, 2));
