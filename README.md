# `codex-markup`

**Claude Artifacts / Google Docs-style inline HTML preview, commenting, and live reload for OpenAI Codex (Codex Desktop App & Codex CLI).**

---

## Overview & Why `codex-markup`

When building dashboards, landing pages, prototypes, or interactive reports with Codex, describing visual tweaks in chat ("change the padding on the third KPI card and tighten the second paragraph") is slow and imprecise.

`codex-markup` wraps any local `.html` file in a lightweight local review server (`http://127.0.0.1:4321`) and injects an isolated review overlay directly onto the rendered page:

1. **Highlight any text** or **click any DOM element** to drop numbered comment pins directly on the page.
2. **Submit inline threads to Codex** with exact CSS selectors, quoted text + surrounding context, outerHTML snippets, and thread history.
3. **Watch edits happen live** — as Codex edits the HTML file and replies to each thread, Server-Sent Events (SSE) reload the preview and update thread statuses in real time.

No build step, no third-party npm runtime dependencies, and works seamlessly with both **Codex Desktop (`ChatGPT.app` / `Codex.app`)** and **Codex CLI**.

---

## Key Features

- **Text-Selection Commenting (Google Docs / Claude Artifacts style):** Highlight any phrase or sentence on the rendered page and click the floating **`💬 Comment on selection`** pill. Captures exact `selectedText`, 40-character `prefixText`/`suffixText` context, CSS selector, and DOM snippet.
- **DOM Element Picker (Figma / Vercel Toolbar style):** Click **`🎯 Pick Element`** in the bottom floating dock—or hold **`Option` / `Alt` + Click** anywhere on the page—to inspect elements with a live tag & CSS selector overlay and pin comments with relative click coordinates (`offsetXRatio`, `offsetYRatio`).
- **Inline Dark Floating Thread Popovers:** Clicking any numbered pin, highlighted text mark, or creating a new comment opens a compact dark floating popover (`openComposerPopover` / `openThreadPopover`, `340px` wide) anchored directly below the target pin and clamped cleanly within the viewport. Supports `Enter` to submit, `Shift+Enter` for multiline notes, `Escape` to close, plus one-click Resolve (`✓`), Delete (`🗑`), and follow-up replies.
- **`[✓] Send to Codex` Auto-Dispatch Checkbox:** Checked by default in both compose and reply popovers so submitting a single comment immediately dispatches Codex. Uncheck it to queue multiple comments across the page and send them together with **`🚀 Submit to Codex`**.
- **Voice Mode (`🎙️`):** Click the microphone button inside any comment or reply popover to dictate feedback hands-free using the browser's Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) with live interim transcript preview.
- **Collapsible Right-Hand Thread Drawer (`💬 Threads`):** Toggle the `300px` right-hand drawer from the floating dock to filter `All`, `Active`, and `Resolved` threads, jump to any anchored element with a highlight pulse, reply/resolve/delete, or click **`📋`** to copy the formatted Markdown review prompt.
- **Live SSE Reload & Shadow DOM Isolation:** Subscribes to `/__inline_review__/events` for `html-updated` (auto-reloads preview on HTML edits), `comments-updated` (live-syncs Codex replies and status changes), `agent-status` (shows live working progress and completion/error toasts), and `waiters-updated` (`Codex listening` indicator). All overlay UI lives inside an open Shadow DOM (`#codex-inline-review-root`) so host page styles never collide.

---

## Requirements & Installation

### Requirements

- **Node.js `>=22.6.0`** (uses native TypeScript type-stripping via `node --no-warnings`; **zero** external runtime npm dependencies)
- **OpenAI Codex Desktop App** (`ChatGPT.app` / `Codex.app`) and/or **Codex CLI**

### Platform Support

