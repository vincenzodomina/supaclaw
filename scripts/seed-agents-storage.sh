#!/usr/bin/env bash
set -euo pipefail

# Seed workspace/.agents files into Supabase Storage.
#
# Important: this script uses the Storage HTTP API + service role key via curl as a temporary workaround. Revisit later.
# Reason: `supabase storage` may require access token even with `--local`.
#
# Target approach:
#   supabase --experimental storage ls/rm/cp ...
#
# What this script does (step-by-step):
# 1) Resolves inputs from flags and/or env file
# 2) Verifies dependencies (`curl`, `python3`) and source directory existence.
# 3) Lists current objects under `<bucket>/.agents/` via Storage HTTP API.
# 4) If objects exist, asks whether to remove them first.
# 5) Uploads all files from source dir recursively to `<bucket>/.agents/...`.
#
# Usage:
#   # Local default usage
#   bash ./scripts/seed-agents-storage.sh --env-file supabase/.env.local --source-dir workspace/.agents
#
#   # Cloud/linked project usage
#   bash ./scripts/seed-agents-storage.sh --env-file supabase/.env --source-dir workspace/.agents
#
# Optional flags:
#   --workspace-bucket <name>  Override bucket (default from env or "workspace")
#   --api-url <url>            Override API URL (default from env or localhost)

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${REPO_ROOT}/supabase/.env.local"
AGENTS_SRC="${REPO_ROOT}/workspace/.agents"
WORKSPACE_BUCKET=""
SUPABASE_API_URL=""

log() {
  printf "[seed-agents] %s\n" "$1"
}

warn() {
  printf "[seed-agents][warn] %s\n" "$1"
}

die() {
  printf "[seed-agents][error] %s\n" "$1" >&2
  exit 1
}

ask_yes_no() {
  local prompt="$1"
  local default="${2:-n}"
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
  local env_file="$2"
  [[ -f "${env_file}" ]] || return 0
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, "", $0); print $0; exit }' "${env_file}"
}

urlencode_path() {
  local raw="$1"
  python3 - "$raw" <<'PY'
import sys
from urllib.parse import quote
print(quote(sys.argv[1], safe="/"))
PY
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --source-dir)
      AGENTS_SRC="$2"
      shift 2
      ;;
    --workspace-bucket)
      WORKSPACE_BUCKET="$2"
      shift 2
      ;;
    --api-url)
      SUPABASE_API_URL="$2"
      shift 2
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "curl is required."
command -v python3 >/dev/null 2>&1 || die "python3 is required."

if [[ ! -d "${AGENTS_SRC}" ]]; then
  warn "No local .agents directory found at ${AGENTS_SRC}; skipping seed."
  exit 0
fi

if [[ -z "${WORKSPACE_BUCKET}" ]]; then
  WORKSPACE_BUCKET="$(get_env_value "WORKSPACE_BUCKET" "${ENV_FILE}")"
fi
WORKSPACE_BUCKET="${WORKSPACE_BUCKET:-workspace}"

if [[ -z "${SUPABASE_API_URL}" ]]; then
  SUPABASE_API_URL="$(get_env_value "SUPABASE_URL" "${ENV_FILE}")"
fi
SUPABASE_API_URL="${SUPABASE_API_URL:-http://127.0.0.1:54321}"

SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
if [[ -z "${SERVICE_ROLE_KEY}" ]]; then
  SERVICE_ROLE_KEY="$(get_env_value "SUPABASE_SERVICE_ROLE_KEY" "${ENV_FILE}")"
fi
if [[ -z "${SERVICE_ROLE_KEY}" ]]; then
  die "SUPABASE_SERVICE_ROLE_KEY is required (env var or ${ENV_FILE})."
fi

list_response="$(curl -fsS -X POST \
  "${SUPABASE_API_URL}/storage/v1/object/list/${WORKSPACE_BUCKET}" \
  -H "apikey: ${SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"prefix":".agents/","limit":1000,"offset":0,"sortBy":{"column":"name","order":"asc"}}' \
  || true)"

existing_paths="$(printf "%s" "${list_response}" | python3 - <<'PY'
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    raise SystemExit(0)
try:
    data = json.loads(raw)
except Exception:
    raise SystemExit(0)
if not isinstance(data, list):
    raise SystemExit(0)
for row in data:
    name = row.get("name")
    if isinstance(name, str) and name:
        print(f".agents/{name}")
PY
)"

if [[ -n "${existing_paths//[[:space:]]/}" ]]; then
  warn "Existing .agents files found in bucket '${WORKSPACE_BUCKET}'."
  if ask_yes_no "Remove existing .agents files before seeding from source?" "n"; then
    while IFS= read -r object_path; do
      [[ -n "${object_path}" ]] || continue
      encoded_path="$(urlencode_path "${object_path}")"
      curl -fsS -X DELETE \
        "${SUPABASE_API_URL}/storage/v1/object/${WORKSPACE_BUCKET}/${encoded_path}" \
        -H "apikey: ${SERVICE_ROLE_KEY}" \
        -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" >/dev/null
    done <<< "${existing_paths}"
  else
    warn "Keeping existing .agents files. Skipping seed to avoid overwrite."
    exit 0
  fi
fi

uploaded_count=0
shopt -s globstar nullglob
for file_path in "${AGENTS_SRC}"/**; do
  [[ -f "${file_path}" ]] || continue
  rel_path="${file_path#${AGENTS_SRC}/}"
  object_path=".agents/${rel_path}"
  encoded_path="$(urlencode_path "${object_path}")"
  content_type="text/plain; charset=utf-8"
  if [[ "${file_path}" == *.md ]]; then
    content_type="text/markdown; charset=utf-8"
  fi

  curl -fsS -X POST \
    "${SUPABASE_API_URL}/storage/v1/object/${WORKSPACE_BUCKET}/${encoded_path}" \
    -H "apikey: ${SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
    -H "x-upsert: true" \
    -H "Content-Type: ${content_type}" \
    --data-binary "@${file_path}" >/dev/null
  uploaded_count=$((uploaded_count + 1))
done

log "Seeded ${uploaded_count} file(s) from ${AGENTS_SRC} into ${WORKSPACE_BUCKET}/.agents."
