# AGENTS.md — Runbook & Development Guide for `codex-markup`

Use this guide when asked to **install, check, update, sync, uninstall, use, or modify** `codex-markup`.

---

## Quick Decision Table

| User Request | Command / Tool to Run | Notes / Next Step |
| :--- | :--- | :--- |
| **Install for Codex** | `curl -fsSL https://raw.githubusercontent.com/chkche1/codex-markup/main/install.sh \| bash` | Run **one** command; do **not** run `npm install` or `npm run demo`. Tell user to restart Codex. |
| **Install from local checkout** | `npm run install-codex` | Registers checkout in-place (`managed: false`). Tell user to restart Codex. |
| **Check health & skill drift** | `node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts doctor --json` *(or `npm run doctor` in checkout)* | Inspect `ok`, `needsSync`, `customizedFiles`, and `checks`. |
| **Check for updates** | `node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts update --check --json` | Non-mutating. Check `managed`, `updateAvailable`, `needsSync`, `customizedFiles`. |
| **Update managed install** | `node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts update --json` | Supports `--from <dir\|.tgz>`. Tell user to restart Codex if `restartRequired: true`. |
| **Sync after `git pull`** | `npm run sync` *(or `node --no-warnings src/cli.ts sync --json`)* | Use for `managed: false` checkouts or local drift repair. Never runs `git pull`. |
| **Use `~/.agents/skills` instead of `~/.codex/skills`** | Add `--skill-scope agents` to `install` or `sync` | Moves the owned skill folder and removes the old duplicate. |
| **Uninstall** | `node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts uninstall --json` | Optional `--keep-runtime`. Tell user to restart Codex and close preview servers. |
| **Preview / review HTML** | Prefer MCP `open_html_review`, `wait_for_review`, `get_inline_comments`, `reply_to_comments` | Fallback to CLI (`serve`, `wait`, `comments`, `reply-batch`). |

*(If Codex was installed under a custom path via `CODEX_HOME` or `CODEX_MARKUP_DIR`, use that path instead of `~/.codex/tools/codex-markup`.)*

---

## Agent Playbooks (Install, Update, Sync, Verify, Uninstall)

### 1. Installing `codex-markup`
- **Requires:** Node.js `22.18+ (22.x)` or `24+`. Zero runtime npm dependencies — **never run `npm install` or `npm run demo` during setup**.
- **Standard managed install** (downloads to `~/.codex/tools/codex-markup`, stages and verifies an isolated 6-tool MCP handshake, swaps atomically, and rolls back on failure):
  ```bash
  curl -fsSL https://raw.githubusercontent.com/chkche1/codex-markup/main/install.sh | bash
  ```
- **Inside an existing local checkout** (keeps Codex linked to the checkout with `managed: false`):
  ```bash
  npm run install-codex
  ```
- **Useful options:**
  - `CODEX_HOME=/custom/dir` / `--codex-home <dir>`: target a non-default Codex config directory.
  - `CODEX_MARKUP_DIR=/custom/runtime` / `--install-dir <dir>`: install managed runtime into a custom directory.
  - `--skill-scope agents`: place `inline-html-review` in `~/.agents/skills/` instead of `~/.codex/skills/` (prevents duplicate skill entries).
  - `--force` (or `curl ... | bash -s -- --force`): overwrite locally customized `SKILL.md` or `AGENTS.md` marker blocks.
- **After install:** Inform the user to **restart Codex** so `[mcp_servers.inline-review]` loads.

### 2. Checking, Updating, and Syncing Skills & Runtime
Always inspect state first using `--json`:
```bash
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts update --check --json
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts doctor --json
```
*(In a local repo checkout, replace the CLI path with `src/cli.ts` or run `npm run doctor`.)*

Follow the result cleanly:
- **Managed install (`managed: true`):**
  - If `updateAvailable: true`, run:
    ```bash
    node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts update --json
    ```
    Or offline/local archive/dir update: `update --from <path-to-dir-or-tgz> --json`.
  - If `updateAvailable: false` and `needsSync: true`, run `sync --json`.
- **Contributor checkout (`managed: false`):**
  - **`update` refuses to overwrite or `git pull` unmanaged checkouts.**
  - Do not pull or rewrite a user's git branch unless they ask; after `git pull`, refresh `~/.codex` (`SKILL.md`, `AGENTS.md` marker block, `config.toml`, Manifest v2 hashes) by running:
    ```bash
    npm run sync
    ```
- **Local edit safety (`UserCustomizationError` / non-empty `customizedFiles`):**
  - `install`, `sync`, and `update` refuse to overwrite user-edited files in `skillDir` or the `AGENTS.md` marker block unless `--force` is passed.
  - **Do not pass `--force` automatically.** Report the paths in `customizedFiles` and ask the user whether to overwrite them or keep their edits.
- **Duplicate skill warning (`skill-duplicates` in `doctor`):**
  - If `doctor` warns that `inline-html-review` exists in both `~/.codex/skills` and `~/.agents/skills`, run `sync --skill-scope codex --json` or `sync --skill-scope agents --json` to keep one canonical copy.
- **After `update` or `sync`:** Whenever `restartRequired: true` (or MCP/config changed), tell the user to **restart Codex** (and start a fresh thread to pick up updated skill/tool metadata).

### 3. Uninstalling
```bash
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts uninstall --json
```
Pass `--keep-runtime` to preserve the copied runtime directory. Removes `[mcp_servers.inline-review]`, the active `inline-html-review` skill directory, `AGENTS.md` marker block, and owned managed runtime (preserving contributor checkouts and unowned files). Tell the user to restart Codex and close any running `serve` processes.

