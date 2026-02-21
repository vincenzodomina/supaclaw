#!/usr/bin/env bash
set -euo pipefail

# Configure Telegram webhook for local SupaClaw development.
#
# What this script does (step-by-step):
# 1) Loads shared ngrok helper functions.
# 2) Loads Telegram secrets from supabase/.env.local.
# 3) Reuses an existing ngrok HTTPS tunnel or starts one for port 54321.
# 4) Builds local webhook URL for the telegram route on the webhook edge function.
# 5) Calls Telegram setWebhook with TELEGRAM_WEBHOOK_SECRET.
# 6) Calls Telegram getWebhookInfo to print and verify current webhook status.
#
# Usage:
#   ./scripts/set-local-telegram-webhook.sh

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
NGROK_HELPER="${SCRIPT_DIR}/ngrok-helper.sh"

if [[ ! -f "${NGROK_HELPER}" ]]; then
  echo "Missing ngrok helper script: ${NGROK_HELPER}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${NGROK_HELPER}"

# Load local environment variables.
set -a
source "${REPO_ROOT}/supabase/.env.local"
set +a

: "${TELEGRAM_BOT_TOKEN:?Missing TELEGRAM_BOT_TOKEN in supabase/.env.local}"
: "${TELEGRAM_WEBHOOK_SECRET:?Missing TELEGRAM_WEBHOOK_SECRET in supabase/.env.local}"

NGROK_URL="$(ngrok_ensure_https_tunnel 54321 "/tmp/ngrok-supabase.log" 8 1 || true)"

if [[ -z "${NGROK_URL}" ]]; then
  echo "No HTTPS ngrok tunnel found. If ngrok failed with ERR_NGROK_108, stop other ngrok sessions first." >&2
  echo "Hint: check https://dashboard.ngrok.com/agents or run 'pkill -f ngrok' and retry." >&2
  exit 1
fi

WEBHOOK_URL="${NGROK_URL}/functions/v1/webhook/telegram"

echo "Using webhook URL: ${WEBHOOK_URL}"

curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WEBHOOK_URL}\",
    \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\"
  }" | python3 -m json.tool

curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" | python3 -m json.tool
