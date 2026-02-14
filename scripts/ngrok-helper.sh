#!/usr/bin/env bash

# Shared ngrok helper for local SupaClaw scripts.
# Can be sourced by other scripts, or executed directly.
#
# Functions (when sourced):
# - ngrok_get_https_tunnel_url
#     Prints active HTTPS tunnel URL or empty string.
# - ngrok_ensure_https_tunnel <port> [log_file] [retries] [sleep_seconds]
#     Reuses active HTTPS tunnel when available.
#     Starts ngrok tunnel if missing, waits, then prints URL.
#     Returns non-zero if no HTTPS tunnel becomes available.
#
# CLI usage (when executed):
#   ./scripts/ngrok-helper.sh check
#   ./scripts/ngrok-helper.sh ensure 54321 /tmp/ngrok-supabase.log 8 1

ngrok_get_https_tunnel_url() {
  python3 - <<'PY'
import json
import urllib.error
import urllib.request

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

ngrok_ensure_https_tunnel() {
  local port="${1:-54321}"
  local log_file="${2:-/tmp/ngrok-supabase.log}"
  local retries="${3:-8}"
  local sleep_seconds="${4:-1}"
  local ngrok_url
  local i=0

  ngrok_url="$(ngrok_get_https_tunnel_url)"
  if [[ -n "${ngrok_url}" ]]; then
    printf "%s\n" "${ngrok_url}"
    return 0
  fi

  if ! command -v ngrok >/dev/null 2>&1; then
    return 1
  fi

  ngrok http "${port}" >"${log_file}" 2>&1 &

  while (( i < retries )); do
    sleep "${sleep_seconds}"
    ngrok_url="$(ngrok_get_https_tunnel_url)"
    if [[ -n "${ngrok_url}" ]]; then
      printf "%s\n" "${ngrok_url}"
      return 0
    fi
    ((i += 1))
  done

  return 1
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  command_name="${1:-check}"
  case "${command_name}" in
    check)
      ngrok_get_https_tunnel_url
      ;;
    ensure)
      shift || true
      ngrok_ensure_https_tunnel "$@"
      ;;
    *)
      printf "Usage: %s [check|ensure <port> [log_file] [retries] [sleep_seconds]]\n" "$0" >&2
      exit 1
      ;;
  esac
fi
