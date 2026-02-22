#!/usr/bin/env bash
set -euo pipefail

# Download source code from a GitHub repository and seed it into Supabase Storage.
#
# Uses the Storage HTTP API + service role key via curl (same approach as seed-agents-storage.sh).
#
# What this script does (step-by-step):
# 1) Parses GitHub URL and resolves inputs from flags and/or env file.
# 2) Verifies dependencies (git, curl, python3).
# 3) Clones the repository (shallow, depth 1) into a temp directory.
# 4) Checks for existing files under the storage prefix.
# 5) Uploads all tracked files to <bucket>/<prefix>/...
#
# Usage:
#   bash ./scripts/seed-source-code.sh https://github.com/owner/repo
#   bash ./scripts/seed-source-code.sh https://github.com/owner/repo --branch dev
#   bash ./scripts/seed-source-code.sh https://github.com/owner/repo --storage-prefix my-project
#   bash ./scripts/seed-source-code.sh https://github.com/owner/repo --env-file supabase/.env
#
# Optional flags:
#   --branch <name>            Branch to clone (default: repo default branch)
#   --storage-prefix <prefix>  Storage path prefix (default: repo name from URL)
#   --workspace-bucket <name>  Override bucket (default from env or "workspace")
#   --api-url <url>            Override API URL (default from env or localhost)
#   --env-file <path>          Env file path (default: supabase/.env.local)

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${REPO_ROOT}/supabase/.env.local"
GITHUB_URL=""
BRANCH=""
STORAGE_PREFIX=""
WORKSPACE_BUCKET=""
SUPABASE_API_URL=""

log() {
  printf "[seed-source] %s\n" "$1"
}

warn() {
  printf "[seed-source][warn] %s\n" "$1"
}

die() {
  printf "[seed-source][error] %s\n" "$1" >&2
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

content_type_for() {
  case "$1" in
    *.ts|*.tsx)       printf "text/typescript; charset=utf-8" ;;
    *.js|*.jsx|*.mjs) printf "application/javascript; charset=utf-8" ;;
    *.json)           printf "application/json; charset=utf-8" ;;
    *.md|*.mdx)       printf "text/markdown; charset=utf-8" ;;
    *.sh|*.bash)      printf "text/x-shellscript; charset=utf-8" ;;
    *.sql)            printf "application/sql; charset=utf-8" ;;
    *.html|*.htm)     printf "text/html; charset=utf-8" ;;
    *.css)            printf "text/css; charset=utf-8" ;;
    *.yaml|*.yml)     printf "text/yaml; charset=utf-8" ;;
    *.xml|*.svg)      printf "text/xml; charset=utf-8" ;;
    *.toml)           printf "text/toml; charset=utf-8" ;;
    *.png)            printf "image/png" ;;
    *.jpg|*.jpeg)     printf "image/jpeg" ;;
    *.gif)            printf "image/gif" ;;
    *)                printf "text/plain; charset=utf-8" ;;
  esac
}

# --- Argument parsing ---

if [[ $# -lt 1 ]]; then
  die "Usage: seed-source-code.sh <github-url> [--branch <name>] [--storage-prefix <prefix>] [--env-file <path>] [--workspace-bucket <name>] [--api-url <url>]"
fi

GITHUB_URL="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      BRANCH="$2"
      shift 2
      ;;
    --storage-prefix)
      STORAGE_PREFIX="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
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

if [[ ! "${GITHUB_URL}" =~ ^https?://github\.com/ ]]; then
  die "Expected a GitHub URL (https://github.com/owner/repo), got: ${GITHUB_URL}"
fi

CLEAN_URL="${GITHUB_URL%.git}"
CLEAN_URL="${CLEAN_URL%/}"
REPO_NAME="${CLEAN_URL##*/}"

if [[ -z "${STORAGE_PREFIX}" ]]; then
  STORAGE_PREFIX="${REPO_NAME}"
fi

command -v git >/dev/null 2>&1 || die "git is required."
command -v curl >/dev/null 2>&1 || die "curl is required."
command -v python3 >/dev/null 2>&1 || die "python3 is required."

# --- Resolve Supabase credentials ---

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

# --- Check for existing files under the storage prefix ---

list_response="$(curl -fsS -X POST \
  "${SUPABASE_API_URL}/storage/v1/object/list/${WORKSPACE_BUCKET}" \
  -H "apikey: ${SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"prefix\":\"${STORAGE_PREFIX}/\",\"limit\":1000,\"offset\":0,\"sortBy\":{\"column\":\"name\",\"order\":\"asc\"}}" \
  || true)"

existing_count="$(printf "%s" "${list_response}" | python3 - <<'PY'
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    print(0)
    raise SystemExit(0)
try:
    data = json.loads(raw)
except Exception:
    print(0)
    raise SystemExit(0)
if not isinstance(data, list):
    print(0)
    raise SystemExit(0)
print(len([r for r in data if r.get("name")]))
PY
)"

if [[ "${existing_count}" -gt 0 ]]; then
  warn "Found existing files under '${WORKSPACE_BUCKET}/${STORAGE_PREFIX}/'."
  if ! ask_yes_no "Overwrite existing files and re-seed from ${GITHUB_URL}?" "y"; then
    warn "Skipping source code seed."
    exit 0
  fi
fi

# --- Clone repository ---

TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

log "Cloning ${GITHUB_URL}${BRANCH:+ (branch: ${BRANCH})} ..."
git clone --depth 1 ${BRANCH:+--branch "${BRANCH}"} "${GITHUB_URL}" "${TMPDIR}/repo"

SOURCE_DIR="${TMPDIR}/repo"

# --- Upload files to storage ---

uploaded_count=0
while IFS= read -r -d '' file_path; do
  [[ -f "${file_path}" ]] || continue
  rel_path="${file_path#${SOURCE_DIR}/}"
  object_path="${STORAGE_PREFIX}/${rel_path}"
  encoded_path="$(urlencode_path "${object_path}")"
  content_type="$(content_type_for "${file_path}")"

  curl -fsS -X POST \
    "${SUPABASE_API_URL}/storage/v1/object/${WORKSPACE_BUCKET}/${encoded_path}" \
    -H "apikey: ${SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
    -H "x-upsert: true" \
    -H "Content-Type: ${content_type}" \
    --data-binary "@${file_path}" >/dev/null
  uploaded_count=$((uploaded_count + 1))
done < <(find "${SOURCE_DIR}" -path '*/.git' -prune -o -type f -print0)

log "Seeded ${uploaded_count} file(s) from ${GITHUB_URL} into ${WORKSPACE_BUCKET}/${STORAGE_PREFIX}/."
