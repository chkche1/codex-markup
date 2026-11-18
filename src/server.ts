import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import {
  loadReviewState,
  createThread,
  addReply,
  updateThreadStatus,
  deleteThread,
  markSubmitted,
  formatReviewForCodex,
  getSidecarPath,
  type CommentTarget,
  type CommentStatus,
  type MessageAuthor,
  type ReviewDocumentState,
} from './store.ts';
import { getWidgetScript } from './widget.ts';

export const DEFAULT_PORT = Number(process.env.CODEX_REVIEW_PORT || 4321);
export type CodexSandboxMode = 'workspace-write' | 'full-access';

export function resolveDefaultSandboxMode(mode?: string): CodexSandboxMode {
  const raw = mode || process.env.CODEX_MARKUP_SANDBOX;
  if (raw === 'full-access' || raw === 'danger-full-access') {
    return 'full-access';
  }
  return 'workspace-write';
}

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const LOCAL_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

class HttpError extends Error {
  public readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface SSEClient {
  res: http.ServerResponse;
  filePath: string;
}

interface PendingWaiter {
  filePath: string;
  resolve: (result: { state: ReviewDocumentState; prompt: string }) => void;
  timer?: NodeJS.Timeout;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export class InlineReviewServer {
  private server: http.Server;
  private port: number;
  private activeFilePath: string | null = null;
  private sseClients = new Set<SSEClient>();
  private waiters = new Set<PendingWaiter>();
  private watchedFiles = new Map<string, fs.FSWatcher>();
  private activeCodexRuns = new Map<string, { startedAt: string; statusText: string }>();
  private sandboxMode: CodexSandboxMode;

  constructor(port = DEFAULT_PORT, initialFile?: string, sandboxMode?: CodexSandboxMode) {
    this.port = port;
    this.sandboxMode = resolveDefaultSandboxMode(sandboxMode);
    if (initialFile) {
      this.setActiveFile(initialFile);
    }
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        const statusCode = err instanceof HttpError ? err.statusCode : 500;
        if (statusCode >= 500) {
          console.error('[InlineReviewServer] Error:', err);
        }
        if (!res.headersSent) {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    });
  }

  public setActiveFile(filePath: string): string {
    const resolved = path.resolve(filePath);
    this.activeFilePath = resolved;
    this.ensureWatching(resolved);
    return resolved;
  }