| Platform | Status | Notes |
| :--- | :--- | :--- |
| **macOS** | Full support | Opens default browser with `open`; auto-detects Codex Desktop CLI inside `/Applications/ChatGPT.app` and `/Applications/Codex.app`; `restart` uses graceful `/__inline_review__/api/shutdown` with `lsof` fallback; Voice Mode (`🎙️`) works in Chrome, Edge, and Safari. |
| **Linux** | Full support | Opens default browser with `xdg-open`; `restart` uses graceful `/__inline_review__/api/shutdown` with `lsof` fallback; verified in CI on `ubuntu-latest` across Node.js 22 and 24; Voice Mode (`🎙️`) works in Chrome and Edge on `http://127.0.0.1:4321`. |
| **Windows / WSL2** | Supported | Native Windows opens the default browser with `cmd /c start` (WSL2 uses `xdg-open`, or open `http://127.0.0.1:4321` directly in your Windows browser); `restart` stops an existing instance cross-platform via graceful `/__inline_review__/api/shutdown` without requiring `lsof`; Voice Mode (`🎙️`) works in Chrome and Edge on `http://127.0.0.1:4321`. |

### 1. Clone & Try the Demo

```bash
git clone https://github.com/chkche1/codex-markup.git
cd codex-markup
npm run demo
```

This starts the review server on `http://127.0.0.1:4321` and opens [`examples/demo.html`](examples/demo.html) in your browser.

### 2. One-Command Codex Setup (Recommended)

```bash
npm run install-codex
# or directly:
node --no-warnings src/cli.ts install
```

Running `install` (pass `--codex-home <dir>` or set `CODEX_HOME` to target a custom directory, defaulting to `~/.codex`) automatically configures:

1. **`~/.codex/config.toml`** — Registers `[mcp_servers.inline-review]`.
2. **`~/.codex/skills/inline-html-review/SKILL.md`** — Installs the Codex skill for HTML inline reviews.
3. **`~/.codex/AGENTS.md`** — Appends or updates the `<!-- BEGIN CODEX-INLINE-REVIEW -->` workflow instructions.

### 3. Manual `~/.codex/config.toml` Setup

If you prefer configuring Codex manually, add the following to `~/.codex/config.toml` (replacing `<path-to-codex-markup>` with your local clone path):

```toml
[mcp_servers.inline-review]
command = "node"
args = ["--no-warnings", "<path-to-codex-markup>/src/cli.ts", "mcp"]
```

You can also run `node --no-warnings src/cli.ts setup` to print ready-to-paste `config.toml` and `codex -c ...` snippets with your local repository path resolved automatically.

---

## How to Use

### 1. Auto-Dispatch Flow (`[✓] Send to Codex` / Background `codex exec`)

Even if you launch the server directly from the terminal without an active MCP wait call (`npm run demo` or `node --no-warnings src/cli.ts serve page.html`):

1. Leave an inline comment in the browser with **`[✓] Send to Codex`** checked (or uncheck it while adding several pins, then click **`🚀 Submit to Codex`**).
2. When no MCP `wait_for_review` or CLI `wait` call is actively waiting (`notifiedWaiters === 0`), the server automatically spawns a background **`codex exec --ephemeral`** process scoped strictly to the target HTML file (`-C <html-dir>` with `mcp_servers={}` so it does not waste time searching unrelated repository files, reading project `AGENTS.md` files, or running project test suites unless explicitly requested in a comment).
3. **Sandbox Mode (`workspace-write` by default):** Background `codex exec` runs in **`workspace-write`** sandbox mode by default so Codex can edit only files inside the HTML file's directory (with network access blocked).
   - **Switch live in the browser UI:** Click the **`🔒 Sandboxed` / `🔓 Full Access`** toggle button in the bottom floating dock anytime (no restart required) when you need Codex to fetch external URLs (such as web fonts) or access files outside the HTML folder.
   - **Configure at startup:** Pass `--sandbox full-access` to `serve` / `mcp` / `restart`, or set `CODEX_MARKUP_SANDBOX=full-access` in `[mcp_servers.inline-review.env]` inside `~/.codex/config.toml`.
4. **Binary Resolution:** When locating the `codex` binary (`CODEX_CLI_PATH` overrides all), the server prefers the Desktop app's bundled CLI inside `/Applications/ChatGPT.app` or `/Applications/Codex.app` before older Homebrew (`/opt/homebrew/bin/codex`) or `/usr/local/bin/codex` installs.
5. Codex edits the HTML file directly (triggering an instant browser reload via `html-updated`) and posts replies back to each comment thread via `cli.ts reply ... --resolve` (or if it exits with a final response without invoking `reply`, the server automatically attaches its response as a fallback reply).

