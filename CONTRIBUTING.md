# Contributing to `codex-markup`

Thanks for helping improve `codex-markup`! Read this guide along with [`AGENTS.md`](AGENTS.md) before making changes.

## Repository Architecture

All source files live in `src/` and run directly with Node.js without a compile/bundle step:

| Path | Responsibility |
| :--- | :--- |
| [`src/cli.ts`](src/cli.ts) | CLI entry point (`serve`, `mcp`, `wait`, `comments` / `list`, `add-comment`, `reply`, `reply-batch`, `resolve`, `restart`, `install`, `sync`, `update`, `doctor`, `uninstall`, `setup`) and flag/JSON handling. |
| [`src/install.ts`](src/install.ts) | Codex Desktop/CLI installer (`installForCodex`), `syncCodexSetup`, atomic self-updater (`updateInstallation`), Manifest v2 SHA-256 drift detection, `UserCustomizationError` edit protection, `--skill-scope codex\|agents`, `runDoctor`, and `uninstallFromCodex`. |
| [`install.sh`](install.sh) | Standalone one-line bootstrapper locating Node `22.18+ (22.x) or 24+`, staging and verifying into `~/.codex/tools/codex-markup` (git/tarball fallback + rollback), and forwarding `--force` and source provenance. |
| [`bin/codex-markup.js`](bin/codex-markup.js) | Package bin wrapper that stages out of `node_modules` for `npx` installs so Node native TypeScript execution works cleanly. |
| [`src/server.ts`](src/server.ts) | `InlineReviewServer` HTTP + SSE server, relative static asset serving, widget injection (`injectReviewWidget`), batch reply API, model discovery/capabilities API, `fs.watch` live reload, and background `codex exec --ephemeral` dispatch (`runBackgroundCodex`). |
| [`src/widget.ts`](src/widget.ts) | Client-side overlay (`getWidgetScript`) mounted in `#codex-inline-review-root`, including text highlighting, element picker, dark floating popovers, valid-models dropdown, queueable submit, Web Speech dictation (`🎙️`), thread drawer (`💬 Threads`), and SSE sync. |
| [`src/mcp.ts`](src/mcp.ts) | Zero-dependency JSON-RPC 2.0 MCP stdio server (`startMcpServer`) supporting newline-delimited and `Content-Length` framing (`open_html_review`, `wait_for_review`, `get_inline_comments`, `reply_to_comment`, `reply_to_comments`, `resolve_comment`). |
| [`src/store.ts`](src/store.ts) | Sidecar persistence (`<file.html>.comments.json`), thread CRUD (`createThread`, `addReply`, `addRepliesBatch`, `updateThreadStatus`, `deleteThread`, `markSubmitted`), file-watch fallback (`waitForFileSubmission`), and Markdown prompt formatting (`formatReviewForCodex`). |
| [`test/eval.test.ts`](test/eval.test.ts) | Offline evaluation and integration test suite covering store persistence, HTTP/SSE/API routes, model discovery/selection, MCP JSON-RPC protocol, CLI commands, Manifest v2/sync/update rollbacks, and widget behavior. |
| [`AGENTS.md`](AGENTS.md) | Agent runbook (`install`, `update`, `sync`, `doctor`, `uninstall`, review workflow) and repository invariants. |

## Core Design Constraints

1. **Zero External Runtime Dependencies (`Node.js 22.18+ (22.x) or 24+`):**
   - [`package.json`](package.json) must remain free of third-party runtime npm dependencies.
   - All TypeScript modules run directly via Node.js native type-stripping (`node --no-warnings src/cli.ts`), ESM (`"type": "module"`), and explicit `.ts` relative imports per [`tsconfig.json`](tsconfig.json).
   - Use only Node.js built-in `node:*` modules (`node:http`, `node:fs`, `node:path`, `node:os`, `node:crypto`, `node:child_process`) and global `fetch` on the backend, and standard browser APIs in `src/widget.ts`.
   - Keep TypeScript syntax erasable (avoid enums, parameter properties, and runtime namespaces).

2. **Shadow DOM Isolation (`#codex-inline-review-root`):**
   - Keep all injected overlay UI in `src/widget.ts` encapsulated inside the open Shadow DOM (`#codex-inline-review-root`).
   - Only minimal host-page markers (`.cir-text-highlight` `<mark>` wrappers, `.cir-element-pulse`, and `.cir-pick-mode`) may touch the reviewed document's DOM so host page styling stays isolated.

3. **Safety & Ownership Invariants (`src/install.ts` / `install.sh`):**
   - Never delete or overwrite unowned directories, symlinks, containing directories, or `managed: false` contributor checkouts.
   - Protect user customizations in installed `SKILL.md` / `AGENTS.md` marker blocks unless `--force` is passed.
   - All `git`, `tar`, and `node` subprocess invocations must use `string[]` arguments (`execFile`/`spawn`, no shell interpolation), and tarballs must pass traversal/link validation before extraction.

## Development Workflow & Running Tests

Clone the repository, link it to your local Codex setup, and test changes:

```bash
git clone https://github.com/chkche1/codex-markup.git
cd codex-markup
npm run install-codex   # Register this checkout in-place (managed: false)
npm run demo            # Try the interactive browser demo
```

After pulling upstream changes or editing `skills/inline-html-review/SKILL.md` / `src/install.ts`:

```bash
npm run sync            # Refresh skill, AGENTS.md block, and Manifest v2 hashes
npm run doctor          # Verify config, SHA-256 sync state, and 6-tool MCP handshake
```

Always run the evaluation suite (matching GitHub Actions CI with empty global git config) before opening a PR:

```bash
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null npm test
bash -n install.sh
```

- GitHub Actions CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `npm test` on `ubuntu-latest` across Node.js `22.18.0` and `24` (with no global `~/.gitconfig` — pass explicit `-c user.name=... -c user.email=...` to any test `git commit` or `git revert` calls).
- Keep `examples/*.comments.json` clean when testing manually against [`examples/demo.html`](examples/demo.html) (ignored by default via `.gitignore`).

## Opening Pull Requests

1. Fork [chkche1/codex-markup](https://github.com/chkche1/codex-markup) and create a focused feature or fix branch.
2. Add or update offline coverage in [`test/eval.test.ts`](test/eval.test.ts) for any behavioral changes and verify `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null npm test` passes with zero failures.
3. Confirm `package.json` still has zero external runtime dependencies and no temporary sidecar files (`examples/*.comments.json`) are staged.
4. Open a pull request with a clear summary of the change, motivation, and observed test output.
