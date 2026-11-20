# codex-markup

**Visual HTML reviews for Codex CLI—with browser comments, persistent threads, and live updates.**

Open a local HTML file, highlight text or pick an element, and tell Codex what to change. Feedback stays attached to the page, with replies and resolution status saved beside the HTML.

![Demo dashboard with inline review comments](docs/images/demo-review.png)

## Install

Requires **Node.js 22.18+ (22.x) or 24+**, and Git or `curl` + `tar`. To have Codex apply edits automatically, install Codex CLI and sign in first.

```bash
curl -fsSL https://raw.githubusercontent.com/chkche1/codex-markup/main/install.sh | bash
```

The installer copies the runtime to `~/.codex/tools/codex-markup`, registers `[mcp_servers.inline-review]` in `~/.codex/config.toml`, installs the `inline-html-review` skill and global `AGENTS.md` instructions, records SHA-256 baseline hashes in `~/.codex/codex-markup-install.json`, and verifies all six MCP tools. No `npm install` is needed. **Restart Codex** when installation finishes.

You can also install via `npx` (which relocates itself out of the temporary `npx` cache into `~/.codex/tools/codex-markup`):

```bash
npx -y github:chkche1/codex-markup install
```

**Install options:**
- `CODEX_HOME=/custom/dir` (`--codex-home <dir>`): target a custom Codex configuration directory.
- `CODEX_MARKUP_DIR=/custom/runtime` (`--install-dir <dir>`): install the managed runtime into a custom directory.
- `--skill-scope agents`: install the skill into `~/.agents/skills/inline-html-review` instead of `~/.codex/skills/inline-html-review` (pass `--agents-dir <dir>` to override `~/.agents`).
- `--force` (`CODEX_MARKUP_FORCE=1`, or `curl ... | bash -s -- --force`): overwrite local manual edits in `SKILL.md` or the `AGENTS.md` integration block.

