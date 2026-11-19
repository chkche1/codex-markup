#!/usr/bin/env bash
set -euo pipefail

codex_home="${CODEX_HOME:-$HOME/.codex}"
install_dir="${CODEX_MARKUP_DIR:-$codex_home/tools/codex-markup}"
REPO_URL="${CODEX_MARKUP_REPO:-https://github.com/chkche1/codex-markup.git}"
TARBALL_URL="${CODEX_MARKUP_TARBALL:-https://github.com/chkche1/codex-markup/archive/refs/heads/main.tar.gz}"

is_supported_node() {
  local bin="$1"
  [ -x "$bin" ] || return 1
  local ok
  ok="$("$bin" -p 'const [a,b]=process.versions.node.split(".").map(Number); a>=24||(a===22&&b>=18)' 2>/dev/null || true)"
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
  echo "Error: codex-markup requires Node.js 22.18+ (22.x) or 24+ for native TypeScript execution." >&2
  echo "Install or activate Node 22.18+ (e.g. 'brew install node', 'nvm install 22', or 'fnm install 22') and retry." >&2
  exit 1
fi

if [ -n "${CODEX_MARKUP_SOURCE_DIR:-}" ]; then
  "$NODE_BIN" --no-warnings "$CODEX_MARKUP_SOURCE_DIR/src/cli.ts" install \
    --codex-home "$codex_home" \
    --copy \
    --install-dir "$install_dir"
  exit 0
fi

# Resolve paths and refuse to replace directories that this installation does not own.
install_dir="$("$NODE_BIN" -p 'require("node:path").resolve(process.argv[1])' "$install_dir")"
codex_home="$("$NODE_BIN" -p 'require("node:path").resolve(process.argv[1])' "$codex_home")"
"$NODE_BIN" --input-type=module - "$install_dir" "$codex_home" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const [root, home] = process.argv.slice(2);
if (home === root || home.startsWith(root + path.sep)) {
  console.error('Runtime directory must not contain the Codex configuration directory.');
  process.exit(1);
}
if (!fs.existsSync(root)) process.exit(0);
let owned = false;
try {
  const marker = JSON.parse(fs.readFileSync(path.join(root, '.codex-markup-owned.json'), 'utf8'));
  owned = marker.managed === true && marker.runtimeRoot === root && marker.codexHome === home;
} catch {}
// Upgrade the original default install, which predates ownership markers.
if (!owned && root === path.join(home, 'tools', 'codex-markup')) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    owned = pkg.name === 'codex-markup' && config.includes(JSON.stringify(path.join(root, 'src', 'cli.ts')));
  } catch {}
}
if (!owned || fs.lstatSync(root).isSymbolicLink()) {
  console.error(`Refusing to replace an unowned installation directory: ${root}`);
  process.exit(1);
}
JS

mkdir -p "$(dirname "$install_dir")"
work="$(mktemp -d "$(dirname "$install_dir")/.codex-markup-stage.XXXXXX")"
had_runtime=0
if [ -d "$install_dir" ]; then had_runtime=1; fi
activated=0
registering=0
success=0
cleanup() {
  if [ "$success" = 0 ]; then
    if [ -d "$work/previous" ]; then
      rm -rf "$install_dir"
      mv "$work/previous" "$install_dir"
    elif [ "$activated" = 1 ] && [ "$had_runtime" = 0 ]; then
      rm -rf "$install_dir"
    fi
    if [ "$registering" = 1 ]; then
      for rel in config.toml AGENTS.md skills/inline-html-review codex-markup-install.json; do
        rm -rf "$codex_home/$rel"
        if [ -e "$work/config/$rel" ]; then
          mkdir -p "$(dirname "$codex_home/$rel")"
          cp -R "$work/config/$rel" "$codex_home/$rel"
        fi
      done
    fi
    echo "Installation failed; the previous installation has been preserved." >&2
  fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Downloading codex-markup…\n'
TIMEFORMAT='Download: %3R s'
if command -v git >/dev/null 2>&1; then
  time git clone --depth 1 --branch main --quiet "$REPO_URL" "$work/runtime"
elif command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
  time curl -fsSL "$TARBALL_URL" -o "$work/runtime.tar.gz"
  mkdir -p "$work/runtime"
  tar -xzf "$work/runtime.tar.gz" --strip-components=1 -C "$work/runtime"
else
  echo "Error: git (or curl + tar) is required to download codex-markup." >&2
  exit 1
fi

# Exercise the downloaded code before replacing the working runtime or real config.
if ! "$NODE_BIN" --no-warnings "$work/runtime/src/cli.ts" install \
  --codex-home "$work/verify-home" --copy --install-dir "$work/verify-runtime" >"$work/verify.log" 2>&1; then
  cat "$work/verify.log" >&2
  exit 1
fi

mkdir -p "$work/config"
for rel in config.toml AGENTS.md skills/inline-html-review codex-markup-install.json; do
  if [ -e "$codex_home/$rel" ]; then
    mkdir -p "$(dirname "$work/config/$rel")"
    cp -R "$codex_home/$rel" "$work/config/$rel"
  fi
done
if [ -d "$install_dir" ]; then mv "$install_dir" "$work/previous"; fi
activated=1
mv "$work/runtime" "$install_dir"
"$NODE_BIN" --input-type=module - "$install_dir" "$codex_home" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const [runtimeRoot, codexHome] = process.argv.slice(2);
fs.writeFileSync(path.join(runtimeRoot, '.codex-markup-owned.json'), JSON.stringify({ runtimeRoot, codexHome, managed: true }));
JS
registering=1
"$NODE_BIN" --no-warnings "$install_dir/src/cli.ts" install --codex-home "$codex_home" --copy --install-dir "$install_dir"
success=1