  public getReviewUrl(filePath?: string): string {
    const target = filePath ? this.setActiveFile(filePath) : this.activeFilePath;
    if (!target) {
      return `http://127.0.0.1:${this.port}/`;
    }
    return `http://127.0.0.1:${this.port}/review?file=${encodeURIComponent(target)}`;
  }

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(err);
        } else {
          reject(err);
        }
      };
      this.server.once('error', onError);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve(this.port);
      });
    });
  }

  public stop(): Promise<void> {
    for (const watcher of this.watchedFiles.values()) {
      watcher.close();
    }
    this.watchedFiles.clear();
    for (const client of this.sseClients) {
      client.res.end();
    }
    this.sseClients.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  public waitForSubmission(
    filePath: string,
    timeoutMs = 600_000
  ): Promise<{ state: ReviewDocumentState; prompt: string }> {
    const resolved = this.setActiveFile(filePath);
    return new Promise((resolve) => {
      const waiter: PendingWaiter = {
        filePath: resolved,
        resolve: (res) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          this.broadcastWaitersCount(resolved);
          resolve(res);
        },
      };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.waiters.delete(waiter);
          this.broadcastWaitersCount(resolved);
          const state = loadReviewState(resolved);
          const prompt = formatReviewForCodex(resolved, 'open');
          resolve({ state, prompt });
        }, timeoutMs);
      }
      this.waiters.add(waiter);
      this.broadcastWaitersCount(resolved);
    });
  }

  private logEvent(msg: string) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }

  private getWaitersCount(filePath: string): number {
    const resolved = path.resolve(filePath);
    let count = 0;
    for (const w of this.waiters) {
      if (w.filePath === resolved) count++;
    }
    return count;
  }

  private broadcastWaitersCount(filePath: string) {
    const count = this.getWaitersCount(filePath);
    this.broadcastSSE(filePath, 'waiters-updated', { waitingAgentsCount: count });
  }

  private broadcastSSE(filePath: string, event: string, data: unknown) {
    const resolved = path.resolve(filePath);
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      if (client.filePath === resolved) {
        client.res.write(payload);
      }
    }
  }

  private ensureWatching(htmlFilePath: string) {
    const resolved = path.resolve(htmlFilePath);
    if (!this.watchedFiles.has(resolved) && fs.existsSync(resolved)) {
      let debounceTimer: NodeJS.Timeout | null = null;
      try {
        const watcher = fs.watch(resolved, () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            this.broadcastSSE(resolved, 'html-updated', { filePath: resolved, timestamp: Date.now() });
          }, 120);
        });
        this.watchedFiles.set(resolved, watcher);
      } catch {
        // Ignore watch errors
      }
    }

    const sidecar = getSidecarPath(resolved);
    const dir = path.dirname(resolved);
    const sidecarBase = path.basename(sidecar);
    const dirWatchKey = `dir:${dir}:${sidecarBase}`;
    if (!this.watchedFiles.has(dirWatchKey) && fs.existsSync(dir)) {
      let debounceTimer: NodeJS.Timeout | null = null;
      try {
        const watcher = fs.watch(dir, (_eventType, filename) => {
          if (filename === sidecarBase) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              this.broadcastSSE(resolved, 'comments-updated', { reason: 'file-sync' });
            }, 100);
          } else if (filename === path.basename(resolved)) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              this.broadcastSSE(resolved, 'html-updated', { filePath: resolved, timestamp: Date.now() });
            }, 120);
          }
        });
        this.watchedFiles.set(dirWatchKey, watcher);
      } catch {
        // Ignore watch errors
      }
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const host = req.headers.host || `127.0.0.1:${this.port}`;
    const url = new URL(req.url || '/', `http://${host}`);
    const pathname = url.pathname;

    // Validate Origin to prevent cross-site requests from triggering local actions
    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const isAllowedOrigin = !originHeader || LOCAL_ORIGIN_RE.test(originHeader);
    if (!isAllowedOrigin && (pathname.startsWith('/__inline_review__/api/') || pathname === '/__inline_review__/events')) {
      this.sendJson(res, 403, { error: 'Forbidden origin' });
      return;
    }

    res.setHeader(
      'Access-Control-Allow-Origin',
      originHeader && isAllowedOrigin ? originHeader : `http://127.0.0.1:${this.port}`
    );
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(isAllowedOrigin ? 204 : 403);
      res.end();
      return;
    }

    // 1. SSE Event Stream
    if (pathname === '/__inline_review__/events' && req.method === 'GET') {
      const fileParam = url.searchParams.get('file') || this.activeFilePath;
      if (!fileParam) {
        res.writeHead(400);
        res.end('Missing file parameter');
        return;
      }
      const resolved = this.setActiveFile(fileParam);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ filePath: resolved })}\n\n`);
      const client: SSEClient = { res, filePath: resolved };
      this.sseClients.add(client);
      req.on('close', () => {
        this.sseClients.delete(client);
      });
      return;
    }

    // 2. Injected Widget JS
    if (pathname === '/__inline_review__/widget.js' && req.method === 'GET') {
      const fileParam = url.searchParams.get('file') || this.activeFilePath || '';
      const script = getWidgetScript(path.resolve(fileParam));
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(script);
      return;
    }

    // 3. Review API Endpoints
    if (pathname.startsWith('/__inline_review__/api/')) {
      await this.handleApi(req, res, url);
      return;
    }

    // 4. HTML Review Route (`/review?file=...` or `/`)
    if (pathname === '/' || pathname === '/review') {
      const fileParam = url.searchParams.get('file') || this.activeFilePath;
      if (!fileParam) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.renderLandingPage());
        return;
      }
      const resolved = this.setActiveFile(fileParam);
      if (!fs.existsSync(resolved)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`HTML file not found: ${resolved}`);
        return;
      }
      const rawHtml = fs.readFileSync(resolved, 'utf8');
      const injectedHtml = injectReviewWidget(rawHtml, resolved);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(injectedHtml);
      return;
    }

    // 5. Static relative assets referenced by the reviewed HTML file
    let baseDir = this.activeFilePath ? path.dirname(this.activeFilePath) : process.cwd();
    const referer = req.headers.referer;
    if (referer) {
      try {
        const refUrl = new URL(referer);
        const refFile = refUrl.searchParams.get('file');
        if (refFile) {
          baseDir = path.dirname(path.resolve(refFile));
        }
      } catch {
        // Ignore malformed referer
      }
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname.replace(/^\/+/, ''));
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }
    const resolvedBaseDir = path.resolve(baseDir);
    const candidatePath = path.resolve(resolvedBaseDir, decodedPath);
    if (candidatePath !== resolvedBaseDir && !candidatePath.startsWith(resolvedBaseDir + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      const ext = path.extname(candidatePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      fs.createReadStream(candidatePath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }

  private async handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const endpoint = url.pathname.replace('/__inline_review__/api', '');

    if (endpoint === '/health' && req.method === 'GET') {
      this.sendJson(res, 200, {
        ok: true,
        port: this.port,
        activeFilePath: this.activeFilePath,
        sandboxMode: this.sandboxMode,
      });
      return;
    }

    if (endpoint === '/state' && req.method === 'GET') {
      const file = this.resolveRequestedFile(url.searchParams.get('file'));
      const state = loadReviewState(file);
      this.sendJson(res, 200, {
        state,
        waitingAgentsCount: this.getWaitersCount(file),
        codexRun: this.activeCodexRuns.get(file) || null,
        sandboxMode: this.sandboxMode,
      });
      return;
    }

    if (endpoint === '/prompt' && req.method === 'GET') {
      const file = this.resolveRequestedFile(url.searchParams.get('file'));
      const status = (url.searchParams.get('status') as 'open' | 'answered' | 'resolved' | 'all') || 'open';
      const prompt = formatReviewForCodex(file, status);
      const state = loadReviewState(file);
      this.sendJson(res, 200, { prompt, state });
      return;
    }

    const body = req.method === 'POST' ? await readJsonBody(req) : {};

    if (endpoint === '/open' && req.method === 'POST') {
      const file = this.resolveRequestedFile(body.file as string);
      const reviewUrl = this.getReviewUrl(file);
      if (body.openBrowser !== false) {
        openInBrowser(reviewUrl);
      }
      this.sendJson(res, 200, { ok: true, filePath: file, reviewUrl });
      return;
    }

    if (endpoint === '/comments' && req.method === 'POST') {
      const file = this.resolveRequestedFile(body.file as string);
      const target = body.target as CommentTarget;
      const text = String(body.text || '');
      const author = ((body.author as MessageAuthor) || 'user');
      const thread = createThread(file, target, text, author);
      this.logEvent(`[API /comments] file=${file} id=${thread.id} author=${author} text=${JSON.stringify(text)}`);
      this.broadcastSSE(file, 'comments-updated', { reason: 'new-comment', commentId: thread.id, number: thread.number });
      this.sendJson(res, 200, { ok: true, thread });
      return;
    }

    if (endpoint === '/reply' && req.method === 'POST') {
      const file = this.resolveRequestedFile(body.file as string);
      const commentId = String(body.commentId || '');
      const text = String(body.text || '');
      const author = ((body.author as MessageAuthor) || 'codex');
      const status = body.status as CommentStatus | undefined;
      const thread = addReply(file, commentId, text, author, status);
      if (!thread) {
        this.logEvent(`[API /reply] 404 file=${file} id=${commentId}`);
        this.sendJson(res, 404, { ok: false, error: `Comment ${commentId} not found` });
        return;
      }
      this.logEvent(`[API /reply] file=${file} id=${thread.id} author=${author} status=${thread.status}`);
      this.broadcastSSE(file, 'comments-updated', {
        reason: author === 'codex' ? 'codex-reply' : 'user-reply',
        commentId: thread.id,
        number: thread.number,
      });
      this.sendJson(res, 200, { ok: true, thread });
      return;
    }

    if (endpoint === '/status' && req.method === 'POST') {
      const file = this.resolveRequestedFile(body.file as string);
      const commentId = String(body.commentId || '');
      const status = (body.status as CommentStatus) || 'resolved';
      const thread = updateThreadStatus(file, commentId, status);
      if (!thread) {
        this.logEvent(`[API /status] 404 file=${file} id=${commentId}`);
        this.sendJson(res, 404, { ok: false, error: `Comment ${commentId} not found` });
        return;
      }
      this.logEvent(`[API /status] file=${file} id=${thread.id} status=${status}`);
      this.broadcastSSE(file, 'comments-updated', {
        reason: 'codex-status',
        commentId: thread.id,
        number: thread.number,
        status,
      });
      this.sendJson(res, 200, { ok: true, thread });
      return;
    }

    if (endpoint === '/delete' && req.method === 'POST') {
      const file = this.resolveRequestedFile(body.file as string);
      const commentId = String(body.commentId || '');
      const deleted = deleteThread(file, commentId);
      this.broadcastSSE(file, 'comments-updated', { reason: 'deleted', commentId });
      this.sendJson(res, 200, { ok: deleted });
      return;
    }

    if (endpoint === '/sandbox' && req.method === 'POST') {
      const requested = typeof body.sandboxMode === 'string' ? body.sandboxMode : undefined;
      this.sandboxMode = requested === 'full-access' || requested === 'danger-full-access'
        ? 'full-access'
        : 'workspace-write';
      const targetFile = typeof body.file === 'string' ? body.file : this.activeFilePath;
      this.logEvent(`[API /sandbox] sandboxMode=${this.sandboxMode}`);
      if (targetFile) {
        const resolved = this.setActiveFile(targetFile);
        this.broadcastSSE(resolved, 'comments-updated', {
          reason: 'sandbox-mode',
          sandboxMode: this.sandboxMode,
        });
      }
      this.sendJson(res, 200, { ok: true, sandboxMode: this.sandboxMode });
      return;
    }

    if (endpoint === '/submit' && req.method === 'POST') {
      const file = this.resolveRequestedFile(body.file as string);
      if (typeof body.sandboxMode === 'string') {
        this.sandboxMode =
          body.sandboxMode === 'full-access' || body.sandboxMode === 'danger-full-access'
            ? 'full-access'
            : 'workspace-write';
      }
      const state = markSubmitted(file, body.generalNote as string | undefined);
      const prompt = formatReviewForCodex(file, 'open');

      let notifiedWaiters = 0;
      for (const w of Array.from(this.waiters)) {
        if (w.filePath === file) {
          notifiedWaiters++;
          w.resolve({ state, prompt });
        }
      }
      this.broadcastSSE(file, 'comments-updated', { reason: 'submitted' });

      // If no active MCP `wait_for_review` call is blocking, automatically spawn `codex exec`
      // in the background so the user always gets their inline comments answered!
      let spawnedCodex = false;
      const openThreads = state.threads.filter((t) => t.status === 'open');
      this.logEvent(
        `[API /submit] file=${file} openCount=${openThreads.length} notifiedWaiters=${notifiedWaiters} autoRunCodex=${body.autoRunCodex !== false}`
      );
      if (notifiedWaiters === 0 && openThreads.length > 0 && body.autoRunCodex !== false) {
        spawnedCodex = true;
        this.runBackgroundCodex(file, openThreads.map((t) => t.id));
      }

      this.sendJson(res, 200, { ok: true, state, prompt, notifiedWaiters, spawnedCodex });
      return;
    }

    if (endpoint === '/wait' && req.method === 'POST') {
      const file = this.resolveRequestedFile(body.file as string);
      const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 600_000;
      const result = await this.waitForSubmission(file, timeoutMs);
      this.sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (endpoint === '/shutdown' && req.method === 'POST') {
      this.logEvent('[API /shutdown] Graceful shutdown requested');
      this.sendJson(res, 200, { ok: true, shuttingDown: true });
      setImmediate(() => {
        this.stop().catch(() => {});
      });
      return;
    }

    this.sendJson(res, 404, { error: `Unknown API endpoint: ${endpoint}` });
  }

  private runBackgroundCodex(filePath: string, openThreadIds: string[]) {
    const resolved = path.resolve(filePath);
    if (this.activeCodexRuns.has(resolved)) {
      this.logEvent(`[runBackgroundCodex] Skipping spawn; run already active for ${resolved}`);
      return;
    }

    const runState = {
      startedAt: new Date().toISOString(),
      statusText: 'Codex is reviewing your inline comments...',
    };
    this.activeCodexRuns.set(resolved, runState);
    this.broadcastSSE(resolved, 'agent-status', { running: true, ...runState });

    const candidateCodexBins = [
      process.env.CODEX_CLI_PATH,
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ].filter((p): p is string => Boolean(p));

    const codexBin = candidateCodexBins.find((p) => fs.existsSync(p)) || 'codex';

    const nodeBin = fs.existsSync('/opt/homebrew/bin/node')
      ? '/opt/homebrew/bin/node'
      : process.execPath;

    const cliPath = path.resolve(import.meta.dirname || '.', 'cli.ts');
    const workDir = path.dirname(resolved);
    const tmpOutFile = path.join(os.tmpdir(), `codex-inline-reply-${Date.now()}.txt`);
    const reviewReport = formatReviewForCodex(resolved, 'open');

    const beforeReplyCounts = new Map<string, number>();
    const initialState = loadReviewState(resolved);
    for (const t of initialState.threads) {
      beforeReplyCounts.set(t.id, t.messages.length);
    }

    const agentPrompt = [
      `You are responding to inline review comments left by the user on the HTML file: ${resolved}`,
      ``,
      reviewReport,
      ``,
      `IMPORTANT INSTRUCTIONS:`,
      `1. Read ONLY ${resolved} to understand the context of each open comment.`,
      `2. If a comment requests a change to the document/HTML/diagram/styles, edit ${resolved} directly.`,
      `3. For EVERY open comment thread listed above, you MUST post your reply back to the inline thread by running:`,
      `   ${nodeBin} --no-warnings ${cliPath} reply ${JSON.stringify(resolved)} <comment-id> "<your detailed answer or summary of changes>" --resolve`,
      `   (Omit --resolve if you are only answering a question and want to keep the thread open/answered for follow-up.)`,
      `4. Scope strictly to ${resolved}: do NOT search the repository, do NOT read project AGENTS.md files, and do NOT run any repository build or test suites unless an inline comment explicitly asks you to.`,
    ].join('\n');

    const env = {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`,
    };

    const sandboxArgs =
      this.sandboxMode === 'full-access'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--sandbox', 'workspace-write'];

    const args = [
      'exec',
      '--ephemeral',
      '-c',
      'mcp_servers={}',
      ...sandboxArgs,
      '--skip-git-repo-check',
      '-C',
      workDir,
      '--output-last-message',
      tmpOutFile,
      '-',
    ];

    this.logEvent(
      `[runBackgroundCodex] Spawning ${codexBin} for ${resolved} (sandboxMode=${this.sandboxMode}, threads=${openThreadIds.join(',')}, promptBytes=${Buffer.byteLength(agentPrompt, 'utf8')})`
    );

    const child = spawn(codexBin, args, {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let lastErrorLine = '';

    const handleStreamChunk = (source: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (/\bERROR\b|unexpected status [45]\d\d/i.test(line)) {
          lastErrorLine = line;
        }
        if (source === 'stderr') {
          console.error(`[${new Date().toISOString()}] [codex-exec stderr] ${line}`);
        } else {
          console.log(`[${new Date().toISOString()}] [codex-exec stdout] ${line}`);
        }
        const snippet = line.length > 90 ? line.slice(0, 87) + '...' : line;
        const active = this.activeCodexRuns.get(resolved);
        if (active) {
          active.statusText = `Codex: ${snippet}`;
          this.broadcastSSE(resolved, 'agent-status', { running: true, ...active });
        }
      }
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => handleStreamChunk('stdout', chunk));
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => handleStreamChunk('stderr', chunk));
    }

    child.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] [InlineReviewServer] Failed to spawn codex exec:`, err);
      this.activeCodexRuns.delete(resolved);
      this.broadcastSSE(resolved, 'agent-status', {
        running: false,
        error: `Failed to launch codex CLI: ${err.message}`,
      });
    });

    if (child.stdin) {
      child.stdin.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] [codex-exec stdin error]`, err);
      });
      child.stdin.write(agentPrompt);
      child.stdin.end();
    }

    child.on('close', (code, signal) => {
      try {
        let lastMessage = '';
        if (fs.existsSync(tmpOutFile)) {
          lastMessage = fs.readFileSync(tmpOutFile, 'utf8').trim();
          fs.unlinkSync(tmpOutFile);
        }

        this.logEvent(
          `[runBackgroundCodex] codex exec exited code=${code} signal=${signal ?? 'none'} lastMessageLength=${lastMessage.length}`
        );

        // Fallback: if Codex answered in its final output without invoking `reply`
        // on any of the open threads, attach its response automatically so the user always sees it!
        if (lastMessage) {
          const afterState = loadReviewState(resolved);
          for (const threadId of openThreadIds) {
            const thread = afterState.threads.find((t) => t.id === threadId);
            const prevCount = beforeReplyCounts.get(threadId) || 0;
            if (thread && thread.messages.length <= prevCount) {
              const targetStatus = thread.status === 'open' ? 'answered' : thread.status;
              const updated = addReply(resolved, threadId, lastMessage, 'codex', targetStatus);
              if (updated) {
                this.logEvent(`[runBackgroundCodex] Attached fallback reply to ${updated.id} (status=${updated.status})`);
                this.broadcastSSE(resolved, 'comments-updated', {
                  reason: 'codex-reply',
                  commentId: updated.id,
                  number: updated.number,
                });
              }
            }
          }
        }
      } catch (err) {
        console.error(`[${new Date().toISOString()}] [InlineReviewServer] Post-run check error:`, err);
      } finally {
        this.activeCodexRuns.delete(resolved);
        this.broadcastSSE(resolved, 'agent-status', {
          running: false,
          completed: code === 0 && !lastErrorLine,
          error: lastErrorLine || (code !== 0 ? `Codex exited with code ${code}` : undefined),
        });
      }
    });
  }

  private resolveRequestedFile(fileParam?: string | null): string {
    const target = fileParam || this.activeFilePath;
    if (!target) {
      throw new Error('No HTML file specified');
    }
    return this.setActiveFile(target);
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  }

  private renderLandingPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Codex Inline Review Server</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 680px; margin: 60px auto; padding: 0 24px; color: #18181b; line-height: 1.6; }
    code { background: #f4f4f5; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    .card { border: 1px solid #e4e4e7; border-radius: 12px; padding: 24px; background: #fafafa; }
  </style>
</head>
<body>
  <h1>💬 Codex Inline HTML Review Server</h1>
  <div class="card">
    <p>The local review server is running. Open any local HTML file for inline commenting by visiting:</p>
    <p><code>http://127.0.0.1:${this.port}/review?file=/absolute/path/to/file.html</code></p>
    <p>Or ask Codex in chat: <em>"Open my HTML file in inline review"</em>.</p>
  </div>
</body>
</html>`;
  }
}

export function injectReviewWidget(rawHtml: string, resolvedFilePath: string): string {
  const scriptTag = `\n<!-- Codex Inline Review Widget -->\n<script src="/__inline_review__/widget.js?file=${encodeURIComponent(
    resolvedFilePath
  )}"></script>\n`;
  if (/<\/body>/i.test(rawHtml)) {
    return rawHtml.replace(/<\/body>/i, `${scriptTag}</body>`);
  }
  return rawHtml + scriptTag;
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        aborted = true;
        req.destroy();
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

export function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => {
    // Ignore browser launch errors in headless/sandboxed environments
  });
}

/**
 * Ensures a local InlineReviewServer is accessible on `port` (either already running
 * in another process or started in-process), and returns a helper client for API calls.
 */
export async function ensureReviewServer(port = DEFAULT_PORT, initialFile?: string): Promise<{
  baseUrl: string;
  server?: InlineReviewServer;
}> {
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${baseUrl}/__inline_review__/api/health`);
    if (res.ok) {
      if (initialFile) {
        await fetch(`${baseUrl}/__inline_review__/api/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: path.resolve(initialFile), openBrowser: false }),
        });
      }
      return { baseUrl };
    }
  } catch {
    // Not running yet, start one in-process
  }

  const srv = new InlineReviewServer(port, initialFile);
  const actualPort = await srv.start();
  return {
    baseUrl: `http://127.0.0.1:${actualPort}`,
    server: srv,
  };
}
