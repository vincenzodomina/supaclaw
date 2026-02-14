#!/usr/bin/env bash
set -euo pipefail

# SupaClaw local installer (interactive)
#
# What this script does (step-by-step):
# 1) Validates local prerequisites used by README quickstart commands.
# 2) Starts local Supabase services with Docker.
# 3) Pushes local database schema/migrations.
# 4) Creates/updates supabase/.env.local interactively.
# 5) Installs Deno dependencies for edge functions.
# 6) Optionally configures Supabase Vault secrets from supabase/.env.local.
# 7) Optionally configures Telegram webhook via ngrok helper.
# 8) Optionally starts local edge functions server (blocking command).
#
# Usage:
#   ./scripts/install.sh

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_EXAMPLE="${REPO_ROOT}/supabase/.env.example"
ENV_LOCAL="${REPO_ROOT}/supabase/.env.local"
VAULT_SCRIPT="${REPO_ROOT}/scripts/deploy-local-vault-secrets.sh"
WEBHOOK_SCRIPT="${REPO_ROOT}/scripts/set-local-telegram-webhook.sh"
NGROK_HELPER="${REPO_ROOT}/scripts/ngrok-helper.sh"

if [[ ! -f "${NGROK_HELPER}" ]]; then
  printf "[install][error] Missing ngrok helper script: %s\n" "${NGROK_HELPER}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${NGROK_HELPER}"

log() {
  printf "\n[install] %s\n" "$1"
}

warn() {
  printf "[install][warn] %s\n" "$1"
}

hint() {
  printf "[install][hint] %s\n" "$1"
}

die() {
  printf "[install][error] %s\n" "$1" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

is_supabase_running() {
  supabase status >/dev/null 2>&1
}

is_functions_serve_running() {
  pgrep -f "supabase functions serve" >/dev/null 2>&1
}

ask_yes_no() {
  local prompt="$1"
  local default="${2:-y}"
  local answer
  local suffix="[y/N]"
  if [[ "${default}" == "y" ]]; then
    suffix="[Y/n]"
  fi

  while true; do
    read -r -p "${prompt} ${suffix} " answer
    answer="${answer:-$default}"
    case "${answer}" in
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO) return 1 ;;
      *) printf "Please answer y or n.\n" ;;
    esac
  done
}

get_env_value() {
  local key="$1"
  [[ -f "${ENV_LOCAL}" ]] || return 0
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, "", $0); print $0; exit }' "${ENV_LOCAL}"
}

upsert_env_value() {
  local key="$1"
  local value="$2"
  python3 - "${ENV_LOCAL}" "${key}" "${value}" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]

if path.exists():
    lines = path.read_text().splitlines()
else:
    lines = []

prefix = f"{key}="
updated = False
new_lines = []
for line in lines:
    if line.startswith(prefix):
        new_lines.append(f"{key}={value}")
        updated = True
    else:
        new_lines.append(line)

if not updated:
    if new_lines and new_lines[-1] != "":
        new_lines.append("")
    new_lines.append(f"{key}={value}")

path.write_text("\n".join(new_lines) + "\n")
PY
}

prompt_env_var() {
  local key="$1"
  local description="$2"
  local required="${3:-false}"
  local secret="${4:-false}"
  local default_value="${5:-}"
  local current_value
  local next_value

  current_value="$(get_env_value "${key}")"
  if [[ -z "${current_value}" && -n "${default_value}" ]]; then
    current_value="${default_value}"
  fi

  printf "\n%s\n" "${description}"
  if [[ -n "${current_value}" ]]; then
    if ask_yes_no "Keep existing value for ${key}?" "y"; then
      upsert_env_value "${key}" "${current_value}"
      return 0
    fi
  fi

  while true; do
    if [[ "${secret}" == "true" ]]; then
      read -r -s -p "Enter ${key}: " next_value
      printf "\n"
    else
      if [[ -n "${current_value}" ]]; then
        read -r -p "Enter ${key} [${current_value}]: " next_value
        next_value="${next_value:-$current_value}"
      else
        read -r -p "Enter ${key}: " next_value
      fi
    fi

    if [[ "${required}" == "true" && -z "${next_value}" ]]; then
      printf "%s is required.\n" "${key}"
      continue
    fi

    upsert_env_value "${key}" "${next_value}"
    return 0
  done
}

cd "${REPO_ROOT}"

log "Step 1/8 - Checking prerequisites"
command_exists supabase || die "Supabase CLI not found. Install with: brew install supabase/tap/supabase"
command_exists docker || die "Docker CLI not found. Install Docker Desktop and ensure it is running."
command_exists python3 || die "python3 not found."
command_exists deno || die "deno not found. Install Deno to run edge function dependencies."
command_exists curl || die "curl not found."

if ! docker info >/dev/null 2>&1; then
  die "Docker daemon is not running. Start Docker Desktop first."
fi

SUPABASE_ALREADY_RUNNING="false"
FUNCTIONS_ALREADY_RUNNING="false"
NGROK_TUNNEL_URL=""

if is_supabase_running; then
  SUPABASE_ALREADY_RUNNING="true"
fi

if is_functions_serve_running; then
  FUNCTIONS_ALREADY_RUNNING="true"
fi

NGROK_TUNNEL_URL="$(ngrok_get_https_tunnel_url)"

