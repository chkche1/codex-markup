# Contributing to `codex-markup`

Thanks for helping improve `codex-markup`! Please read this guide along with [`AGENTS.md`](AGENTS.md) before making changes.

## Repository Architecture

All source files live in `src/` and run directly with Node.js without a compile/bundle step:

| Path | Responsibility |
| :--- | :--- |
| [`src/cli.ts`](src/cli.ts) | CLI entry point (`serve`, `mcp`, `wait`, `comments` / `list`, `add-comment`, `reply`, `resolve`, `restart`, `install`, `setup`) and Codex Desktop/CLI installer (`installForCodex`). |
| [`src/server.ts`](src/server.ts) | `InlineReviewServer` HTTP + SSE server, relative static asset serving, widget injection (`injectReviewWidget`), `fs.watch` live reload, and background `codex exec --ephemeral` dispatch (`runBackgroundCodex`). |
| [`src/widget.ts`](src/widget.ts) | Client-side overlay (`getWidgetScript`) mounted in `#codex-inline-review-root`, including text highlighting, element picker, dark floating popovers (`openComposerPopover`, `openThreadPopover`), Web Speech dictation (`🎙️`), thread drawer (`💬 Threads`), and SSE sync. |
| [`src/mcp.ts`](src/mcp.ts) | Zero-dependency JSON-RPC 2.0 MCP stdio server (`startMcpServer`) supporting newline-delimited and `Content-Length` framing (`open_html_review`, `wait_for_review`, `get_inline_comments`, `reply_to_comment`, `resolve_comment`). |
| [`src/store.ts`](src/store.ts) | Sidecar persistence (`<file.html>.comments.json`), thread CRUD (`createThread`, `addReply`, `updateThreadStatus`, `deleteThread`, `markSubmitted`), file-watch fallback (`waitForFileSubmission`), and Markdown prompt formatting (`formatReviewForCodex`). |
| [`test/eval.test.ts`](test/eval.test.ts) | Evaluation and integration tests covering store persistence, HTTP/SSE/API routes, MCP JSON-RPC protocol, CLI commands, and widget behavior. |
| [`AGENTS.md`](AGENTS.md) | Codex integration instructions and repository invariants. |

## Core Design Constraints

1. **Zero External Runtime Dependencies (`Node.js >=22.6.0`):**
   - [`package.json`](package.json) must remain free of third-party runtime npm dependencies.
   - All TypeScript modules run directly via Node.js native type-stripping (`node --no-warnings src/cli.ts`), ESM (`"type": "module"`), and explicit `.ts` relative imports per [`tsconfig.json`](tsconfig.json).
   - Use only Node.js built-in `node:*` modules (`node:http`, `node:fs`, `node:path`, `node:os`, `node:crypto`, `node:child_process`) on the backend and standard browser APIs in `src/widget.ts`.
   - Keep TypeScript syntax compatible with Node's type-stripping (avoid enums, parameter properties, and runtime namespaces).

2. **Shadow DOM Isolation (`#codex-inline-review-root`):**
   - Keep all injected overlay UI in `src/widget.ts` encapsulated inside the open Shadow DOM (`#codex-inline-review-root`).
   - Only minimal host-page markers (`.cir-text-highlight` `<mark>` wrappers, `.cir-element-pulse`, and `.cir-pick-mode`) may touch the reviewed document's DOM so host page styling stays isolated.

## Development & Running Tests

Clone the repository and try the interactive demo:

```bash
git clone https://github.com/chkche1/codex-markup.git
cd codex-markup
npm run demo
```

Always run the evaluation suite before committing changes:

```bash
npm test
```

- GitHub Actions CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `npm test` on `ubuntu-latest` across Node.js `22` and `24`.
- Keep `examples/*.comments.json` clean when testing manually against [`examples/demo.html`](examples/demo.html) (ignored by default via `.gitignore`).

## Opening Pull Requests

1. Fork [chkche1/codex-markup](https://github.com/chkche1/codex-markup) and create a focused feature or fix branch.
2. Add or update coverage in [`test/eval.test.ts`](test/eval.test.ts) for any behavioral changes and verify `npm test` passes cleanly.
3. Confirm `package.json` still has zero external runtime dependencies and no temporary sidecar files (`examples/*.comments.json`) are staged.
4. Open a pull request with a clear summary of the change, motivation, and observed `npm test` output.
