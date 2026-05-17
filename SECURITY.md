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
- The bot PM2 process name is `mini-crm-bot`. Do not use or keep a separate `telegram-bot` PM2 process.

### Telegram Bot Deploy

```bash
cd /var/www/mini-crm-products
git pull

cd apps/telegram-bot
npm install
npm run build

set -a
source ../../.env.local
export NODE_OPTIONS="--dns-result-order=ipv4first"
export ENABLE_BOT_WARMUP=true
set +a

pm2 delete telegram-bot 2>/dev/null || true
pm2 restart mini-crm-bot --update-env || pm2 start npm --name mini-crm-bot -- start
pm2 save
pm2 status
```

After deploy, PM2 should show only:

```text
mini-crm
mini-crm-bot
```

Checks:

```bash
pm2 status
pm2 pid mini-crm-bot
ss -tulpn | grep :3100
curl -i -X POST http://127.0.0.1:3100/telegram/webhook \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"update_id":0}'
```

Never run the project as `root`.

## Miner Check

Use this command during incident checks:

```bash
pgrep -af "cpu-logind|xmrig|kinsing|miner|minerd|crypto|kdevtmpfsi|kthreaddi"
```

The application user crontab should be empty unless a task is explicitly documented.
