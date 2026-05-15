import "dotenv/config";
import dns from "node:dns";
import Fastify from "fastify";
import { logTelegramWebhookParseError, processTelegramUpdate } from "./bot/handler.js";
import type { TelegramUpdate } from "./telegram/types.js";

dns.setDefaultResultOrder("ipv4first");

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

const port = Number(process.env.BOT_PORT ?? 3100);

app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log("telegram bot listening", { port });
}).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
