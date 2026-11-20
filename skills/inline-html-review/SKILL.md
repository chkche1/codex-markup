---
name: inline-html-review
description: Preview generated HTML files in a local browser overlay where the user can highlight text or pick DOM elements to leave inline comments, and Codex can read, answer, and resolve each comment thread.
---

# Inline HTML Review Skill (`codex-markup`)

Use this skill whenever:
- You generate or edit an HTML file, prototype, dashboard, landing page, or rich document and want the user to review it visually with inline comments (like Claude Artifacts).
- The user asks to "open in inline review", "review this HTML", or "address my inline comments".

## Workflow

### 1. Open the HTML File for Inline Review

#### If the `inline-review` MCP Server is available:
Call the `open_html_review` MCP tool:
- `file_path`: path to the generated `.html` file.
- `open_browser`: `true`
- `wait_for_submission`: set to `true` if you want to immediately wait for the user to add inline comments and click **"🚀 Submit to Codex"** in the browser.

> **Permissions & model note:** When Codex is actively listening via `wait_for_review` or `open_html_review(wait_for_submission: true)` (or CLI `wait`), execution permissions and model selection come from the connected Codex session itself, and the browser dock displays read-only **Session Sandbox** and **Session Model** badges.

#### If using CLI commands (without MCP):
```bash
# Start the server and open the browser in the background
node --no-warnings <path-to-codex-markup>/src/cli.ts serve <path/to/file.html>

# Wait for the user to click "Submit Review to Codex" in the browser
node --no-warnings <path-to-codex-markup>/src/cli.ts wait <path/to/file.html>
```

---

### 2. Read Inline Comments

When the user submits their review (or says *"address my comments"* in chat):
- **Via MCP:** Call `get_inline_comments(file_path, status="open")` (or receive them automatically from `wait_for_review`).
- **Via CLI:**
  ```bash
  node --no-warnings <path-to-codex-markup>/src/cli.ts comments <path/to/file.html> --status open
  ```

Each comment thread includes:
- `id` (e.g. `c-1`, `c-2`)
- `Target CSS Selector` (e.g. `#pricing > div.card:nth-child(2) > button.cta`)
- `Selected / Highlighted Text` and `Surrounding Context` (for text highlights)
- `DOM Snippet` (outerHTML of the target element)
- `Conversation Thread` (all messages from User and Codex)

---

### 3. Address & Reply to Every Inline Comment

For each open inline comment:
1. **If the comment requests a code/design/text change:** Edit the `.html` file directly. The browser preview will automatically live-reload via Server-Sent Events (SSE).
2. **Reply to all addressed comment threads together (preferred for batches)** or individually so the user sees your explanation directly inside each browser thread card:
   - **Via MCP (batch):** Call `reply_to_comments(file_path, replies=[{"comment_id": "c-1", "reply": "...", "status": "resolved"}, ...])` to update multiple threads in one request (or use `reply_to_comment` for a single comment; use `"answered"` if follow-up might be needed, or `"resolved"` if the requested change is complete).
   - **Via CLI (batch):**
     ```bash
     node --no-warnings <path-to-codex-markup>/src/cli.ts reply-batch <path/to/file.html> --stdin <<'EOF'
     [{"id":"c-1","reply":"Updated the CTA button gradient and increased padding.","status":"resolved"}]
     EOF
     ```
   - **Via CLI (single comment):**
     ```bash
     node --no-warnings <path-to-codex-markup>/src/cli.ts reply <path/to/file.html> c-1 "Updated the CTA button gradient and increased padding." --resolve
     ```

---

## Maintenance (Verify, Update, Sync, Uninstall)

When the user asks to check health, update, sync skills, switch skill scope, or uninstall `codex-markup`:

```bash
# 1. Inspect health, SHA-256 sync drift, and duplicate skill warnings
node --no-warnings <path-to-codex-markup>/src/cli.ts doctor --json

# 2. Check for upstream updates & local drift without modifying files
node --no-warnings <path-to-codex-markup>/src/cli.ts update --check --json

# 3. Apply updates on managed installs (stages, verifies, and rolls back on failure)
node --no-warnings <path-to-codex-markup>/src/cli.ts update --json

# 4. Sync skill/AGENTS.md/config.toml from current runtime (use after `git pull` on checkouts)
node --no-warnings <path-to-codex-markup>/src/cli.ts sync --json

# Optional: switch skill location cleanly to ~/.agents/skills (or back with `codex`)
node --no-warnings <path-to-codex-markup>/src/cli.ts sync --skill-scope agents --json

# 5. Uninstall (removes MCP config, active skill dir, AGENTS.md block, and owned runtime)
node --no-warnings <path-to-codex-markup>/src/cli.ts uninstall --json
```

- **Checkout installs (`managed: false`):** `update` refuses to overwrite contributor checkouts; run `git pull` in the checkout first (if asked), then run `sync --json`.
- **Edit protection:** If `customizedFiles` / `UserCustomizationError` is reported, do **not** pass `--force` automatically—ask the user before overwriting their edits.
- **Codex restart:** Whenever `restartRequired` is `true` (after `install`, `update`, `sync`, or `uninstall`), remind the user to restart Codex so changes take effect.
