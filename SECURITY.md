# Security Notes

## Telegram Bot

- Webhook URL: `https://serenebot.ru/telegram/webhook`
- Active bot endpoint: `POST /telegram/webhook` in `apps/telegram-bot`
- Deprecated CRM endpoint: `/api/telegram/webhook`
- Telegram bot port: `3100`
- Telegram bot should listen on `127.0.0.1`; Nginx proxies public traffic to it.
- PM2 processes: `mini-crm` and `mini-crm-bot`
- Run the Next.js CRM and Telegram bot as separate PM2 processes.
- Required bot env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, Supabase env values, and `NODE_OPTIONS=--dns-result-order=ipv4first`.

Never run the project as `root`.

## Miner Check

Use this command during incident checks:

```bash
pgrep -af "cpu-logind|xmrig|kinsing|miner|minerd|crypto|kdevtmpfsi|kthreaddi"
```

The application user crontab should be empty unless a task is explicitly documented.
