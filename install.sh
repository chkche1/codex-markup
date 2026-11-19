#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
INSTALL_DIR="${CODEX_MARKUP_DIR:-$CODEX_HOME/tools/codex-markup}"
REPO_URL="${CODEX_MARKUP_REPO:-https://github.com/chkche1/codex-markup.git}"
TARBALL_URL="${CODEX_MARKUP_TARBALL:-https://github.com/chkche1/codex-markup/archive/refs/heads/main.tar.gz}"

is_supported_node() {
  local bin="$1"
  [ -x "$bin" ] || return 1
  local ok
  ok="$("$bin" -p 'const [a,b]=process.versions.node.split(".").map(Number); a>22||(a===22&&b>=6)' 2>/dev/null || true)"
  [ "$ok" = "true" ]
}

find_node() {
  local candidate
  if command -v node >/dev/null 2>&1; then
    candidate="$(command -v node)"
    if is_supported_node "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/share/mise/shims/node" \
    "$HOME/.asdf/shims/node"
  do
    if is_supported_node "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  local version_candidates
  version_candidates="$(
    {
      ls -1d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null || true
      ls -1d "$HOME"/.local/share/fnm/node-versions/v*/installation/bin/node 2>/dev/null || true
    } | sort -r
  )"
  if [ -n "$version_candidates" ]; then
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      if is_supported_node "$candidate"; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done <<EOF
$version_candidates
EOF
  fi

  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "Error: codex-markup requires Node.js >= 22.6.0 for native TypeScript execution." >&2
  echo "Install or activate Node 22.6+ (e.g. 'brew install node', 'nvm install 22', or 'fnm install 22') and retry." >&2
  exit 1
fi

if [ -n "${CODEX_MARKUP_SOURCE_DIR:-}" ]; then
  "$NODE_BIN" --no-warnings "$CODEX_MARKUP_SOURCE_DIR/src/cli.ts" install \
    --codex-home "$CODEX_HOME" \
    --copy \
    --install-dir "$INSTALL_DIR"
  exit 0
fi

if [ -d "$INSTALL_DIR/.git" ] && command -v git >/dev/null 2>&1; then
  if ! git -C "$INSTALL_DIR" pull --ff-only --quiet; then
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 --quiet "$REPO_URL" "$INSTALL_DIR"
  fi
elif command -v git >/dev/null 2>&1; then
  mkdir -p "$(dirname "$INSTALL_DIR")"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --quiet "$REPO_URL" "$INSTALL_DIR"
elif command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
  tmp_tar="$(mktemp)"
  trap 'rm -f "$tmp_tar"' EXIT
  curl -fsSL "$TARBALL_URL" -o "$tmp_tar"
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  tar -xzf "$tmp_tar" --strip-components=1 -C "$INSTALL_DIR"
  rm -f "$tmp_tar"
  trap - EXIT
else
  echo "Error: git (or curl + tar) is required to download codex-markup." >&2
  exit 1
fi

"$NODE_BIN" --no-warnings "$INSTALL_DIR/src/cli.ts" install --codex-home "$CODEX_HOME"
