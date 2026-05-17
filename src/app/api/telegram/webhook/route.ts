// Deprecated: Telegram bot now runs as a separate Node.js app on /telegram/webhook.
export function POST() {
  return Response.json(
    { ok: false, message: "Deprecated. Telegram bot moved to /telegram/webhook" },
    { status: 410 },
  );
}
