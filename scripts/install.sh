#!/usr/bin/env bash
set -euo pipefail

# SupaClaw local installer (interactive)
#
# What this script does (step-by-step):
# 1) Validates local prerequisites used by README quickstart commands.
# 2) Starts local Supabase services with Docker.
# 3) Pushes local database schema/migrations.
# 4) Creates/updates supabase/.env.local interactively.
# 5) Seeds workspace/.agents files into Supabase Storage.
# 6) Optionally seeds source code from a GitHub repo into Supabase Storage.
# 7) Installs Deno dependencies for edge functions.
# 8) Optionally configures Supabase Vault secrets from supabase/.env.local.
# 9) Optionally configures Telegram webhook via ngrok helper.
# 10) Optionally starts local edge functions server (blocking command).
#
# Usage:
#   ./scripts/install.sh
#   ./scripts/install.sh --dev   # fastlane dev defaults (skip most prompts)
#   ./scripts/install.sh --help

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_EXAMPLE="${REPO_ROOT}/supabase/.env.example"
ENV_LOCAL="${REPO_ROOT}/supabase/.env.local"
VAULT_SCRIPT="${REPO_ROOT}/scripts/deploy-local-vault-secrets.sh"
WEBHOOK_SCRIPT="${REPO_ROOT}/scripts/set-local-telegram-webhook.sh"
NGROK_HELPER="${REPO_ROOT}/scripts/ngrok-helper.sh"
AGENTS_SEED_SCRIPT="${REPO_ROOT}/scripts/seed-agents-storage.sh"
SOURCE_SEED_SCRIPT="${REPO_ROOT}/scripts/seed-source-code.sh"
GITHUB_SOURCE_URL_DEFAULT="https://github.com/vincenzodomina/supaclaw"

DEV_MODE="false"

print_help() {
  cat <<EOF
Usage:
  ./scripts/install.sh [--dev]

Options:
  --dev     Fastlane dev defaults (skip most prompts).
  -h, --help  Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)
      DEV_MODE="true"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      die "Unknown argument: $1 (use --help)"
      ;;
  esac
done

if [[ ! -f "${NGROK_HELPER}" ]]; then
  printf "[install][error] Missing ngrok helper script: %s\n" "${NGROK_HELPER}" >&2
  exit 1
fi
if [[ ! -f "${AGENTS_SEED_SCRIPT}" ]]; then
  printf "[install][error] Missing agents seed script: %s\n" "${AGENTS_SEED_SCRIPT}" >&2
  exit 1
fi
if [[ ! -f "${SOURCE_SEED_SCRIPT}" ]]; then
  printf "[install][error] Missing source code seed script: %s\n" "${SOURCE_SEED_SCRIPT}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${NGROK_HELPER}"

COLOR_RESET=""
COLOR_BOLD=""
COLOR_DIM=""
COLOR_CYAN=""
COLOR_YELLOW=""
COLOR_RED=""

if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-}" != "dumb" ]]; then
  COLOR_RESET=$'\033[0m'
  COLOR_BOLD=$'\033[1m'
  COLOR_DIM=$'\033[2m'
  COLOR_CYAN=$'\033[36m'
  COLOR_YELLOW=$'\033[33m'
  COLOR_RED=$'\033[31m'
fi

log() {
  if [[ "$1" =~ ^Step\ [0-9]+/[0-9]+\ -\  ]]; then
    printf "\n%s%s[install] %s%s\n" "${COLOR_BOLD}" "${COLOR_CYAN}" "$1" "${COLOR_RESET}"
    printf "%s%s────────────────────────────────────────────────────────────%s\n" "${COLOR_DIM}" "${COLOR_CYAN}" "${COLOR_RESET}"
  else
    printf "\n%s%s[install] %s%s\n" "${COLOR_BOLD}" "${COLOR_CYAN}" "$1" "${COLOR_RESET}"
  fi
}

warn() {
  printf "%s%s[install][warn] %s%s\n" "${COLOR_YELLOW}" "${COLOR_BOLD}" "$1" "${COLOR_RESET}"
}

info() {
  printf "%s[install][info] %s%s\n" "${COLOR_DIM}" "$1" "${COLOR_RESET}"
}