log "Status hint"
if [[ "${SUPABASE_ALREADY_RUNNING}" == "true" ]]; then
  hint "Supabase local stack: running"
else
  hint "Supabase local stack: not running"
fi
if [[ "${FUNCTIONS_ALREADY_RUNNING}" == "true" ]]; then
  hint "Edge functions serve: running (will default to skip starting again)"
else
  hint "Edge functions serve: not running"
fi
if [[ -n "${NGROK_TUNNEL_URL}" ]]; then
  hint "ngrok HTTPS tunnel: running at ${NGROK_TUNNEL_URL}"
else
  hint "ngrok HTTPS tunnel: not detected"
fi

log "Step 2/8 - Starting Supabase local services"
if [[ "${SUPABASE_ALREADY_RUNNING}" == "true" ]]; then
  if ask_yes_no "Supabase appears already running. Run 'supabase start' again?" "n"; then
    supabase start
  else
    hint "Skipping 'supabase start' because services are already up."
  fi
else
  if ask_yes_no "Start Supabase local services now?" "y"; then
    supabase start
  else
    die "Supabase must be running for the next steps. Re-run and start services."
  fi
fi

log "Step 3/8 - Pushing database schema/migrations to local DB"
supabase db push --local

log "Step 4/8 - Configuring supabase/.env.local interactively"
if [[ ! -f "${ENV_EXAMPLE}" ]]; then
  die "Missing ${ENV_EXAMPLE}"
fi

if [[ ! -f "${ENV_LOCAL}" ]]; then
  cp "${ENV_EXAMPLE}" "${ENV_LOCAL}"
  printf "[install] Created %s from template.\n" "${ENV_LOCAL}"
fi

prompt_env_var "SUPABASE_URL" "Supabase API URL used by local edge functions." "true" "false" "http://127.0.0.1:54321"
prompt_env_var "SUPABASE_SERVICE_ROLE_KEY" "Service role key (required by workers/functions)." "true" "true"
prompt_env_var "TELEGRAM_BOT_TOKEN" "Telegram bot token from BotFather." "true" "true"
prompt_env_var "TELEGRAM_ALLOWED_USER_ID" "Telegram user id allowed to use the bot." "true" "false"
prompt_env_var "TELEGRAM_WEBHOOK_SECRET" "Webhook verification secret (generate with openssl rand -hex 32)." "true" "true"
prompt_env_var "WORKER_SECRET" "Worker secret for scheduled cron invocations." "true" "true"
prompt_env_var "TRIGGER_WEBHOOK_SECRET" "Optional external trigger secret." "false" "true"
prompt_env_var "WORKSPACE_BUCKET" "Workspace bucket name." "false" "false" "workspace"

if ask_yes_no "Configure OpenAI provider variables now?" "y"; then
  prompt_env_var "OPENAI_API_KEY" "OpenAI API key." "true" "true"
  prompt_env_var "OPENAI_MODEL" "OpenAI model id." "true" "false" "gpt-4.1"
fi

if ask_yes_no "Configure Anthropic provider variables now?" "n"; then
  prompt_env_var "ANTHROPIC_API_KEY" "Anthropic API key." "true" "true"
  prompt_env_var "ANTHROPIC_MODEL" "Anthropic model id." "true" "false" "claude-3-5-sonnet-latest"
fi

log "Step 5/8 - Installing Deno dependencies for edge functions"
(cd "${REPO_ROOT}/supabase/functions/_shared" && deno install)

log "Step 6/8 - Optional: Deploy local Vault secrets"
if [[ -x "${VAULT_SCRIPT}" ]]; then
  if ask_yes_no "Run Vault secret deployment now?" "y"; then
    "${VAULT_SCRIPT}"
  fi
else
  warn "Vault script is missing or not executable: ${VAULT_SCRIPT}"
fi

log "Step 7/8 - Optional: Configure Telegram webhook (ngrok)"
if [[ -x "${WEBHOOK_SCRIPT}" ]]; then
  webhook_default="n"
  webhook_prompt="Run Telegram webhook helper now?"
  if [[ -n "${NGROK_TUNNEL_URL}" ]]; then
    webhook_prompt="Run Telegram webhook helper now? (ngrok already detected)"
  fi
  if ask_yes_no "${webhook_prompt}" "${webhook_default}"; then
    "${WEBHOOK_SCRIPT}"
  fi
else
  warn "Webhook helper script is missing or not executable: ${WEBHOOK_SCRIPT}"
fi

log "Step 8/8 - Optional: Start local edge functions server"
functions_default="y"
functions_prompt="Start supabase functions serve now? (This will keep this terminal occupied)"
if [[ "${FUNCTIONS_ALREADY_RUNNING}" == "true" ]]; then
  functions_default="n"
  functions_prompt="Start supabase functions serve now? (Already detected running in another terminal)"
fi
if ask_yes_no "${functions_prompt}" "${functions_default}"; then
  supabase functions serve \
    --env-file "supabase/.env.local" \
    --import-map "supabase/functions/_shared/deno.json" \
    --no-verify-jwt
else
  printf "\n[install] Setup completed! 🎉\n"
  printf "[install] Start functions later with:\n"
  printf "  supabase functions serve --env-file supabase/.env.local --import-map supabase/functions/_shared/deno.json --no-verify-jwt\n"
fi
