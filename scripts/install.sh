#!/usr/bin/env bash
# Install or update the rprr release binary, then check dependencies and set up.
# curl -fsSL https://github.com/moyerdestroyer/rprr/releases/latest/download/install.sh | bash
set -euo pipefail

repo="${RPRR_RELEASE_REPO:-moyerdestroyer/rprr}"
install_dir="${RPRR_INSTALL_DIR:-${HOME}/.local/bin}"
os="${RPRR_INSTALL_OS:-$(uname -s)}"
arch="${RPRR_INSTALL_ARCH:-$(uname -m)}"
config_home="${XDG_CONFIG_HOME:-${HOME}/.config}"
config_file="${config_home}/rprr/config.json"
unit_file="${config_home}/systemd/user/rprr.service"
dest="${install_dir}/rprr"

libc() {
  if [ -n "${RPRR_INSTALL_LIBC:-}" ]; then
    printf "%s\n" "$RPRR_INSTALL_LIBC"
    return
  fi
  if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    printf "%s\n" musl
    return
  fi
  printf "%s\n" glibc
}

asset_name() {
  if [ "$os" != "Linux" ]; then
    printf "rprr releases are built for Linux. Current system: %s\n" "$os" >&2
    exit 1
  fi
  if [ "$(libc)" != "glibc" ]; then
    printf "This installer publishes glibc builds. musl systems such as Alpine are not supported yet.\n" >&2
    exit 1
  fi
  case "$arch" in
    x86_64 | amd64) printf "%s\n" "rprr-linux-x64" ;;
    aarch64 | arm64) printf "%s\n" "rprr-linux-arm64" ;;
    *)
      printf "Unsupported architecture: %s\n" "$arch" >&2
      exit 1
      ;;
  esac
}

resolve_release() {
  asset="$(asset_name)"
  if [ -n "${RPRR_RELEASE_DIR:-}" ]; then
    tag="$(tr -d "[:space:]" < "${RPRR_RELEASE_DIR}/VERSION")"
    sums="${RPRR_RELEASE_DIR}/SHA256SUMS"
    source_asset="${RPRR_RELEASE_DIR}/${asset}"
    return
  fi
  local latest effective
  latest="https://github.com/${repo}/releases/latest"
  if ! effective="$(curl -fsSL -o /dev/null -w "%{url_effective}" "$latest")"; then
    printf "Could not find a GitHub release for %s.\n" "$repo" >&2
    exit 1
  fi
  tag="${effective##*/}"
  case "$tag" in
    v*) ;;
    *)
      printf "Could not resolve the latest release (got: %s).\n" "$tag" >&2
      exit 1
      ;;
  esac
  work="$(mktemp -d)"
  sums="${work}/SHA256SUMS"
  source_asset="${work}/${asset}"
  curl -fsSL -o "$sums" "https://github.com/${repo}/releases/download/${tag}/SHA256SUMS"
}

download_asset() {
  if [ -n "${RPRR_RELEASE_DIR:-}" ]; then
    return
  fi
  curl -fsSL -o "$source_asset" "https://github.com/${repo}/releases/download/${tag}/${asset}"
}

expected_checksum() {
  awk -v asset="$asset" '$2 == asset { print $1 }' "$sums"
}

install_binary() {
  local expected actual
  expected="$(expected_checksum)"
  if [ -z "$expected" ]; then
    printf "Checksum file has no entry for %s.\n" "$asset" >&2
    exit 1
  fi
  download_asset
  actual="$(sha256sum "$source_asset" | awk '{ print $1 }')"
  if [ "$actual" != "$expected" ]; then
    printf "Checksum mismatch for %s.\n" "$asset" >&2
    exit 1
  fi
  mkdir -p "$install_dir"
  stage="$(mktemp "${install_dir}/.rprr.XXXXXX")"
  cp "$source_asset" "$stage"
  chmod 755 "$stage"
  if ! "$stage" --version >/dev/null 2>&1; then
    printf "The downloaded rprr binary did not start.\n" >&2
    exit 1
  fi
  mv -f "$stage" "$dest"
  stage=""
}

remember_path() {
  local rc
  case "$(basename "${SHELL:-}")" in
    bash) rc="${HOME}/.bashrc" ;;
    zsh) rc="${HOME}/.zshrc" ;;
    *) return ;;
  esac
  if [ -f "$rc" ] && grep -q "# rprr installer" "$rc"; then
    return
  fi
  if printf "\n# rprr installer\nexport PATH=\"%s:\$PATH\"\n" "$install_dir" >> "$rc"; then
    printf "Added %s to PATH in %s. Open a new terminal to use rprr.\n" "$install_dir" "$rc"
  else
    printf "Could not update %s.\n" "$rc" >&2
  fi
}

warn_path() {
  case ":${PATH}:" in
    *":${install_dir}:"*) ;;
    *)
      printf "Add %s to PATH:\n  export PATH=\"%s:\$PATH\"\n" "$install_dir" "$install_dir"
      remember_path
      ;;
  esac
  local resolved
  resolved="$(command -v rprr || true)"
  if [ -n "$resolved" ] && [ "$resolved" != "$dest" ]; then
    printf "Another rprr is earlier on PATH: %s\nThe new binary is %s.\n" "$resolved" "$dest"
  fi
}

finish_setup() {
  if [ -f "$config_file" ]; then
    printf "Existing configuration kept: %s\n" "$config_file"
    if [ "$changed" = 1 ] && [ -f "$unit_file" ]; then
      if ! "$dest" service install; then
        printf "rprr was updated, but the systemd unit was not refreshed. Run: rprr service install\n" >&2
      fi
    fi
    "$dest" doctor
    return
  fi
  "$dest" doctor || true
  if [ "${RPRR_INSTALL_ASSUME_TTY:-}" = 1 ] || { [ -t 1 ] && [ -r /dev/tty ]; }; then
    printf "Starting setup.\n"
    if [ "${RPRR_INSTALL_ASSUME_TTY:-}" = 1 ]; then
      "$dest" setup
    else
      "$dest" setup </dev/tty
    fi
    return
  fi
  printf "Installed rprr %s. Run: rprr doctor && rprr setup\n" "$tag"
}

work=""
stage=""
cleanup() {
  if [ -n "$stage" ]; then
    rm -f "$stage"
  fi
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}
trap cleanup EXIT

resolve_release
changed=0
if [ -f "$dest" ] && [ "$(sha256sum "$dest" | awk '{ print $1 }')" = "$(expected_checksum)" ]; then
  printf "rprr %s is already installed.\n" "$tag"
else
  install_binary
  changed=1
  if [ -f "$config_file" ]; then
    printf "Updated rprr to %s.\n" "$tag"
  else
    printf "Installed rprr %s.\n" "$tag"
  fi
fi
warn_path
finish_setup
