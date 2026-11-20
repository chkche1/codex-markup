import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PORT,
  ensureReviewServer,
} from './server.ts';
import {
  formatReviewForCodex,
  addReply,
  addRepliesBatch,
  updateThreadStatus,
  waitForFileSubmission,
  type BatchReplyInput,
  type CommentStatus,
} from './store.ts';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'open_html_review',
    description:
      'Opens a local HTML file in the Codex Inline Review Server so the user can view it in their browser, highlight text or pick DOM elements to leave inline comments, and submit feedback back to Codex.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the HTML file to open for inline review.',
        },
        open_browser: {
          type: 'boolean',
          description: 'Whether to automatically launch the review URL in the system browser (default: true).',
        },
        wait_for_submission: {
          type: 'boolean',
          description:
            'If true, waits until the user clicks "Submit Review to Codex" in the browser and immediately returns their inline comments.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'wait_for_review',
    description:
      'Blocks until the user clicks "Submit Review to Codex" in the browser review UI for the given HTML file, then returns all open inline comments with their CSS selectors, selected text, DOM snippets, and thread messages.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the HTML file being reviewed.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Maximum seconds to wait for user submission (default: 600).',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'get_inline_comments',
    description:
      'Non-blocking tool that reads current inline comments for an HTML file, including CSS selectors, highlighted text quotes, DOM snippets, and thread messages.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the HTML file.',
        },
        status: {
          type: 'string',
          enum: ['open', 'answered', 'resolved', 'all'],
          description: 'Filter comments by status (default: "open").',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'reply_to_comment',
    description:
      'Posts a reply from Codex to a specific inline comment thread and updates its status ("answered" or "resolved"). Immediately pushes the reply to the user\'s open browser review sidebar.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the HTML file.',
        },
        comment_id: {
          type: 'string',
          description: 'ID of the comment thread (e.g. "c-1" or "1").',
        },
        reply: {
          type: 'string',
          description: 'Your response answering the user\'s question or explaining the change made.',
        },
        status: {
          type: 'string',
          enum: ['answered', 'resolved', 'open'],
          description:
            'New status for the thread: use "resolved" when a requested edit is finished, or "answered" when replying to a question.',
        },
      },
      required: ['file_path', 'comment_id', 'reply'],
    },
  },
  {
    name: 'reply_to_comments',
    description:
      'Posts replies from Codex to multiple inline comment threads in one batch request and updates their statuses ("answered" or "resolved"). Immediately pushes all updates to the browser review UI.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the HTML file.',
        },
        replies: {
          type: 'array',
          description: 'List of replies to post in one atomic batch.',
          items: {
            type: 'object',
            properties: {
              comment_id: {
                type: 'string',
                description: 'ID of the comment thread (e.g. "c-1" or "1").',
              },
              reply: {
                type: 'string',
                description: 'Your response answering the user\'s question or explaining the change made.',
              },
              status: {
                type: 'string',
                enum: ['answered', 'resolved', 'open'],
                description:
                  'New status for the thread: use "resolved" when a requested edit is finished, or "answered" when replying to a question.',
              },
            },
            required: ['comment_id', 'reply'],
          },
        },
      },
      required: ['file_path', 'replies'],
    },
  },
  {
    name: 'resolve_comment',
    description: 'Updates the status of an inline comment thread to "resolved" or "open".',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the HTML file.',
        },
        comment_id: {
          type: 'string',
          description: 'ID of the comment thread (e.g. "c-1" or "1").',
        },
        status: {
          type: 'string',
          enum: ['resolved', 'open', 'answered'],
          description: 'Target status (default: "resolved").',
        },
      },
      required: ['file_path', 'comment_id'],
    },
  },
];

