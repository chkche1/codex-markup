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

> **Permissions note:** When Codex is actively listening via `wait_for_review` or `open_html_review(wait_for_submission: true)` (or CLI `wait`), execution permissions come from the connected Codex session itself, and the browser dock displays a read-only **Session Sandbox** badge.

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
2. **Reply to the comment thread** so the user sees your explanation or answer directly inside the browser thread card:
   - **Via MCP:** Call `reply_to_comment(file_path, comment_id="c-1", reply="...", status="resolved")` (use `"answered"` if answering a question where follow-up might be needed, or `"resolved"` if the requested change is complete).
   - **Via CLI:**
     ```bash
     node --no-warnings <path-to-codex-markup>/src/cli.ts reply <path/to/file.html> c-1 "Updated the CTA button gradient and increased padding." --resolve
     ```