> See [Update](#update) below once installed, or [AGENTS.md](AGENTS.md) if you are pointing an AI agent at this repository.

## Why use it?

Codex desktop already includes a browser with visual annotations. `codex-markup` brings a visual review workflow to Codex CLI and your external browser, with portable review files you can keep in Git. It also works through MCP in Codex desktop.

- **Point to the change:** select text or pick an element to leave a comment with precise page context.
- **Keep the conversation:** reply, resolve, and reopen threads. Reviews live in `<file.html>.comments.json`.
- **Send feedback in batches:** submit one comment immediately or queue several for a single pass.
- **See updates live:** the preview reloads when the HTML changes, and replies update live inside the thread cards.

Built for local HTML prototypes, dashboards, and reports. No build step or external runtime dependencies.

## Try the demo

After installing, run:

```bash
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts serve ~/.codex/tools/codex-markup/examples/demo.html
```

This opens the example dashboard with the review overlay. The server stays running in the terminal; press `Ctrl+C` to stop it.

1. Click **Pick Element**, then click part of the page, or highlight text to comment on it.
2. Write your feedback. Leave **Send to Codex** checked to send immediately, or uncheck it to collect several comments.
3. Click **Submit to Codex** when your queued feedback is ready (even while an earlier batch is running, you can queue the next batch).
4. Watch the preview update and read Codex's replies in the threads.

When a Codex session is listening through MCP, submissions return to that session under its permissions and model (**Session Sandbox** and **Session Model** badges). Otherwise, the server starts a background Codex CLI run defaulting to **Full Access** and your active Codex model (from `~/.codex/config.toml` or Codex's default model, preserving your reasoning settings). Use `--sandbox workspace-write`, `--model <slug>`, or the toolbar dropdown to customize standalone runs.

Voice input is available when your browser supports speech recognition.

## Review your own HTML

```bash
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts serve /path/to/page.html
```

The server runs locally on loopback. Threads are saved in `<file.html>.comments.json`; keep that file in Git to preserve a review.

## Connect to Codex

Once installed and Codex is restarted, `[mcp_servers.inline-review]` provides six MCP tools:

| Tool | Purpose |
| --- | --- |
| `open_html_review` | Open an HTML preview with commenting. |
| `wait_for_review` | Wait for submitted feedback. |
| `get_inline_comments` | Read review threads. |
| `reply_to_comment` | Reply and update a single thread's status. |
| `reply_to_comments` | Reply to multiple threads in one batch request. |
| `resolve_comment` | Resolve or reopen a thread. |

**Prompts you can give Codex:**
- **Review a file:** *"Open `page.html` for inline review, wait for my comments, and address them."*
- **Install from scratch:** *"Install `https://github.com/chkche1/codex-markup` for Codex following its `AGENTS.md` instructions."*
- **Check & update:** *"Check if `codex-markup` has any updates or skill drift (`update --check --json`), and update/sync cleanly if needed."*

## Update

### Managed installs (`install.sh`, `npx`, or `--copy`)

Use the built-in self-updater (stages on the same filesystem, validates archives against path traversal/symlinks, runs an isolated 6-tool MCP check before swapping, and rolls back runtime + `~/.codex` on failure):

```bash
# Check for upstream updates and local drift (non-mutating; add --json for scripts/agents)
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts update --check

# Download and apply the latest update atomically
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts update

# Offline or pinned update from a local directory or .tgz archive
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts update --from /path/to/codex-markup-or-release.tgz
```

You can also re-run `curl -fsSL https://raw.githubusercontent.com/chkche1/codex-markup/main/install.sh | bash` (pass `-s -- --force` if you want to overwrite manual edits). **Restart Codex** after updating so it reloads the MCP server.

> **Local edit protection:** If you manually edited `~/.codex/skills/inline-html-review/SKILL.md` (or `~/.agents/skills/inline-html-review/SKILL.md`) or the `<!-- BEGIN CODEX-INLINE-REVIEW -->` block in `AGENTS.md`, `install`, `sync`, and `update` abort without overwriting your edits unless `--force` is passed. Store your own HTML documents outside `~/.codex/tools/codex-markup`—updates replace that runtime directory.

### Git checkout installs (`npm run install-codex`)

`update` intentionally refuses to run `git pull` on a contributor checkout (`managed: false`). Update via Git and re-sync your Codex config/skill offline:

```bash
git pull
npm run sync
```

## Sync skills, switch paths, & verify (`doctor`)

```bash
# Refresh skill files, AGENTS.md block, config.toml, and Manifest v2 from the active runtime
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts sync

# Move the installed skill cleanly to ~/.agents/skills/inline-html-review (or back with --skill-scope codex)
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts sync --skill-scope agents

# Verify Node version, config.toml, runtime, skill, AGENTS.md, sync drift, duplicate skills, and MCP handshake
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts doctor
```

- Pass `--json` to `doctor`, `sync`, `update --check`, `update`, or `uninstall` for single-line machine-readable JSON (`ok`, `needsSync`, `customizedFiles`, `restartRequired`).
- `doctor` validates the live MCP server and checks SHA-256 `sync-drift` (warning if the installed skill/`AGENTS.md` is behind the runtime or locally customized) plus `skill-duplicates` (warning if `inline-html-review` exists in both `~/.codex/skills` and `~/.agents/skills`).
- `doctor` does not verify your Codex login or reload an already-running chat; restart Codex after install, update, or sync changes.

## Uninstall

```bash
# Remove MCP config, active skill directory (codex or agents scope), AGENTS.md block, and managed runtime
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts uninstall
```

- Pass `--keep-runtime` to remove Codex integration while leaving `~/.codex/tools/codex-markup` on disk.
- Pass `--json` for structured output (`removedConfigSection`, `removedSkillDirs`, `removedAgentsBlock`, `removedRuntimeDir`).
- Uninstall always preserves files outside the managed runtime, unrelated Codex settings, and contributor checkouts (`managed: false`). Restart Codex and close any running `serve` servers afterward.

## Contributing

```bash
git clone https://github.com/chkche1/codex-markup.git
cd codex-markup
npm test
npm run demo
```

No dependency installation is needed. Link Codex to your local checkout and keep skills/manifests in sync:

- `npm run install-codex`: link Codex in-place to this checkout (`managed: false`).
- `npm run sync`: refresh `SKILL.md`, `AGENTS.md`, and Manifest v2 hashes after `git pull`.
- `npm run doctor`: run full health + SHA-256 drift checks (`--json` supported).
- `npm run update`: check/apply updates when managing a copy (`node --no-warnings src/cli.ts install --copy`).

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for architecture details and test guidelines.

## License

[MIT](LICENSE)
