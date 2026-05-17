import dns from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";
import "dotenv/config";
import Fastify from "fastify";
import { logTelegramWebhookParseError, processTelegramUpdate } from "./bot/handler.js";
import { getSupabaseAdmin } from "./supabase/admin.js";
import { getTelegramMe } from "./telegram/api.js";
import type { TelegramUpdate } from "./telegram/types.js";

dns.setDefaultResultOrder("ipv4first");
setGlobalDispatcher(new Agent({
  connect: {
    timeout: 3000,
  },
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 120000,
}));

const app = Fastify({ logger: false });

app.post<{ Body: TelegramUpdate }>("/telegram/webhook", async (request, reply) => {
  const startedAt = Date.now();
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const actualSecret = request.headers["x-telegram-bot-api-secret-token"];

  if (!expectedSecret || actualSecret !== expectedSecret) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const update = request.body;
  setImmediate(() => {
    processTelegramUpdate(update).catch((error: unknown) => {
      logTelegramWebhookParseError(error);
      console.error(error);
    });
  });

  console.log("telegram webhook fast response", { ms: Date.now() - startedAt });
  return reply.send({ ok: true });
});

const port = Number(process.env.PORT ?? process.env.BOT_PORT ?? 3100);
const host = process.env.BOT_HOST ?? "127.0.0.1";
const warmupEnabled = process.env.ENABLE_BOT_WARMUP === "true";

function startWarmup() {
  if (!warmupEnabled) return;

  const warmupTelegram = async () => {
    const startedAt = Date.now();
    try {
      await getTelegramMe();
      console.log("telegram warmup", { target: "telegram", ms: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("telegram warmup failed", { target: "telegram", message });
    }
  };

  const warmupSupabase = async () => {
    const startedAt = Date.now();
    try {
      const { error } = await getSupabaseAdmin().from("telegram_connections").select("id").limit(1);
      if (error) throw error;
      console.log("telegram warmup", { target: "supabase", ms: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("telegram warmup failed", { target: "supabase", message });
    }
  };

  setInterval(() => void warmupTelegram(), 45_000).unref();
  setInterval(() => void warmupSupabase(), 60_000).unref();
  void warmupTelegram();
  void warmupSupabase();
}

app.listen({ port, host }).then(() => {
  console.log("telegram bot listening", {
    service: "mini-crm-bot",
    port,
    host,
    nodeOptions: process.env.NODE_OPTIONS,
    dnsDefaultResultOrder: dns.getDefaultResultOrder(),
    warmupEnabled,
  });
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