### 2. Interactive MCP Flow (Codex Desktop & Codex CLI)

When registered in `~/.codex/config.toml`, Codex has access to five MCP tools (`src/mcp.ts`):

| MCP Tool | Arguments | Behavior |
| :--- | :--- | :--- |
| `open_html_review` | `file_path` (required)<br>`open_browser` (boolean, default `true`)<br>`wait_for_submission` (boolean, default `false`) | Ensures the review server is running, opens the review URL in the browser, and optionally blocks until submission. |
| `wait_for_review` | `file_path` (required)<br>`timeout_seconds` (number, default `600`) | Blocks until the user clicks **🚀 Submit to Codex** (with `.comments.json` file-watch fallback if loopback networking is sandboxed) and returns all open threads in Markdown. |
| `get_inline_comments` | `file_path` (required)<br>`status` (`"open" \| "answered" \| "resolved" \| "all"`, default `"open"`) | Non-blocking read of inline comment threads, CSS selectors, highlighted text quotes, surrounding context, and DOM snippets. |
| `reply_to_comment` | `file_path` (required)<br>`comment_id` (required, e.g. `"c-1"` or `"1"`)<br>`reply` (required)<br>`status` (`"answered" \| "resolved" \| "open"`, default `"answered"`) | Posts Codex's reply into the specified thread and broadcasts a `comments-updated` SSE event to the browser immediately. |
| `resolve_comment` | `file_path` (required)<br>`comment_id` (required)<br>`status` (`"resolved" \| "open" \| "answered"`, default `"resolved"`) | Updates a thread's status (`resolved`, `open`, or `answered`) and syncs live to the browser. |

While `wait_for_review` (or `cli.ts wait`) is blocking, the dock displays **`Codex listening`**, and submitting sends feedback straight back to the waiting Codex turn instead of spawning a second `codex exec` process.

### 3. CLI Reference

Run commands with `node --no-warnings src/cli.ts <command>` (or `codex-markup <command>` if linked via `npm link`):

| Command | Description & Flags |
| :--- | :--- |
| `serve [file.html]` | Start the local review server (or connect to an existing instance on the port) and open `[file.html]` in the browser. Flags: `-p, --port <number>` (default `4321` or `$CODEX_REVIEW_PORT`), `--sandbox <workspace-write\|full-access>`, `--no-open`. |
| `mcp` | Start the JSON-RPC 2.0 MCP stdio server (supports newline-delimited and `Content-Length` framing). Flags: `-p, --port <number>`, `--sandbox <workspace-write\|full-access>`. |
| `wait <file.html>` | Block (up to 600s) until the user clicks **🚀 Submit to Codex**, then print the formatted Markdown prompt. Flags: `-p, --port <number>`. |
| `comments <file.html>` | Print inline comments from `<file.html>.comments.json` (alias: `list`). Flags: `--status open\|answered\|resolved\|all` (default `open`). |
| `add-comment <file.html> <text>` | Programmatically add an element-targeted comment via the live API or sidecar file. Flags: `--selector "<css>"` (default `"body"`), `--tag "<tag>"`, `-p, --port <number>`. |
| `reply <file.html> <id> <text>` | Post a `codex` reply to a thread and push a live SSE update. Flags: `--resolve` (sets status to `resolved`), `--status open\|answered\|resolved` (default `answered`), `-p, --port <number>`. |
| `resolve <file.html> <id>` | Mark a thread `resolved` (or reopen it with `--reopen`). Flags: `--reopen`, `-p, --port <number>`. |
| `restart [file.html]` | Stop any running server on the port, start a detached background server (`--no-open`), wait for `/__inline_review__/api/health`, and optionally trigger `/__inline_review__/api/submit` for `[file.html]`. Flags: `-p, --port <number>`, `--sandbox <workspace-write\|full-access>`. |
| `install` | Configure `config.toml`, `skills/inline-html-review/SKILL.md`, and `AGENTS.md` inside `~/.codex` (or `$CODEX_HOME`). Flags: `--codex-home <dir>`. |
| `setup` | Print copy-pasteable `~/.codex/config.toml`, one-line `codex -c ...` overrides, and skill instructions. |

