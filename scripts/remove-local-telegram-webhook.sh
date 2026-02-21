#!/usr/bin/env bash
set -euo pipefail

# Remove Telegram webhook for local SupaClaw development.
#
# What this script does:
# 1) Loads Telegram secrets from supabase/.env.local.
# 2) Calls Telegram deleteWebhook with drop_pending_updates=true.
# 3) Calls Telegram getWebhookInfo to print and verify current webhook status.
#
# Usage:
#   ./scripts/remove-local-telegram-webhook.sh

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

set -a
source "${REPO_ROOT}/supabase/.env.local"
set +a

: "${TELEGRAM_BOT_TOKEN:?Missing TELEGRAM_BOT_TOKEN in supabase/.env.local}"

curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "drop_pending_updates": true
  }' | python3 -m json.tool

curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" | python3 -m json.tool