---

## Inline HTML Review Workflow (For Reviewed Pages)

Whenever you create or update an HTML artifact/page for the user, or when the user asks to review an HTML file or address inline comments:

1. **Open HTML Preview with Inline Commenting**:
   - Prefer MCP tool `open_html_review`, or run:
     ```bash
     node --no-warnings <path-to-codex-markup>/src/cli.ts serve <file.html>
     ```
     *(When running inside this repository, use `src/cli.ts` directly.)*
2. **Wait for or Fetch Inline Comments**:
   - Block until the user clicks **"🚀 Submit to Codex"** in the browser: call MCP `wait_for_review`, or run:
     ```bash
     node --no-warnings <path-to-codex-markup>/src/cli.ts wait <file.html>
     ```
   - Inspect open comments without blocking: call MCP `get_inline_comments`, or run:
     ```bash
     node --no-warnings <path-to-codex-markup>/src/cli.ts comments <file.html> --status open
     ```
3. **Edit & Respond Inline**:
   - Edit `<file.html>` to implement requested changes (the browser auto-reloads live via SSE).
   - For multiple comments, send all replies in one batch request via MCP `reply_to_comments` or:
     ```bash
     node --no-warnings <path-to-codex-markup>/src/cli.ts reply-batch <file.html> --stdin <<'EOF'
     [{"id":"c-1","reply":"<your response>","status":"resolved"}]
     EOF
     ```
   - For a single thread, use MCP `reply_to_comment` or `node --no-warnings <path-to-codex-markup>/src/cli.ts reply <file.html> <comment-id> "<your response>" --resolve`.

---

## Repository Development & Architecture Guide

### Module Map

| Path | Responsibility |
| :--- | :--- |
| `src/cli.ts` | CLI entry point (`serve`, `mcp`, `wait`, `comments` / `list`, `add-comment`, `reply`, `reply-batch`, `resolve`, `restart`, `install`, `sync`, `update`, `doctor`, `uninstall`, `setup`). |
| `src/install.ts` | Codex installer (`installForCodex`), `syncCodexSetup`, atomic self-updater (`updateInstallation`), Manifest v2 SHA-256 drift detection, `UserCustomizationError` edit protection, `--skill-scope codex\|agents`, `runDoctor`, and `uninstallFromCodex`. |
| `install.sh` | Fast standalone bootstrapper: locates Node `22.18+ (22.x) or 24+`, stages and verifies updates to `~/.codex/tools/codex-markup` (with tarball fallback), forwards `--force` and provenance metadata, and runs `install`. |
| `src/server.ts` | `InlineReviewServer` HTTP + SSE server, relative asset serving, `<script>` widget injection (`injectReviewWidget`), `fs.watch` live reload, model catalog discovery/capabilities, and background `codex exec --ephemeral` dispatch (`runBackgroundCodex`). |
| `src/widget.ts` | Client-side review overlay (`getWidgetScript`) mounted inside open Shadow DOM (`#codex-inline-review-root`) with text selection highlighting, DOM element picker, dark popovers, model selector dropdown, Web Speech dictation (`🎙️`), thread drawer (`💬 Threads`), and SSE synchronization. |
| `src/mcp.ts` | Zero-dependency JSON-RPC 2.0 MCP stdio server (`startMcpServer`) supporting newline-delimited and `Content-Length` framing, exposing `open_html_review`, `wait_for_review`, `get_inline_comments`, `reply_to_comment`, `reply_to_comments`, and `resolve_comment`. |
| `src/store.ts` | Sidecar persistence (`<file.html>.comments.json`), thread CRUD (`createThread`, `addReply`, `addRepliesBatch`, `updateThreadStatus`, `deleteThread`, `markSubmitted`), file-watch fallback (`waitForFileSubmission`), and Markdown prompt formatting (`formatReviewForCodex`). |
| `test/eval.test.ts` | Evaluation & integration test suite validating store, HTTP/SSE/API, MCP JSON-RPC, CLI commands, Manifest v2, sync/update rollback, and widget behavior offline. |

### Hard Invariants

- **Node.js `22.18+ (22.x) or 24+` Native TypeScript Execution:** All TypeScript runs directly via `node --no-warnings src/cli.ts` using native type-stripping (ESM `"type": "module"`, explicit `.ts` relative imports per `tsconfig.json`, erasable TS syntax only — no enums, runtime namespaces, or constructor parameter properties).
- **Zero External Runtime Dependencies:** `package.json` must maintain zero runtime npm dependencies (`node:*` built-ins and global `fetch` on the backend; standard browser APIs in `src/widget.ts`).
- **Shadow DOM Isolation:** Keep overlay UI in `src/widget.ts` inside `#codex-inline-review-root` Shadow DOM (minimal `.cir-text-highlight`, `.cir-element-pulse`, `.cir-pick-mode` host markers only).
- **Ownership & Tarball Safety:** Preserve `.codex-markup-owned.json` + `codex-markup-install.json` checks, atomic same-FS staging + rollback, tarball traversal/link rejection, and `--codex-home` test isolation from `~/.agents`.

### Testing & Verification

- Always run the full evaluation suite after making code changes (pass `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` for CI parity):
  ```bash
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null npm test
  ```
- Keep `examples/*.comments.json` clean when testing against `examples/demo.html` (gitignored by default).
