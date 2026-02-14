#!/usr/bin/env bash
set -euo pipefail

# Deploy local Supabase Vault secrets from supabase/.env.local
#
# What this script does (step-by-step):
# 1) Loads values from supabase/.env.local.
# 2) Validates required secrets are present.
# 3) Derives Docker-reachable project URL for worker calls.
# 4) Generates a temporary local migration containing the Vault SQL snippet.
# 5) Applies that migration via `supabase migration up --local`.
# 6) Cleans migration history entry and removes the temporary file.
#
# Usage:
#   ./scripts/deploy-local-vault-secrets.sh

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_LOCAL="${REPO_ROOT}/supabase/.env.local"

log() {
  printf "[vault] %s\n" "$1"
}

die() {
  printf "[vault][error] %s\n" "$1" >&2
  exit 1
}

command -v supabase >/dev/null 2>&1 || die "Supabase CLI not found."
[[ -f "${ENV_LOCAL}" ]] || die "Missing ${ENV_LOCAL}. Create it first."

set -a
source "${ENV_LOCAL}"
set +a

: "${SUPABASE_SERVICE_ROLE_KEY:?Missing SUPABASE_SERVICE_ROLE_KEY in supabase/.env.local}"
: "${WORKER_SECRET:?Missing WORKER_SECRET in supabase/.env.local}"

PROJECT_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
PROJECT_URL="${PROJECT_URL/127.0.0.1/host.docker.internal}"
PROJECT_URL="${PROJECT_URL/localhost/host.docker.internal}"

sql_escape() {
  local value="$1"
  value="${value//\'/\'\'}"
  printf "%s" "${value}"
}

PROJECT_URL_SQL="$(sql_escape "${PROJECT_URL}")"
WORKER_SECRET_SQL="$(sql_escape "${WORKER_SECRET}")"
SERVICE_ROLE_KEY_SQL="$(sql_escape "${SUPABASE_SERVICE_ROLE_KEY}")"

MIGRATIONS_DIR="${REPO_ROOT}/supabase/migrations"
[[ -d "${MIGRATIONS_DIR}" ]] || die "Missing ${MIGRATIONS_DIR}"

MIGRATION_VERSION="$(date +%Y%m%d%H%M%S)"
MIGRATION_NAME="${MIGRATION_VERSION}_local_vault_secrets.sql"
MIGRATION_PATH="${MIGRATIONS_DIR}/${MIGRATION_NAME}"

cleanup() {
  if [[ -f "${MIGRATION_PATH}" ]]; then
    rm -f "${MIGRATION_PATH}"
  fi
}
trap cleanup EXIT

log "Applying secrets to local Vault via temporary migration..."
log "Using project_url=${PROJECT_URL}"

cat > "${MIGRATION_PATH}" <<SQL
-- Idempotent reset of named secrets.
delete from vault.secrets where name in ('project_url', 'worker_secret', 'service_role_key');

select vault.create_secret('${PROJECT_URL_SQL}', 'project_url');
select vault.create_secret('${WORKER_SECRET_SQL}', 'worker_secret');
select vault.create_secret('${SERVICE_ROLE_KEY_SQL}', 'service_role_key');
SQL

supabase migration up --local --include-all

# Keep local migration history clean because this is an operational script, not schema history.
if ! supabase migration repair "${MIGRATION_VERSION}" --status reverted --local >/dev/null 2>&1; then
  log "Warning: could not repair local migration history for ${MIGRATION_VERSION}. You can run:"
  log "supabase migration repair ${MIGRATION_VERSION} --status reverted --local"
fi

log "Vault secret deployment completed."