/** Reads the package version from package.json with a safe fallback. */
export function readServerVersion(): string {
  try {
    const pkgPath = path.resolve(import.meta.dirname || '.', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '1.0.0';
  } catch {
    return '1.0.0';
  }
}

export async function startMcpServer(port = DEFAULT_PORT): Promise<void> {
  let framingMode: 'line' | 'content-length' = 'line';

  function sendMessage(msg: Record<string, unknown>) {
    const json = JSON.stringify(msg);
    if (framingMode === 'content-length') {
      const byteLen = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  }

  function sendResult(id: string | number | null | undefined, result: unknown) {
    if (id === undefined) return;
    sendMessage({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  function sendError(id: string | number | null | undefined, code: number, message: string) {
    if (id === undefined) return;
    sendMessage({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
    const rawFile = String(args.file_path || '');
    if (!rawFile) {
      throw new Error('Missing required parameter: file_path');
    }
    const resolvedFile = path.resolve(rawFile);

    if (name === 'open_html_review') {
      const openBrowser = args.open_browser !== false;
      const waitForSubmission = Boolean(args.wait_for_submission);
      let reviewUrl = `http://127.0.0.1:${port}/review?file=${encodeURIComponent(resolvedFile)}`;

      try {
        const { baseUrl, server } = await ensureReviewServer(port, resolvedFile);
        reviewUrl = `${baseUrl}/review?file=${encodeURIComponent(resolvedFile)}`;
        if (server) {
          if (openBrowser) {
            const { openInBrowser } = await import('./server.ts');
            openInBrowser(reviewUrl);
          }
          if (waitForSubmission) {
            const res = await server.waitForSubmission(resolvedFile, 600_000);
            return res.prompt;
          }
        } else {
          const openRes = await fetch(`${baseUrl}/__inline_review__/api/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: resolvedFile, openBrowser }),
          });
          const openData = (await openRes.json()) as { reviewUrl: string };
          reviewUrl = openData.reviewUrl;
          if (waitForSubmission) {
            const waitRes = await fetch(`${baseUrl}/__inline_review__/api/wait`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ file: resolvedFile, timeoutMs: 600_000 }),
            });
            const waitData = (await waitRes.json()) as { prompt: string };
            return waitData.prompt;
          }
        }
      } catch {
        if (waitForSubmission) {
          const res = await waitForFileSubmission(resolvedFile, 600_000);
          return res.prompt;
        }
      }

      return [
        `Opened inline review for \`${resolvedFile}\`.`,
        `Review URL: ${reviewUrl}`,
        ``,
        `The user can now highlight text or pick DOM elements in the browser to leave inline comments.`,
        `Call \`wait_for_review\` if you want to wait for them to click "Submit Review to Codex", or \`get_inline_comments\` when they ask you to address their comments.`,
      ].join('\n');
    }

    if (name === 'wait_for_review') {
      const timeoutSec = typeof args.timeout_seconds === 'number' ? args.timeout_seconds : 600;
      try {
        const { baseUrl, server } = await ensureReviewServer(port, resolvedFile);
        if (server) {
          const res = await server.waitForSubmission(resolvedFile, timeoutSec * 1000);
          return res.prompt;
        }
        const waitRes = await fetch(`${baseUrl}/__inline_review__/api/wait`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: resolvedFile, timeoutMs: timeoutSec * 1000 }),
        });
        const waitData = (await waitRes.json()) as { prompt: string };
        return waitData.prompt;
      } catch {
        const res = await waitForFileSubmission(resolvedFile, timeoutSec * 1000);
        return res.prompt;
      }
    }

    if (name === 'get_inline_comments') {
      const status = (args.status as 'open' | 'answered' | 'resolved' | 'all') || 'open';
      return formatReviewForCodex(resolvedFile, status);
    }

    if (name === 'reply_to_comment') {
      const commentId = String(args.comment_id || '');
      const replyText = String(args.reply || '');
      const status = (args.status as CommentStatus | undefined) || 'answered';

      try {
        const { baseUrl } = await ensureReviewServer(port, resolvedFile);
        const res = await fetch(`${baseUrl}/__inline_review__/api/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: resolvedFile,
            commentId,
            text: replyText,
            author: 'codex',
            status,
          }),
        });
        const data = (await res.json()) as { ok: boolean; error?: string; thread?: { id: string; status: string } };
        if (!data.ok) {
          throw new Error(data.error || `Failed to reply to ${commentId}`);
        }
        return `Replied to comment ${data.thread?.id} (status: ${data.thread?.status}) and updated live browser view.`;
      } catch {
        const thread = addReply(resolvedFile, commentId, replyText, 'codex', status);
        if (!thread) {
          throw new Error(`Comment ${commentId} not found in ${resolvedFile}`);
        }
        return `Replied to comment ${thread.id} (status: ${thread.status}).`;
      }
    }

    if (name === 'reply_to_comments') {
      if (!Array.isArray(args.replies) || args.replies.length === 0) {
        throw new Error('Missing or empty required parameter: replies');
      }
      const normalized: BatchReplyInput[] = args.replies
        .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
        .map((r) => ({
          commentId: String(r.comment_id ?? r.commentId ?? r.id ?? ''),
          text: String(r.reply ?? r.text ?? ''),
          author: 'codex',
          status: (r.status as CommentStatus | undefined) || 'answered',
        }))
        .filter((r) => r.commentId.trim().length > 0);

      if (normalized.length === 0) {
        throw new Error('No valid reply items provided in replies array');
      }

      try {
        const { baseUrl } = await ensureReviewServer(port, resolvedFile);
        const res = await fetch(`${baseUrl}/__inline_review__/api/reply-batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: resolvedFile,
            replies: normalized,
          }),
        });
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
          threads?: Array<{ id: string; status: string }>;
          updatedCount?: number;
          missing?: string[];
        };
        if (!data.ok) {
          throw new Error(data.error || 'Failed to post batch replies');
        }
        const ids = (data.threads || []).map((t) => `${t.id}:${t.status}`).join(', ');
        const missingNote =
          data.missing && data.missing.length > 0
            ? ` (missing: ${data.missing.join(', ')})`
            : '';
        return `Replied to ${data.updatedCount ?? (data.threads || []).length} comment(s) in batch (${ids}) and updated live browser view.${missingNote}`;
      } catch {
        const { updated, missing } = addRepliesBatch(resolvedFile, normalized);
        if (updated.length === 0) {
          throw new Error(
            `No matching comments found in ${resolvedFile}${missing.length ? ` (${missing.join(', ')})` : ''}`
          );
        }
        const ids = updated.map((t) => `${t.id}:${t.status}`).join(', ');
        const missingNote = missing.length > 0 ? ` (missing: ${missing.join(', ')})` : '';
        return `Replied to ${updated.length} comment(s) in batch (${ids}).${missingNote}`;
      }
    }

    if (name === 'resolve_comment') {
      const commentId = String(args.comment_id || '');
      const status = (args.status as CommentStatus | undefined) || 'resolved';

      try {
        const { baseUrl } = await ensureReviewServer(port, resolvedFile);
        const res = await fetch(`${baseUrl}/__inline_review__/api/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: resolvedFile,
            commentId,
            status,
          }),
        });
        const data = (await res.json()) as { ok: boolean; error?: string; thread?: { id: string; status: string } };
        if (!data.ok) {
          throw new Error(data.error || `Failed to update status of ${commentId}`);
        }
        return `Updated comment ${data.thread?.id} status to "${data.thread?.status}".`;
      } catch {
        const thread = updateThreadStatus(resolvedFile, commentId, status);
        if (!thread) {
          throw new Error(`Comment ${commentId} not found in ${resolvedFile}`);
        }
        return `Updated comment ${thread.id} status to "${thread.status}".`;
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  async function dispatchRequest(req: JsonRpcRequest) {
    const { id, method, params } = req;

    if (method === 'initialize') {
      const clientProtocol =
        (params?.protocolVersion as string | undefined) || '2024-11-05';
      sendResult(id, {
        protocolVersion: clientProtocol,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'codex-markup',
          version: readServerVersion(),
        },
      });
      return;
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return;
    }

    if (method === 'ping') {
      sendResult(id, {});
      return;
    }

    if (method === 'tools/list') {
      sendResult(id, { tools: TOOLS });
      return;
    }

    if (method === 'tools/call') {
      const toolName = String(params?.name || '');
      const toolArgs = ((params?.arguments as Record<string, unknown>) || {});
      try {
        const text = await handleToolCall(toolName, toolArgs);
        sendResult(id, {
          content: [{ type: 'text', text }],
        });
      } catch (err) {
        sendResult(id, {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        });
      }
      return;
    }

    if (id !== undefined) {
      sendError(id, -32601, `Method not found: ${method}`);
    }
  }

  // Support both newline-delimited JSON-RPC and Content-Length header framing
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const headerMatch = buffer.toString('utf8', 0, Math.min(buffer.length, 100)).match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
      if (headerMatch) {
        framingMode = 'content-length';
        const headerByteLen = Buffer.byteLength(headerMatch[0], 'utf8');
        const contentByteLen = Number(headerMatch[1]);
        if (buffer.length < headerByteLen + contentByteLen) {
          break; // Wait for full payload
        }
        const bodyStr = buffer.toString('utf8', headerByteLen, headerByteLen + contentByteLen);
        buffer = buffer.subarray(headerByteLen + contentByteLen);
        try {
          const msg = JSON.parse(bodyStr) as JsonRpcRequest;
          dispatchRequest(msg);
        } catch (err) {
          console.error('[MCP] Failed to parse Content-Length JSON:', err);
        }
      } else {
        const newlineIdx = buffer.indexOf(0x0a); // '\n'
        if (newlineIdx === -1) {
          break;
        }
        const lineStr = buffer.toString('utf8', 0, newlineIdx).trim();
        buffer = buffer.subarray(newlineIdx + 1);
        if (!lineStr) continue;
        try {
          const msg = JSON.parse(lineStr) as JsonRpcRequest;
          dispatchRequest(msg);
        } catch (err) {
          console.error('[MCP] Failed to parse line JSON:', err);
        }
      }
    }
  });
}