die() {
  printf "%s%s[install][error] %s%s\n" "${COLOR_RED}" "${COLOR_BOLD}" "$1" "${COLOR_RESET}" >&2
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

log "Step 1/10 - Checking prerequisites"
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

if [[ "${SUPABASE_ALREADY_RUNNING}" == "true" ]]; then
  info "Supabase local stack: running"
else
  info "Supabase local stack: not running"
fi
if [[ "${FUNCTIONS_ALREADY_RUNNING}" == "true" ]]; then
  info "Edge functions serve: running (will default to skip starting again)"
else
  info "Edge functions serve: not running"
fi
if [[ -n "${NGROK_TUNNEL_URL}" ]]; then
  info "ngrok HTTPS tunnel: running at ${NGROK_TUNNEL_URL}"
else
  info "ngrok HTTPS tunnel: not detected"
fi

log "Step 2/10 - Starting Supabase local services"
if [[ "${SUPABASE_ALREADY_RUNNING}" == "true" ]]; then
  if [[ "${DEV_MODE}" == "true" ]]; then
    info "Skipping 'supabase start' because services are already up. (--dev)"
  elif ask_yes_no "Supabase appears already running. Run 'supabase start' again?" "n"; then
    supabase start
  else
    info "Skipping 'supabase start' because services are already up."
  fi
else
  if [[ "${DEV_MODE}" == "true" ]]; then
    supabase start
  elif ask_yes_no "Start Supabase local services now?" "y"; then
    supabase start
  else
    die "Supabase must be running for the next steps. Re-run and start services."
  fi
fi

log "Step 3/10 - Pushing database schema/migrations to local DB"
supabase db push --local

log "Step 4/10 - Configuring supabase/.env.local"
if [[ ! -f "${ENV_EXAMPLE}" ]]; then
  die "Missing ${ENV_EXAMPLE}"
fi

env_default="y"
env_prompt="Configure supabase/.env.local now?"
if [[ -f "${ENV_LOCAL}" ]]; then
  env_default="n"
  env_prompt="Configure supabase/.env.local now? (existing file detected)"
fi

if [[ "${DEV_MODE}" == "true" ]]; then
  if [[ ! -f "${ENV_LOCAL}" ]]; then
    die "supabase/.env.local is missing; cannot skip env setup in --dev mode."
  fi
  info "Skipping supabase/.env.local setup (--dev; using existing file)."
elif ask_yes_no "${env_prompt}" "${env_default}"; then
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

  if ask_yes_no "Configure AWS Bedrock provider variables now?" "n"; then
    prompt_env_var "AWS_BEDROCK_ACCESS_KEY" "AWS Bedrock access key (from IAM console)." "true" "true"
    prompt_env_var "AWS_BEDROCK_SECRET_ACCESS_KEY" "AWS Bedrock secret access key." "true" "true"
    prompt_env_var "AWS_REGION" "AWS region for Bedrock." "true" "false" "us-east-1"
  fi
else
  if [[ ! -f "${ENV_LOCAL}" ]]; then
    die "supabase/.env.local is missing; cannot skip env setup."
  fi
  info "Skipping supabase/.env.local setup (using existing file)."
fi

log "Step 5/10 - Seeding workspace .agents files to Supabase Storage"
WORKSPACE_BUCKET_VALUE="$(get_env_value "WORKSPACE_BUCKET")"
WORKSPACE_BUCKET_VALUE="${WORKSPACE_BUCKET_VALUE:-workspace}"
bash "${AGENTS_SEED_SCRIPT}" \
  --env-file "${ENV_LOCAL}" \
  --source-dir "${REPO_ROOT}/workspace/.agents" \
  --workspace-bucket "${WORKSPACE_BUCKET_VALUE}"

log "Step 6/10 - Seed project source code from GitHub to Supabase Storage"
if [[ "${DEV_MODE}" == "true" ]]; then
  bash "${SOURCE_SEED_SCRIPT}" "${GITHUB_SOURCE_URL_DEFAULT}" \
    --env-file "${ENV_LOCAL}" \
    --workspace-bucket "${WORKSPACE_BUCKET_VALUE}"
else
  if ask_yes_no "Seed project source code from a GitHub repo into storage?" "n"; then
    GITHUB_SOURCE_URL=""
    read -r -p "GitHub repo URL [${GITHUB_SOURCE_URL_DEFAULT}]: " GITHUB_SOURCE_URL
    GITHUB_SOURCE_URL="${GITHUB_SOURCE_URL:-${GITHUB_SOURCE_URL_DEFAULT}}"
    bash "${SOURCE_SEED_SCRIPT}" "${GITHUB_SOURCE_URL}" \
      --env-file "${ENV_LOCAL}" \
      --workspace-bucket "${WORKSPACE_BUCKET_VALUE}"
  fi
fi

log "Step 7/10 - Installing Deno dependencies for edge functions"
(cd "${REPO_ROOT}/supabase/functions/_shared" && deno install)

log "Step 8/10 - Deploy local Vault secrets"
if [[ -x "${VAULT_SCRIPT}" ]]; then
  if [[ "${DEV_MODE}" == "true" ]]; then
    "${VAULT_SCRIPT}"
  elif ask_yes_no "Run Vault secret deployment now?" "y"; then
    "${VAULT_SCRIPT}"
  fi
else
  warn "Vault script is missing or not executable: ${VAULT_SCRIPT}"
fi

log "Step 9/10 - Configure Telegram webhook (ngrok)"
if [[ -x "${WEBHOOK_SCRIPT}" ]]; then
  if [[ "${DEV_MODE}" == "true" ]]; then
    info "Skipping Telegram webhook helper (--dev)."
  else
    webhook_default="n"
    webhook_prompt="Run Telegram webhook helper now?"
    if [[ -n "${NGROK_TUNNEL_URL}" ]]; then
      webhook_prompt="Run Telegram webhook helper now? (ngrok already detected)"
    fi
    if ask_yes_no "${webhook_prompt}" "${webhook_default}"; then
      "${WEBHOOK_SCRIPT}"
    fi
  fi
else
  warn "Webhook helper script is missing or not executable: ${WEBHOOK_SCRIPT}"
fi

log "Step 10/10 - Start local edge functions server"
functions_default="y"
functions_prompt="Start supabase functions serve now? (This will keep this terminal occupied)"
if [[ "${FUNCTIONS_ALREADY_RUNNING}" == "true" ]]; then
  functions_default="n"
  functions_prompt="Start supabase functions serve now? (Already detected running in another terminal)"
fi
if [[ "${DEV_MODE}" == "true" ]]; then
  if [[ "${FUNCTIONS_ALREADY_RUNNING}" == "true" ]]; then
    info "Skipping 'supabase functions serve' because it is already running. (--dev)"
    printf "\n[install] Setup completed!\n"
  else
    supabase functions serve \
      --env-file "supabase/.env.local" \
      --no-verify-jwt
  fi
elif ask_yes_no "${functions_prompt}" "${functions_default}"; then
  supabase functions serve \
    --env-file "supabase/.env.local" \
    --no-verify-jwt
else
  printf "\n[install] Setup completed! 🎉\n"
  printf "[install] Start functions later with:\n"
  printf "  supabase functions serve --env-file supabase/.env.local --no-verify-jwt\n"
fi
