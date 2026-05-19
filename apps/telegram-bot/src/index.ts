import dns from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";
import "dotenv/config";
import Fastify from "fastify";
import { checkRateLimit } from "./rateLimit.js";
import type { TelegramUpdate } from "./telegram/types.js";

dns.setDefaultResultOrder("ipv4first");
setGlobalDispatcher(new Agent({
  connect: {
    timeout: 3000,
  },
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 120000,
}));

const TELEGRAM_WEBHOOK_RATE_LIMIT = 600;
const TELEGRAM_WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000;
const TELEGRAM_WEBHOOK_AUTH_FAIL_RATE_LIMIT = 30;
const TELEGRAM_WEBHOOK_AUTH_FAIL_RATE_LIMIT_WINDOW_MS = 60_000;

const app = Fastify({ logger: false, trustProxy: true });

app.post<{ Body: TelegramUpdate }>("/telegram/webhook", async (request, reply) => {
  const startedAt = Date.now();
  const clientIp = request.ip || "unknown";
  const webhookRateLimit = checkRateLimit(
    `telegram-webhook:${clientIp}`,
    TELEGRAM_WEBHOOK_RATE_LIMIT,
    TELEGRAM_WEBHOOK_RATE_LIMIT_WINDOW_MS,
  );

  if (!webhookRateLimit.allowed) {
    return reply
      .code(429)
      .header("Retry-After", String(webhookRateLimit.retryAfterSec))
      .send({ error: "Too many requests" });
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const actualSecret = request.headers["x-telegram-bot-api-secret-token"];

  if (!expectedSecret || actualSecret !== expectedSecret) {
    const authFailRateLimit = checkRateLimit(
      `telegram-webhook-auth-fail:${clientIp}`,
      TELEGRAM_WEBHOOK_AUTH_FAIL_RATE_LIMIT,
      TELEGRAM_WEBHOOK_AUTH_FAIL_RATE_LIMIT_WINDOW_MS,
    );
    if (!authFailRateLimit.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(authFailRateLimit.retryAfterSec))
        .send({ error: "Too many requests" });
    }
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const update = request.body;
  setImmediate(() => {
    processUpdateAsync(update).catch((error: unknown) => {
      console.error("Telegram bot async import error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });

  console.log("telegram webhook fast response", { ms: Date.now() - startedAt });
  return reply.send({ ok: true });
});

const port = Number(process.env.PORT || 3100);
const host = process.env.BOT_HOST ?? "127.0.0.1";
const warmupEnabled = process.env.ENABLE_BOT_WARMUP === "true";
const warmupDebug = process.env.BOT_WARMUP_DEBUG === "true";

async function processUpdateAsync(update: TelegramUpdate) {
  const { logTelegramWebhookParseError, processTelegramUpdate } = await import("./bot/handler.js");
  try {
    await processTelegramUpdate(update);
  } catch (error: unknown) {
    logTelegramWebhookParseError(error);
    console.error(error);
  }
}

function startWarmup() {
  if (!warmupEnabled) return;

  const warmupTelegram = async () => {
    const startedAt = Date.now();
    try {
      const { getTelegramMe } = await import("./telegram/api.js");
      await getTelegramMe();
      if (warmupDebug) console.debug("telegram warmup", { target: "telegram", ms: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("telegram warmup failed", { target: "telegram", message });
    }
  };

  const warmupSupabase = async () => {
    const startedAt = Date.now();
    try {
      const { getSupabaseAdmin } = await import("./supabase/admin.js");
      const { error } = await getSupabaseAdmin().from("telegram_connections").select("id").limit(1);
      if (error) throw error;
      if (warmupDebug) console.debug("telegram warmup", { target: "supabase", ms: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("telegram warmup failed", { target: "supabase", message });
    }
  };

  setInterval(() => void warmupTelegram(), 45_000).unref();
  setInterval(() => void warmupSupabase(), 60_000).unref();
  setTimeout(() => void warmupTelegram(), 1000).unref();
  setTimeout(() => void warmupSupabase(), 1500).unref();
}

function preloadRuntimeModules() {
  setTimeout(() => {
    Promise.all([
      import("./bot/handler.js"),
      import("./telegram/api.js"),
      import("./supabase/admin.js"),
    ]).then(() => {
      if (warmupDebug) console.debug("telegram startup preload", { service: "mini-crm-bot" });
    }).catch((error: unknown) => {
      console.warn("telegram startup preload failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, 250).unref();
}

app.listen({ port, host }).then(() => {
  console.log("telegram bot listening", {
    service: "mini-crm-bot",
    host,
    port,
    warmupEnabled,
  });
  preloadRuntimeModules();
  startWarmup();
}).catch((error: unknown) => {
  if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
    console.error("Port 3100 already in use. Stop duplicate PM2 process: pm2 delete telegram-bot", {
      service: "mini-crm-bot",
      host,
      port,
      message: error.message,
    });
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});
