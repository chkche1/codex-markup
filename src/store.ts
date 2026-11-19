import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type CommentMode = 'text' | 'element';
export type CommentStatus = 'open' | 'answered' | 'resolved';
export type MessageAuthor = 'user' | 'codex';

export interface CommentMessage {
  id: string;
  author: MessageAuthor;
  text: string;
  createdAt: string;
}

export interface CommentTarget {
  mode: CommentMode;
  selector: string;
  tagName: string;
  selectedText?: string;
  prefixText?: string;
  suffixText?: string;
  htmlSnippet?: string;
  attributes?: Record<string, string>;
  offsetXRatio?: number;
  offsetYRatio?: number;
}

export interface CommentThread {
  id: string;
  number: number;
  status: CommentStatus;
  target: CommentTarget;
  messages: CommentMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewDocumentState {
  version: 1;
  htmlFilePath: string;
  lastSubmittedAt?: string;
  submissionCount: number;
  generalNote?: string;
  threads: CommentThread[];
}

export function getSidecarPath(htmlFilePath: string): string {
  const resolved = path.resolve(htmlFilePath);
  return `${resolved}.comments.json`;
}

export function loadReviewState(htmlFilePath: string): ReviewDocumentState {
  const resolved = path.resolve(htmlFilePath);
  const sidecar = getSidecarPath(resolved);
  if (fs.existsSync(sidecar)) {
    try {
      const raw = fs.readFileSync(sidecar, 'utf8');
      const parsed = JSON.parse(raw) as ReviewDocumentState;
      if (parsed && Array.isArray(parsed.threads)) {
        parsed.htmlFilePath = resolved;
        return parsed;
      }
    } catch {
      // Fall through to default state if corrupted
    }
  }
  return {
    version: 1,
    htmlFilePath: resolved,
    submissionCount: 0,
    threads: [],
  };
}

export function saveReviewState(htmlFilePath: string, state: ReviewDocumentState): ReviewDocumentState {
  const resolved = path.resolve(htmlFilePath);
  const sidecar = getSidecarPath(resolved);
  state.htmlFilePath = resolved;
  fs.writeFileSync(sidecar, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return state;
}

export function createThread(
  htmlFilePath: string,
  target: CommentTarget,
  initialText: string,
  author: MessageAuthor = 'user'
): CommentThread {
  const state = loadReviewState(htmlFilePath);
  const nextNumber = state.threads.reduce((max, t) => Math.max(max, t.number || 0), 0) + 1;
  const now = new Date().toISOString();
  const thread: CommentThread = {
    id: `c-${nextNumber}`,
    number: nextNumber,
    status: 'open',
    target,
    messages: [
      {
        id: crypto.randomUUID().slice(0, 8),
        author,
        text: initialText.trim(),
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  state.threads.push(thread);
  saveReviewState(htmlFilePath, state);
  return thread;
}

function matchesCommentId(thread: CommentThread, commentId: string): boolean {
  const normalizedId = normalizeCommentId(commentId);
  return thread.id === normalizedId || `c-${thread.number}` === normalizedId || String(thread.number) === commentId.trim();
}

export interface BatchReplyInput {
  commentId: string;
  text: string;
  author?: MessageAuthor;
  status?: CommentStatus;
}

function applyReplyToThread(
  thread: CommentThread,
  text: string,
  author: MessageAuthor,
  newStatus?: CommentStatus
): void {
  const now = new Date().toISOString();
  if (text && text.trim().length > 0) {
    thread.messages.push({
      id: crypto.randomUUID().slice(0, 8),
      author,
      text: text.trim(),
      createdAt: now,
    });
  }
  if (newStatus) {
    thread.status = newStatus;
  } else if (author === 'codex' && thread.status === 'open') {
    thread.status = 'answered';
  } else if (author === 'user' && thread.status !== 'open') {
    thread.status = 'open';
  }
  thread.updatedAt = now;
}

export function addReply(
  htmlFilePath: string,
  commentId: string,
  text: string,
  author: MessageAuthor,
  newStatus?: CommentStatus
): CommentThread | null {
  const state = loadReviewState(htmlFilePath);
  const thread = state.threads.find((t) => matchesCommentId(t, commentId));
  if (!thread) {
    return null;
  }
  applyReplyToThread(thread, text, author, newStatus);
  saveReviewState(htmlFilePath, state);
  return thread;
}

export function addRepliesBatch(
  htmlFilePath: string,
  replies: BatchReplyInput[]
): { updated: CommentThread[]; missing: string[] } {
  const state = loadReviewState(htmlFilePath);
  const updatedMap = new Map<string, CommentThread>();
  const missing: string[] = [];

  for (const item of replies) {
    const rawId = String(item.commentId || '').trim();
    if (!rawId) continue;
    const thread = state.threads.find((t) => matchesCommentId(t, rawId));
    if (!thread) {
      missing.push(rawId);
      continue;
    }
    const author: MessageAuthor = item.author || 'codex';
    applyReplyToThread(thread, String(item.text || ''), author, item.status);
    updatedMap.set(thread.id, thread);
  }

  const updated = Array.from(updatedMap.values());
  if (updated.length > 0) {
    saveReviewState(htmlFilePath, state);
  }
  return { updated, missing };
}

export function updateThreadStatus(
  htmlFilePath: string,
  commentId: string,
  status: CommentStatus
): CommentThread | null {
  const state = loadReviewState(htmlFilePath);
  const thread = state.threads.find((t) => matchesCommentId(t, commentId));
  if (!thread) {
    return null;
  }
  thread.status = status;
  thread.updatedAt = new Date().toISOString();
  saveReviewState(htmlFilePath, state);
  return thread;
}

export function deleteThread(htmlFilePath: string, commentId: string): boolean {
  const state = loadReviewState(htmlFilePath);
  const before = state.threads.length;
  state.threads = state.threads.filter((t) => !matchesCommentId(t, commentId));
  if (state.threads.length !== before) {
    saveReviewState(htmlFilePath, state);
    return true;
  }
  return false;
}

export function markSubmitted(htmlFilePath: string, generalNote?: string): ReviewDocumentState {
  const state = loadReviewState(htmlFilePath);
  state.lastSubmittedAt = new Date().toISOString();
  state.submissionCount = (state.submissionCount || 0) + 1;
  if (generalNote !== undefined) {
    state.generalNote = generalNote.trim() || undefined;
  }
  saveReviewState(htmlFilePath, state);
  return state;
}

/**
 * Filesystem-based wait for submission (works even when loopback network access is sandboxed).
 * Watches the sidecar `.comments.json` file until `submissionCount` increments.
 */
export function waitForFileSubmission(
  htmlFilePath: string,
  timeoutMs = 600_000
): Promise<{ state: ReviewDocumentState; prompt: string }> {
  const resolved = path.resolve(htmlFilePath);
  const initial = loadReviewState(resolved);
  const initialCount = initial.submissionCount || 0;
  const dir = path.dirname(resolved);
  const sidecarBase = path.basename(getSidecarPath(resolved));

  return new Promise((resolve) => {
    let settled = false;
    let watcher: fs.FSWatcher | null = null;
    let pollInterval: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    const check = () => {
      if (settled) return;
      const current = loadReviewState(resolved);
      if ((current.submissionCount || 0) > initialCount) {
        settled = true;
        cleanup();
        resolve({
          state: current,
          prompt: formatReviewForCodex(resolved, 'open'),
        });
      }
    };

    try {
      watcher = fs.watch(dir, (_event, filename) => {
        if (!filename || filename === sidecarBase) {
          check();
        }
      });
    } catch {
      // Fallback to polling if fs.watch is unavailable
    }

    pollInterval = setInterval(check, 350);

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const current = loadReviewState(resolved);
        resolve({
          state: current,
          prompt: formatReviewForCodex(resolved, 'open'),
        });
      }, timeoutMs);
    }
  });
}

export function normalizeCommentId(id: string): string {
  const trimmed = id.trim().replace(/^#/, '');
  if (/^\d+$/.test(trimmed)) {
    return `c-${trimmed}`;
  }
  return trimmed;
}

export function formatReviewForCodex(
  htmlFilePath: string,
  filterStatus: 'open' | 'answered' | 'resolved' | 'all' = 'open'
): string {
  const state = loadReviewState(htmlFilePath);
  const threads =
    filterStatus === 'all'
      ? state.threads
      : state.threads.filter((t) =>
          filterStatus === 'open' ? t.status === 'open' : t.status === filterStatus
        );

  const lines: string[] = [];
  lines.push(`# Inline HTML Review for \`${state.htmlFilePath}\``);
  if (state.lastSubmittedAt) {
    lines.push(`Submitted at: ${state.lastSubmittedAt} (Submission #${state.submissionCount})`);
  }
  if (state.generalNote) {
    lines.push(`\n## Overall Reviewer Note\n${state.generalNote}`);
  }

  if (threads.length === 0) {
    lines.push(`\nNo ${filterStatus === 'all' ? '' : filterStatus + ' '}inline comments found.`);
    return lines.join('\n');
  }

  lines.push(`\n## Inline Comments (${threads.length} ${filterStatus === 'all' ? 'total' : filterStatus})\n`);

  for (const t of threads) {
    lines.push(`### Comment #${t.number} (ID: \`${t.id}\`, Status: \`${t.status}\`, Type: \`${t.target.mode}\`)`);
    lines.push(`- **Target CSS Selector**: \`${t.target.selector}\``);
    lines.push(`- **Element Tag**: \`<${t.target.tagName.toLowerCase()}>\``);
    if (t.target.selectedText) {
      lines.push(`- **Selected / Highlighted Text**: ${JSON.stringify(t.target.selectedText)}`);
    }
    if (t.target.prefixText || t.target.suffixText) {
      lines.push(
        `- **Surrounding Context**: ...${t.target.prefixText || ''}[${t.target.selectedText || ''}]${t.target.suffixText || ''}...`
      );
    }
    if (t.target.htmlSnippet) {
      lines.push(`- **DOM Snippet**:\n\`\`\`html\n${t.target.htmlSnippet}\n\`\`\``);
    }
    lines.push(`- **Conversation Thread**:`);
    for (const m of t.messages) {
      const speaker = m.author === 'user' ? 'User' : 'Codex';
      lines.push(`  - **${speaker}**: ${m.text}`);
    }
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`### How to Respond & Address Comments`);
  lines.push(`1. If a comment asks for a change to the HTML/CSS/content, edit \`${state.htmlFilePath}\` directly.`);
  lines.push(`2. When addressing multiple comments, prefer \`reply_to_comments\` (MCP) or \`codex-markup reply-batch\` (CLI) to submit all replies in one batch request (or use \`reply_to_comment\` / \`reply\` for a single comment).`);
  lines.push(`3. Set status to \`resolved\` when an edit is complete, or \`answered\` when replying to a question or awaiting confirmation.`);

  return lines.join('\n');
}
