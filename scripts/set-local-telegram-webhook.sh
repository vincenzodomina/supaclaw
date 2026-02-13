#!/usr/bin/env bash
set -euo pipefail

# Load local environment variables.
set -a
source "supabase/.env.local"
set +a

: "${TELEGRAM_BOT_TOKEN:?Missing TELEGRAM_BOT_TOKEN in supabase/.env.local}"
: "${TELEGRAM_WEBHOOK_SECRET:?Missing TELEGRAM_WEBHOOK_SECRET in supabase/.env.local}"

# Start ngrok if local API is not already exposed.
if ! lsof -iTCP:4040 -sTCP:LISTEN >/dev/null 2>&1; then
  ngrok http 54321 >/tmp/ngrok-supabase.log 2>&1 &
  sleep 2
fi

NGROK_URL="$(
python3 - <<'PY'
import json
import urllib.request

with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels") as response:
    data = json.load(response)

https = [
    tunnel.get("public_url", "")
    for tunnel in data.get("tunnels", [])
    if tunnel.get("public_url", "").startswith("https://")
]

if not https:
    raise SystemExit("No HTTPS ngrok tunnel found. Is ngrok running?")

print(https[0])
PY
)"

WEBHOOK_URL="${NGROK_URL}/functions/v1/telegram-webhook"

echo "Using webhook URL: ${WEBHOOK_URL}"

curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WEBHOOK_URL}\",
    \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\"
  }" | python3 -m json.tool

curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" | python3 -m json.tool
