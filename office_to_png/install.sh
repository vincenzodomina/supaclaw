#!/usr/bin/env bash
set -euo pipefail

# office-to-png installer (macOS + Linux)
#
# What this script does:
# - Installs LibreOffice (required for .docx/.pptx/.xlsx conversions) and common fonts.
#   - macOS: uses Homebrew cask if available
#   - Linux: uses your system package manager (apt/dnf/yum/pacman/apk)
# - On Linux, also best-effort ensures Python 3 + venv support exist.
# - Creates an isolated virtualenv at:
#     ~/.office-to-png/.venv
# - Installs this repo's local `office_to_png` package into that venv.
# - Symlinks the CLI into:
#     ~/.local/bin/office-to-png
#
# How to use:
# - From the supaclaw repo root:
#     ./office_to_png/install.sh
#
# - Then run:
#     office-to-png --input /path/to/in.docx --outdir /path/to/out --dpi 200
#
# If `office-to-png` is not found, add this to your shell rc (~/.zshrc, ~/.bashrc):
#   export PATH="$HOME/.local/bin:$PATH"

PREFIX_DIR="${HOME}/.office-to-png"
VENV_DIR="${PREFIX_DIR}/.venv"
BIN_DIR="${HOME}/.local/bin"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

as_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    say "error: need root privileges for: $*"
    say "Install 'sudo' or re-run as root."
    exit 1
  fi
}

install_libreoffice_macos() {
  if have libreoffice || have soffice; then
    return 0
  fi

if have brew; then
    say "Installing LibreOffice via Homebrew..."
    brew install --cask libreoffice
  else
    say "error: LibreOffice not found, and Homebrew is not installed."
    say "Install LibreOffice manually, then re-run:"
    say "  - Download LibreOffice, or install Homebrew then: brew install --cask libreoffice"
    exit 1
  fi
}

install_libreoffice_linux() {
  if have libreoffice || have soffice; then
    return 0
  fi

  if have apt-get; then
    say "Installing LibreOffice (apt)..."
    as_root apt-get update -y
    # Prefer the smaller component set used in the Docker image; fall back to meta package.
    if ! as_root apt-get install -y --no-install-recommends \
      libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
      fontconfig fonts-liberation fonts-noto-core fonts-noto-cjk; then
      say "LibreOffice component install failed; falling back to 'libreoffice' meta package..."
      as_root apt-get install -y --no-install-recommends \
        libreoffice fontconfig fonts-liberation fonts-noto-core fonts-noto-cjk
    fi
  elif have dnf; then
    say "Installing LibreOffice (dnf)..."
    as_root dnf install -y libreoffice
  elif have yum; then
    say "Installing LibreOffice (yum)..."
    as_root yum install -y libreoffice
  elif have pacman; then
    say "Installing LibreOffice (pacman)..."
    as_root pacman -Sy --noconfirm libreoffice-fresh
  elif have apk; then
    say "Installing LibreOffice (apk)..."
    as_root apk add --no-cache libreoffice
  else
    say "error: could not detect a supported package manager to install LibreOffice."
    say "Install LibreOffice so that 'libreoffice' or 'soffice' is on PATH, then re-run."
    exit 1
  fi

  if have fc-cache; then
    as_root fc-cache -f >/dev/null 2>&1 || true
  fi

  if ! have libreoffice && ! have soffice; then
    say "error: LibreOffice install completed but 'libreoffice'/'soffice' not found on PATH."
    say "You may need to log out/in, or ensure LibreOffice binaries are on PATH."
    exit 1
  fi
}

ensure_python_tools_linux() {
  # Best-effort: ensure python3 + venv support exist on common VPS distros.
  if have python3 && python3 -c 'import sys; sys.exit(0)' >/dev/null 2>&1; then
    :
  elif have apt-get; then
    as_root apt-get update -y
    as_root apt-get install -y --no-install-recommends python3
  elif have dnf; then
    as_root dnf install -y python3
  elif have yum; then
    as_root yum install -y python3
  elif have pacman; then
    as_root pacman -Sy --noconfirm python
  elif have apk; then
    as_root apk add --no-cache python3
  fi

  # Ensure venv support (Debian/Ubuntu typically split this).
  if python3 -m venv --help >/dev/null 2>&1; then
    :
  elif have apt-get; then
    as_root apt-get install -y --no-install-recommends python3-venv
  fi
}

main() {
  case "$(uname -s)" in
    Darwin)
      install_libreoffice_macos
      ;;
    Linux)
      ensure_python_tools_linux
      install_libreoffice_linux
      ;;
    *)
      say "error: unsupported OS: $(uname -s)"
      exit 1
      ;;
  esac

  if [[ ! -d "${REPO_ROOT}/office_to_png" ]]; then
    say "error: expected to find '${REPO_ROOT}/office_to_png'."
    say "Run this installer from within the repo checkout."
    exit 1
  fi

  say "Setting up venv at ${VENV_DIR}..."
  mkdir -p "${PREFIX_DIR}"
  python3 -m venv "${VENV_DIR}"
  "${VENV_DIR}/bin/python" -m pip install -U pip >/dev/null

  say "Installing office-to-png from local repo checkout..."
  "${VENV_DIR}/bin/pip" install -e "${REPO_ROOT}/office_to_png"

  say "Linking binary into ${BIN_DIR}..."
  mkdir -p "${BIN_DIR}"
  ln -sf "${VENV_DIR}/bin/office-to-png" "${BIN_DIR}/office-to-png"

  say ""
  say "Installed: ${BIN_DIR}/office-to-png"
  if ! echo ":$PATH:" | grep -q ":${BIN_DIR}:"; then
    say "Add this to your shell rc if needed:"
    say "  export PATH=\"${BIN_DIR}:\$PATH\""
  fi
  say ""
  say "Try:"
  say "  office-to-png --input /path/to/in.docx --outdir /path/to/out --dpi 200"
}

main "$@"
