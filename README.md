# codex-markup

**Visual HTML reviews for Codex CLI—with browser comments, persistent threads, and live updates.**

Open a local HTML file, highlight text or pick an element, and tell Codex what to change. Feedback stays attached to the page, with replies and resolution status saved beside the HTML.

![Demo dashboard with inline review comments](docs/images/demo-review.png)

## Install

Requires **Node.js 22.18+ (22.x) or 24+**, and Git or `curl` + `tar`. To have Codex make changes, install Codex CLI and sign in first.

```bash
curl -fsSL https://raw.githubusercontent.com/chkche1/codex-markup/main/install.sh | bash
```

The installer downloads to `~/.codex/tools/codex-markup`, registers the MCP server, installs the skill and review instructions, and verifies all six MCP tools. No `npm install` is needed. Restart Codex when it finishes.

Re-run the same command to update. The download is checked before replacing the current installation; a failed installation restores the previous runtime and configuration. The installer prints download time, setup timings, and commands for your installed paths.

You can also install with:

```bash
npx -y github:chkche1/codex-markup install
```

This copies the runtime out of the package cache into the same permanent tools directory. The installed CLI continues to work after that cache is cleared.

For a custom location, set `CODEX_HOME` for the configuration directory or `CODEX_MARKUP_DIR` for the shell installer's runtime directory. Use the paths printed by the installer in the commands below.

## Why use it?

Codex desktop already includes a browser with visual annotations. `codex-markup` brings a review workflow to Codex CLI and your external browser, with portable review files you can keep in Git. It also works through MCP in Codex desktop.

- **Point to the change:** select text or pick an element to leave a comment with precise page context.
- **Keep the conversation:** reply, resolve, and reopen threads. Reviews live in `<file.html>.comments.json`.
- **Send feedback to Codex:** submit one comment immediately or queue several for a single pass.
- **See updates live:** the preview reloads when the HTML changes, and replies appear in the review UI.

Built for local HTML prototypes, dashboards, and reports. No build step or external runtime dependencies.

## Try the demo

After installing, run:

```bash
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts serve ~/.codex/tools/codex-markup/examples/demo.html
```

This opens the example dashboard with the review overlay. The server stays running in the terminal; press `Ctrl+C` to stop it.

1. Click **Pick Element**, then click part of the page, or highlight text to comment on it.
2. Write your feedback. Leave **Send to Codex** checked to send immediately, or uncheck it to collect several comments.
3. Click **Submit to Codex** when your queued feedback is ready.
4. Watch the preview update and read Codex's replies in the threads.

When a Codex session is listening through MCP, feedback returns to that session under its permissions and model. Otherwise, the server starts a background Codex CLI run. Standalone runs default to **Full Access**, bypassing sandbox and approval restrictions, and inherit your current Codex model and reasoning settings. Add `--sandbox workspace-write` or `--model <slug>` to `serve` (or switch them from the toolbar) for standalone runs; host sandboxing, managed policies, or connected MCP sessions lock toolbar overrides.

Voice input is available when your browser supports speech recognition.

## Review your own HTML

```bash
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts serve /path/to/page.html
```

The server runs locally on loopback. Threads are saved in `<file.html>.comments.json`; keep that file in Git to preserve a review.

## Connect to Codex

Once installed (see [Install](#install) above), restart your Codex session to load `[mcp_servers.inline-review]`, then ask Codex:

> Open page.html for inline review, wait for my comments, and address them.

The integration provides six tools:

| Tool | Purpose |
| --- | --- |
| `open_html_review` | Open an HTML preview with commenting. |
| `wait_for_review` | Wait for submitted feedback. |
| `get_inline_comments` | Read review threads. |
| `reply_to_comment` | Reply and update a thread's status. |
| `reply_to_comments` | Reply to multiple threads in one batch. |
| `resolve_comment` | Resolve or reopen a thread. |

## Verify, update, or remove

```bash
# Verify the installed files and MCP handshake
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts doctor

# Remove the integration and its managed runtime
node --no-warnings ~/.codex/tools/codex-markup/src/cli.ts uninstall
```

`doctor` checks the MCP integration. It does not verify Codex login or load the integration into an existing chat. Restart Codex after installation or removal. Close any existing preview servers separately.

Uninstall preserves your HTML and review files outside the managed runtime, unrelated Codex settings, and contributor checkouts. A custom managed runtime is removed too. Use `uninstall --keep-runtime` to keep the runtime files. Store your own documents outside the managed runtime: updates replace that directory.

To update, re-run the recommended install command above.

## Contributing

```bash
git clone https://github.com/chkche1/codex-markup.git
cd codex-markup
npm test
npm run demo
```

No dependency installation is needed. `npm run install-codex` connects Codex to this checkout; keep the checkout in place. Use `npm run doctor` to verify it. For a separate managed copy, run `node --no-warnings src/cli.ts install --copy`.

`install --codex-home /path/to/config` targets a custom configuration directory. `install --install-dir /path/to/runtime` creates a managed copy. `install --json` returns the runtime location, version, setup phase timings, verification status, and restart requirement for automation. Setup timings exclude the shell download and Node process startup.

## License

[MIT](LICENSE)