---

## Voice Mode (`🎙️`) & Browser Compatibility Matrix

The **`🎙️`** microphone button inside comment and reply popovers uses the browser's built-in **Web Speech API** (`SpeechRecognition` / `webkitSpeechRecognition`), leveraging `http://127.0.0.1:4321` as a trusted localhost secure context:

| Browser | Voice Mode (`🎙️`) Support | Notes |
| :--- | :--- | :--- |
| **Google Chrome** | Full support | Uses Chrome's `webkitSpeechRecognition` service (requires mic permission & internet access). |
| **Microsoft Edge** | Full support | Native Web Speech API support. |
| **Safari (macOS)** | Supported | Uses `SpeechRecognition` / `webkitSpeechRecognition` (requires Siri/Dictation enabled in macOS Settings). |
| **Arc / Brave / Chromium forks** | Partial / varies | Many Chromium forks strip Google's Speech API keys or block the speech endpoint (`network` error). Use Chrome/Safari, or macOS Dictation below. |
| **Firefox** | Not supported | Web Speech recognition is disabled by default; clicking `🎙️` displays a browser compatibility notice. |

> **macOS Tip:** In any browser (including Firefox or Brave), you can focus any comment textarea and use macOS native Dictation (`Fn` twice, or **Edit → Start Dictation**).

---

## Collaboration Workflows

- **Single-User + Codex:** Preview generated HTML artifacts locally, annotate layout or copy issues visually, let Codex edit the HTML and resolve threads automatically, and watch SSE reload the page after each pass.
- **Multi-Agent Review Passes:** Use one agent (QA / design reviewer) to inspect the rendered page or add structured comments via `add-comment` / `get_inline_comments`, and a second agent (implementer) to edit the HTML and close each thread via `reply <file.html> <id> "..." --resolve`.
- **Git-Tracked `.html.comments.json` Sidecar Reviews:** All threads, targets, replies, and submission counts for `page.html` are stored as clean JSON in `page.html.comments.json` right beside the HTML file. Commit sidecar files alongside HTML prototypes in pull requests for async code review, or ignore temporary demo sidecars via `.gitignore` (`examples/*.comments.json`).
- **Shared Tunnel / Tailscale Reviews:** Because the server binds to `127.0.0.1` and enforces a localhost/loopback `Origin` guard (`http://127.0.0.1:<port>` or `http://localhost:<port>`), teammates can join a shared review session by port-forwarding `127.0.0.1:4321` locally over **SSH (`ssh -L 4321:127.0.0.1:4321 ...`)** or a **Tailscale / local tunnel port forward** mapped onto `http://127.0.0.1:4321` to drop inline comments in their browser while Codex picks up and resolves threads locally. *(Note: Voice Mode requires HTTPS or a `localhost`/`127.0.0.1` secure context.)*

---

## Architecture & Testing

### Project Structure

```text
bin/codex-markup.js               Executable CLI shim (plus codex-inline-review alias)
src/
  cli.ts                          CLI command parser & Codex installer
  server.ts                       HTTP/SSE review server, file watchers & background codex exec
  widget.ts                       Shadow DOM review overlay, popovers, picker & voice mode
  mcp.ts                          JSON-RPC 2.0 MCP stdio server (5 tools)
  store.ts                        .comments.json sidecar store & Markdown formatter
skills/inline-html-review/        Codex skill definition
examples/demo.html                Interactive analytics dashboard demo
test/eval.test.ts                 Evaluation & integration test suite
```

### Running Tests

Run the evaluation suite with Node's native TypeScript runner:

```bash
npm test
```

GitHub Actions CI (`.github/workflows/ci.yml`) runs `npm test` on `ubuntu-latest` across Node.js `22` and `24`.

---

## License

[MIT](LICENSE)
