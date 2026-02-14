#!/usr/bin/env bash
set -euo pipefail

# Load local environment variables.
set -a
source "supabase/.env.local"
set +a

: "${TELEGRAM_BOT_TOKEN:?Missing TELEGRAM_BOT_TOKEN in supabase/.env.local}"
: "${TELEGRAM_WEBHOOK_SECRET:?Missing TELEGRAM_WEBHOOK_SECRET in supabase/.env.local}"

get_https_tunnel_url() {
  python3 - <<'PY'
import json
import urllib.request
import urllib.error

try:
    with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=1.5) as response:
        data = json.load(response)
except (urllib.error.URLError, TimeoutError):
    print("")
    raise SystemExit(0)

for tunnel in data.get("tunnels", []):
    url = tunnel.get("public_url", "")
    if url.startswith("https://"):
        print(url)
        raise SystemExit(0)

print("")
PY
}

NGROK_URL="$(get_https_tunnel_url)"

# Reuse active tunnel if available; otherwise start ngrok and wait briefly.
if [[ -z "${NGROK_URL}" ]]; then
  ngrok http 54321 >/tmp/ngrok-supabase.log 2>&1 &
  for _ in {1..8}; do
    sleep 1
    NGROK_URL="$(get_https_tunnel_url)"
    if [[ -n "${NGROK_URL}" ]]; then
      break
    fi
  done
fi

if [[ -z "${NGROK_URL}" ]]; then
  echo "No HTTPS ngrok tunnel found. If ngrok failed with ERR_NGROK_108, stop other ngrok sessions first." >&2
  echo "Hint: check https://dashboard.ngrok.com/agents or run 'pkill -f ngrok' and retry." >&2
  exit 1
fi

WEBHOOK_URL="${NGROK_URL}/functions/v1/telegram-webhook"

echo "Using webhook URL: ${WEBHOOK_URL}"

curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WEBHOOK_URL}\",
    \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\"
  }" | python3 -m json.tool

curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" | python3 -m json.tool
