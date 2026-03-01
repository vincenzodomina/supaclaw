#!/usr/bin/env bash
set -euo pipefail

# Download workspace/.agents files from Supabase Storage and overwrite locally.
#
# This mirrors scripts/seed-agents-storage.sh, but in reverse.
#
# Usage:
#   # Local default usage
#   bash ./scripts/download-agents-storage.sh --env-file supabase/.env.local --dest-dir workspace/.agents
#
#   # Cloud/linked project usage
#   bash ./scripts/download-agents-storage.sh --env-file supabase/.env --dest-dir workspace/.agents
#
# Optional flags:
#   --workspace-bucket <name>  Override bucket (default from env or "workspace")
#   --api-url <url>            Override API URL (default from env or localhost)
#   --clean                    Remove dest dir contents before download (mirror storage exactly)
#   --yes                      Do not prompt for confirmation (only affects --clean)

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${REPO_ROOT}/supabase/.env.local"
AGENTS_DEST="${REPO_ROOT}/workspace/.agents"
WORKSPACE_BUCKET=""
SUPABASE_API_URL=""
CLEAN_DEST="false"
ASSUME_YES="false"

log() {
  printf "[download-agents] %s\n" "$1"
}

warn() {
  printf "[download-agents][warn] %s\n" "$1"
}

die() {
  printf "[download-agents][error] %s\n" "$1" >&2
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
  local raw
  raw="$(awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, "", $0); print $0; exit }' "${env_file}")"
  # Trim whitespace + optional surrounding quotes, and tolerate CRLF.
  raw="${raw%$'\r'}"
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  if [[ "${raw}" == \"*\" && "${raw}" == *\" && "${#raw}" -ge 2 ]]; then
    raw="${raw:1:-1}"
  elif [[ "${raw}" == \'*\' && "${raw}" == *\' && "${#raw}" -ge 2 ]]; then
    raw="${raw:1:-1}"
  fi
  printf "%s" "${raw}"
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
    --dest-dir)
      AGENTS_DEST="$2"
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
    --clean)
      CLEAN_DEST="true"
      shift 1
      ;;
    --yes)
      ASSUME_YES="true"
      shift 1
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "curl is required."
command -v python3 >/dev/null 2>&1 || die "python3 is required."

if [[ "${ENV_FILE}" != /* ]]; then
  ENV_FILE="${REPO_ROOT}/${ENV_FILE}"
fi
if [[ "${AGENTS_DEST}" != /* ]]; then
  AGENTS_DEST="${REPO_ROOT}/${AGENTS_DEST}"
fi

if [[ -z "${WORKSPACE_BUCKET}" ]]; then
  WORKSPACE_BUCKET="$(get_env_value "WORKSPACE_BUCKET" "${ENV_FILE}")"
fi
WORKSPACE_BUCKET="${WORKSPACE_BUCKET:-workspace}"

if [[ -z "${SUPABASE_API_URL}" ]]; then
  SUPABASE_API_URL="$(get_env_value "SUPABASE_URL" "${ENV_FILE}")"
fi
SUPABASE_API_URL="${SUPABASE_API_URL:-http://127.0.0.1:54321}"

SERVICE_ROLE_KEY="$(get_env_value "SUPABASE_SERVICE_ROLE_KEY" "${ENV_FILE}")"
if [[ -z "${SERVICE_ROLE_KEY}" ]]; then
  SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
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

# Produces output paths like: ".agents/some/file.txt"
object_paths="$(printf "%s" "${list_response}" | python3 -c $'import json, sys\nraw = sys.stdin.read().strip()\nif not raw:\n    raise SystemExit(0)\ntry:\n    data = json.loads(raw)\nexcept Exception:\n    raise SystemExit(0)\nif not isinstance(data, list):\n    raise SystemExit(0)\nfor row in data:\n    if not isinstance(row, dict):\n        continue\n    name = row.get(\"name\")\n    if isinstance(name, str) and name:\n        # Supabase Storage list may return names either:\n        # - relative to the provided prefix (e.g. \"FOO.md\"), or\n        # - full object keys (e.g. \".agents/FOO.md\").\n        if name.startswith(\".agents/\"):\n            print(name)\n        else:\n            print(f\".agents/{name}\")\n')"

if [[ -z "${object_paths//[[:space:]]/}" ]]; then
  warn "No .agents objects found in bucket '${WORKSPACE_BUCKET}'. Nothing to download."
  exit 0
fi

if [[ "${CLEAN_DEST}" == "true" ]]; then
  if [[ "${ASSUME_YES}" != "true" ]]; then
    if ! ask_yes_no "This will delete local contents of ${AGENTS_DEST} before downloading. Continue?" "n"; then
      warn "Aborted."
      exit 1
    fi
  fi
  rm -rf "${AGENTS_DEST}"
fi

mkdir -p "${AGENTS_DEST}"

downloaded_count=0
while IFS= read -r object_path; do
  [[ -n "${object_path}" ]] || continue
  rel_path="${object_path#.agents/}"
  dest_path="${AGENTS_DEST}/${rel_path}"
  dest_dir="$(dirname "${dest_path}")"
  mkdir -p "${dest_dir}"

  encoded_path="$(urlencode_path "${object_path}")"
  tmp_path="${dest_path}.tmp.$$"

  # Note: GET /storage/v1/object/<bucket>/<path> returns the raw object body.
  curl -fsS \
    "${SUPABASE_API_URL}/storage/v1/object/${WORKSPACE_BUCKET}/${encoded_path}" \
    -H "apikey: ${SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
    -o "${tmp_path}"

  mv -f "${tmp_path}" "${dest_path}"
  downloaded_count=$((downloaded_count + 1))
done <<< "${object_paths}"

log "Downloaded ${downloaded_count} file(s) from ${WORKSPACE_BUCKET}/.agents into ${AGENTS_DEST}."
