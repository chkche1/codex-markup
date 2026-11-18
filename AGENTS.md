# AGENTS.md — Inline HTML Review Integration for Codex

Whenever you create or update an HTML artifact/page for the user, or when the user asks to review an HTML file or address inline comments:

1. **Open HTML Preview with Inline Commenting**:
   - Prefer the MCP tool `open_html_review` (if configured), or run:
     ```bash
     node --no-warnings <path-to-codex-markup>/src/cli.ts serve <file.html>
     ```
     *(When running inside this repository, you can use `src/cli.ts` directly.)*
2. **Wait for or Fetch Inline Comments**:
   - To block until the user clicks **"🚀 Submit to Codex"** in the browser, call MCP `wait_for_review` or run:
     ```bash
     node --no-warnings <path-to-codex-markup>/src/cli.ts wait <file.html>
     ```
   - To inspect existing open comments without blocking, call MCP `get_inline_comments` or run:
     ```bash
     node --no-warnings <path-to-codex-markup>/src/cli.ts comments <file.html> --status open
     ```
3. **Edit & Respond Inline**:
   - Edit `<file.html>` to implement requested changes (the browser auto-reloads live).
   - Reply to each comment thread using MCP `reply_to_comment` or:
     ```bash
     node --no-warnings <path-to-codex-markup>/src/cli.ts reply <file.html> <comment-id> "<your response>" --resolve
     ```

---

## Repository Development & Architecture Guide

### Module Map

| Path | Responsibility |
| :--- | :--- |
| `src/cli.ts` | CLI entry point (`serve`, `mcp`, `wait`, `comments` / `list`, `add-comment`, `reply`, `resolve`, `restart`, `install`, `setup`) and Codex Desktop/CLI installer (`installForCodex`). |
| `src/server.ts` | `InlineReviewServer` HTTP + Server-Sent Events (SSE) server, static relative asset serving, `<script>` widget injection (`injectReviewWidget`), `fs.watch` live-reload watchers, and background `codex exec --ephemeral` dispatch (`runBackgroundCodex`). |
| `src/widget.ts` | Client-side review overlay (`getWidgetScript`) mounted inside an open Shadow DOM (`#codex-inline-review-root`) with text selection highlighting, DOM element picker, dark floating popovers (`openComposerPopover`, `openThreadPopover`), Web Speech dictation (`🎙️`), collapsible right-hand thread drawer (`💬 Threads`), and SSE synchronization. |
| `src/mcp.ts` | Zero-dependency JSON-RPC 2.0 MCP stdio server (`startMcpServer`) supporting both newline-delimited and `Content-Length` framing, exposing `open_html_review`, `wait_for_review`, `get_inline_comments`, `reply_to_comment`, and `resolve_comment`. |
| `src/store.ts` | Sidecar persistence (`<file.html>.comments.json`), thread CRUD (`createThread`, `addReply`, `updateThreadStatus`, `deleteThread`, `markSubmitted`), filesystem wait fallback (`waitForFileSubmission`), and Markdown prompt formatting (`formatReviewForCodex`). |
| `test/eval.test.ts` | Evaluation and integration test suite validating store persistence, server HTTP/SSE/API routes, MCP JSON-RPC protocol, CLI commands, and widget behavior. |

### Zero External Runtime Dependency Constraint

- **Node.js `>=22.6.0` Native TypeScript Execution:** All TypeScript modules run directly via `node --no-warnings src/cli.ts` using Node's built-in type-stripping (ESM `"type": "module"`, explicit `.ts` relative imports per `tsconfig.json`).
- **No Third-Party Runtime Dependencies:** `package.json` must maintain zero runtime npm dependencies. Only use Node.js built-in `node:*` modules (`node:http`, `node:fs`, `node:path`, `node:os`, `node:crypto`, `node:child_process`) on the backend and standard browser APIs in `src/widget.ts`.
- **Shadow DOM Isolation:** Keep all client-side overlay UI in `src/widget.ts` encapsulated within `#codex-inline-review-root` Shadow DOM (except the minimal `.cir-text-highlight` `<mark>` wrappers and `.cir-element-pulse` / `.cir-pick-mode` markers) so reviewed pages retain their own styling without CSS collisions.

### Testing & Verification

- Always run the evaluation suite after making code changes:
  ```bash
  npm test
  ```
- Keep `examples/*.comments.json` clean when testing against `examples/demo.html` (gitignored by default).
