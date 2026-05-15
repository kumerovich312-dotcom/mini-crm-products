export function POST() {
  return Response.json(
    { ok: false, message: "Telegram bot moved to /telegram/webhook" },
    { status: 410 },
  );
}
