import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { promisify } from 'node:util';

import {
  addRepliesBatch,
  addReply,
  createThread,
  deleteThread,
  formatReviewForCodex,
  getSidecarPath,
  loadReviewState,
  markSubmitted,
  normalizeCommentId,
  updateThreadStatus,
  waitForFileSubmission,
} from '../src/store.ts';
import {
  InlineReviewServer,
  buildBackgroundCodexInvocation,
  detectSandboxErrorMessage,
  injectReviewWidget,
  loadAvailableModels,
  parseCodexModelsCatalog,
  readCodexConfigDefaultModel,
  readCodexModelsCache,
  resolveDefaultModel,
  resolveWorkspaceRoot,
} from '../src/server.ts';
import { getWidgetScript } from '../src/widget.ts';
import { isEphemeralCheckoutPath, isSupportedNodeVersion } from '../src/install.ts';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname || '.', '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.ts');

const tempDirs: string[] = [];

function makeTempDir(prefix = 'codex-inline-review-eval-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeTempHtml(dir: string, name = 'index.html', html = '<!DOCTYPE html><html><body><h1>Hello</h1></body></html>'): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, html, 'utf8');
  return filePath;
}

after(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// Suite 1 — Comment Store & Thread Lifecycle (src/store.ts)
// =============================================================================
describe('Suite 1 — Comment Store & Thread Lifecycle', () => {
  it('creates text-selection and DOM-element threads with sequential IDs and .comments.json persistence', () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);

    const textThread = createThread(
      htmlFile,
      {
        mode: 'text',
        selector: 'main > p.intro',
        tagName: 'p',
        selectedText: 'launch faster',
        prefixText: 'Teams can ',
        suffixText: ' with inline review.',
        htmlSnippet: '<p class="intro">Teams can launch faster with inline review.</p>',
      },
      'Make this phrase stronger.'
    );

    const elemThread = createThread(
      htmlFile,
      {
        mode: 'element',
        selector: '#hero-cta',
        tagName: 'button',
        htmlSnippet: '<button id="hero-cta">Get Started</button>',
        offsetXRatio: 0.42,
        offsetYRatio: 0.65,
      },
      'Increase button padding and contrast.'
    );

    assert.equal(textThread.id, 'c-1');
    assert.equal(textThread.number, 1);
    assert.equal(textThread.status, 'open');
    assert.equal(elemThread.id, 'c-2');
    assert.equal(elemThread.number, 2);
    assert.equal(elemThread.status, 'open');

    const sidecarPath = getSidecarPath(htmlFile);
    assert.equal(sidecarPath, `${path.resolve(htmlFile)}.comments.json`);
    assert.equal(fs.existsSync(sidecarPath), true);

    const persisted = loadReviewState(htmlFile);
    assert.equal(persisted.version, 1);
    assert.equal(persisted.htmlFilePath, path.resolve(htmlFile));
    assert.equal(persisted.submissionCount, 0);
    assert.equal(persisted.threads.length, 2);
    assert.equal(persisted.threads[0].target.mode, 'text');
    assert.equal(persisted.threads[0].target.selectedText, 'launch faster');
    assert.equal(persisted.threads[1].target.mode, 'element');
    assert.equal(persisted.threads[1].target.offsetXRatio, 0.42);
  });

  it('normalizes IDs and transitions thread status automatically on codex/user replies', () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);

    assert.equal(normalizeCommentId('#1'), 'c-1');
    assert.equal(normalizeCommentId('1'), 'c-1');
    assert.equal(normalizeCommentId(' c-12 '), 'c-12');

    const created = createThread(
      htmlFile,
      { mode: 'element', selector: 'h1', tagName: 'h1' },
      'Should we change the title font?'
    );
    assert.equal(created.status, 'open');

    // Codex reply without explicit status: open -> answered
    const answered = addReply(htmlFile, '#1', 'Yes, switched to Inter Bold.', 'codex');
    assert.ok(answered);
    assert.equal(answered.status, 'answered');
    assert.equal(answered.messages.length, 2);

    // User follow-up on answered thread reopens it: answered -> open
    const reopenedFromAnswered = addReply(htmlFile, '1', 'Can we also bump size to 40px?', 'user');
    assert.ok(reopenedFromAnswered);
    assert.equal(reopenedFromAnswered.status, 'open');

    // Codex reply with explicit resolved status: open -> resolved
    const resolved = addReply(htmlFile, 'c-1', 'Increased font-size to 40px.', 'codex', 'resolved');
    assert.ok(resolved);
    assert.equal(resolved.status, 'resolved');

    // User follow-up on resolved thread reopens it: resolved -> open
    const reopenedFromResolved = addReply(htmlFile, '#1', 'One tweak: tighten letter-spacing.', 'user');
    assert.ok(reopenedFromResolved);
    assert.equal(reopenedFromResolved.status, 'open');
    assert.equal(reopenedFromResolved.messages.length, 5);

    assert.equal(addReply(htmlFile, 'c-999', 'Missing', 'codex'), null);
  });

  it('applies batch replies across multiple threads in one atomic store update', () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);

    createThread(htmlFile, { mode: 'element', selector: 'h1', tagName: 'h1' }, 'Tighten heading');
    createThread(htmlFile, { mode: 'element', selector: 'footer', tagName: 'footer' }, 'Is year current?');
    createThread(htmlFile, { mode: 'element', selector: 'main', tagName: 'main' }, 'Leave untouched');

    const { updated, missing } = addRepliesBatch(htmlFile, [
      { commentId: '#1', text: 'Updated h1 spacing.', author: 'codex', status: 'resolved' },
      { commentId: '2', text: 'Yes, 2026 is current.', author: 'codex' },
      { commentId: 'c-999', text: 'Non-existent target.', author: 'codex' },
    ]);

    assert.equal(updated.length, 2);
    assert.deepEqual(missing, ['c-999']);

    const state = loadReviewState(htmlFile);
    assert.equal(state.threads[0].status, 'resolved');
    assert.equal(state.threads[0].messages.at(-1)?.text, 'Updated h1 spacing.');
    assert.equal(state.threads[1].status, 'answered');
    assert.equal(state.threads[1].messages.at(-1)?.text, 'Yes, 2026 is current.');
    assert.equal(state.threads[2].status, 'open');
    assert.equal(state.threads[2].messages.length, 1);
  });

  it('updates thread status, deletes threads, and records submissions', () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);

    createThread(htmlFile, { mode: 'element', selector: '.card-1', tagName: 'div' }, 'First note');
    createThread(htmlFile, { mode: 'element', selector: '.card-2', tagName: 'div' }, 'Second note');

    const updated = updateThreadStatus(htmlFile, '2', 'resolved');
    assert.ok(updated);
    assert.equal(updated.id, 'c-2');
    assert.equal(updated.status, 'resolved');
    assert.equal(updateThreadStatus(htmlFile, 'c-404', 'resolved'), null);

    const submitted1 = markSubmitted(htmlFile, 'Focus on mobile layout');
    assert.equal(submitted1.submissionCount, 1);
    assert.ok(submitted1.lastSubmittedAt);
    assert.equal(submitted1.generalNote, 'Focus on mobile layout');

    const submitted2 = markSubmitted(htmlFile, '   ');
    assert.equal(submitted2.submissionCount, 2);
    assert.equal(submitted2.generalNote, undefined);

    assert.equal(deleteThread(htmlFile, '#2'), true);
    assert.equal(deleteThread(htmlFile, 'c-2'), false);
    const state = loadReviewState(htmlFile);
    assert.deepEqual(
      state.threads.map((t) => t.id),
      ['c-1']
    );
  });

  it('formats Codex review prompts across status filters with selectors, quotes, context, and DOM snippets', () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);

    createThread(
      htmlFile,
      {
        mode: 'text',
        selector: '#pricing > p.lead',
        tagName: 'p',
        selectedText: '$29/month',
        prefixText: 'Starter plan costs ',
        suffixText: ' billed annually.',
        htmlSnippet: '<p class="lead">Starter plan costs $29/month billed annually.</p>',
      },
      'Change price to $24/month.'
    );
    createThread(
      htmlFile,
      {
        mode: 'element',
        selector: 'nav.top-bar',
        tagName: 'nav',
        htmlSnippet: '<nav class="top-bar"><a href="/">Home</a></nav>',
      },
      'Is this sticky?'
    );
    createThread(
      htmlFile,
      {
        mode: 'element',
        selector: 'footer.site-footer',
        tagName: 'footer',
        htmlSnippet: '<footer class="site-footer">© 2026</footer>',
      },
      'Update copyright year.'
    );

    addReply(htmlFile, 'c-2', 'Yes, position: sticky is applied.', 'codex'); // status -> answered
    addReply(htmlFile, 'c-3', 'Confirmed 2026 is shown.', 'codex', 'resolved'); // status -> resolved
    markSubmitted(htmlFile, 'Please review pricing first.');

    const openPrompt = formatReviewForCodex(htmlFile, 'open');
    assert.match(openPrompt, /# Inline HTML Review for/);
    assert.match(openPrompt, /Submission #1/);
    assert.match(openPrompt, /## Overall Reviewer Note\nPlease review pricing first\./);
    assert.match(openPrompt, /## Inline Comments \(1 open\)/);
    assert.match(openPrompt, /ID: `c-1`, Status: `open`, Type: `text`/);
    assert.match(openPrompt, /\*\*Target CSS Selector\*\*: `#pricing > p\.lead`/);
    assert.match(openPrompt, /\*\*Element Tag\*\*: `<p>`/);
    assert.match(openPrompt, /\*\*Selected \/ Highlighted Text\*\*: "\$29\/month"/);
    assert.match(openPrompt, /\*\*Surrounding Context\*\*: \.\.\.Starter plan costs \[\$29\/month\] billed annually\.\.\./);
    assert.match(openPrompt, /\*\*DOM Snippet\*\*:\n```html\n<p class="lead">Starter plan costs \$29\/month billed annually\.<\/p>\n```/);
    assert.doesNotMatch(openPrompt, /ID: `c-2`/);
    assert.doesNotMatch(openPrompt, /ID: `c-3`/);

    const answeredPrompt = formatReviewForCodex(htmlFile, 'answered');
    assert.match(answeredPrompt, /## Inline Comments \(1 answered\)/);
    assert.match(answeredPrompt, /ID: `c-2`, Status: `answered`/);
    assert.match(answeredPrompt, /\*\*Codex\*\*: Yes, position: sticky is applied\./);
    assert.doesNotMatch(answeredPrompt, /ID: `c-1`/);

    const resolvedPrompt = formatReviewForCodex(htmlFile, 'resolved');
    assert.match(resolvedPrompt, /## Inline Comments \(1 resolved\)/);
    assert.match(resolvedPrompt, /ID: `c-3`, Status: `resolved`/);
    assert.doesNotMatch(resolvedPrompt, /ID: `c-1`/);

    const allPrompt = formatReviewForCodex(htmlFile, 'all');
    assert.match(allPrompt, /## Inline Comments \(3 total\)/);
    assert.match(allPrompt, /ID: `c-1`/);
    assert.match(allPrompt, /ID: `c-2`/);
    assert.match(allPrompt, /ID: `c-3`/);
    assert.match(openPrompt, /reply_to_comments/);
    assert.match(openPrompt, /reply-batch/);
  });

  it('wakes up waitForFileSubmission promptly when markSubmitted is called on disk', async () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);
    createThread(htmlFile, { mode: 'element', selector: '#hero', tagName: 'section' }, 'Tighten hero spacing');

    const start = Date.now();
    const waitPromise = waitForFileSubmission(htmlFile, 5_000);

    setTimeout(() => {
      markSubmitted(htmlFile, 'Async submission note');
    }, 50);

    const result = await waitPromise;
    const elapsedMs = Date.now() - start;

    assert.ok(elapsedMs < 3_000, `Expected prompt wakeup, took ${elapsedMs}ms`);
    assert.equal(result.state.submissionCount, 1);
    assert.equal(result.state.generalNote, 'Async submission note');
    assert.match(result.prompt, /Tighten hero spacing/);
    assert.match(result.prompt, /Async submission note/);
  });
});

// =============================================================================
// Suite 2 — Widget Injection, Security Hardening & Browser Script Evaluation
// =============================================================================

class MockRequest extends PassThrough {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;

  constructor(
    method: string,
    url: string,
    headers: Record<string, string | string[] | undefined> = {},
    body?: string | Buffer
  ) {
    super();
    this.method = method;
    this.url = url;
    this.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (body !== undefined) {
      queueMicrotask(() => {
        if (!this.destroyed) {
          this.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
          this.push(null);
        }
      });
    } else {
      queueMicrotask(() => {
        if (!this.destroyed) {
          this.push(null);
        }
      });
    }
  }
}

class MockResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string | number | string[]> = {};
  headersSent = false;
  ended = false;
  private chunks: Buffer[] = [];
  private finishPromise: Promise<void>;
  private resolveFinish!: () => void;

  constructor() {
    super();
    this.finishPromise = new Promise((resolve) => {
      this.resolveFinish = resolve;
    });
    this.on('finish', () => {
      this.ended = true;
      this.resolveFinish();
    });
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  setHeader(name: string, value: string | number | string[]): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  getHeader(name: string): string | number | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }

  writeHead(statusCode: number, headers?: Record<string, string | number | string[]>): this {
    this.statusCode = statusCode;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
    }
    this.headersSent = true;
    return this;
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  waitForFinish(): Promise<void> {
    return this.finishPromise;
  }
}

async function dispatchHandleRequest(
  server: InlineReviewServer,
  req: MockRequest
): Promise<MockResponse> {
  const res = new MockResponse();
  await (
    server as unknown as {
      handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

describe('Suite 2 — Widget Injection, Security Hardening & Browser Script Evaluation', () => {
  it('injects widget script tag before </body> (case-insensitive) and appends when </body> is missing', () => {
    const filePath = '/tmp/my page/demo.html';
    const expectedSrc = `/__inline_review__/widget.js?file=${encodeURIComponent(filePath)}`;

    const lowerHtml = '<html><body><h1>Hi</h1></body></html>';
    const injectedLower = injectReviewWidget(lowerHtml, filePath);
    assert.ok(injectedLower.includes(`<script src="${expectedSrc}"></script>`));
    assert.ok(injectedLower.indexOf(expectedSrc) < injectedLower.indexOf('</body>'));

    const upperHtml = '<HTML><BODY><H1>Hi</H1></BODY></HTML>';
    const injectedUpper = injectReviewWidget(upperHtml, filePath);
    assert.match(
      injectedUpper,
      new RegExp(`<script src="${expectedSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"></script>[\\s\\S]*</body>`, 'i')
    );

    const fragmentHtml = '<div id="card">Fragment without body</div>';
    const injectedFragment = injectReviewWidget(fragmentHtml, filePath);
    assert.ok(injectedFragment.startsWith(fragmentHtml));
    assert.ok(injectedFragment.includes(`<script src="${expectedSrc}"></script>`));
  });

  it('compiles generated widget JS cleanly via new Function and contains required UI & SSE features', () => {
    const script = getWidgetScript('/tmp/sample.html');
    assert.doesNotThrow(() => {
      new Function(script);
    });
    assert.doesNotThrow(() => {
      new Function(getWidgetScript('/tmp/quoted "file" & <test>.html'));
    });

    // Shadow DOM isolation
    assert.match(script, /attachShadow\(\{\s*mode:\s*'open'\s*\}\)/);
    assert.match(script, /codex-inline-review-root/);

    // Floating composer & thread popovers
    assert.match(script, /function openComposerPopover\(/);
    assert.match(script, /function openThreadPopover\(/);
    assert.match(script, /\.cir-popover/);

    // [✓] Send to Codex toggles in composer & thread reply popover + context-aware sandbox & model controls
    assert.match(script, /id="cir-send-now"/);
    assert.match(script, /id="cir-pop-send-now"/);
    assert.match(script, /Send to Codex/);
    assert.match(script, /id="cir-dock-sandbox"/);
    assert.match(script, /id="cir-dock-model"/);
    assert.match(script, /cir-model-popover/);
    assert.match(script, /role="listbox"/);
    assert.match(script, /role="option"/);
    assert.match(script, /aria-haspopup="listbox"/);
    assert.match(script, /cir-dock-caret/);
    assert.equal(script.includes('Current Codex Default'), false);
    assert.equal(script.includes('Default Model'), false);
    assert.match(script, /toggleSandboxMode/);
    assert.match(script, /applyModelSelection/);
    assert.match(script, /cir-sandbox-popover/);
    assert.match(script, /Session Sandbox/);
    assert.match(script, /Session Model/);
    assert.match(script, /Host Sandboxed/);
    assert.match(script, /sandboxInfo/);
    assert.match(script, /pendingHtmlReload/);
    assert.match(script, /cir-agent-status-text/);

    // Voice dictation
    assert.match(script, /function attachVoiceDictation\(/);
    assert.match(script, /window\.SpeechRecognition\s*\|\|\s*window\.webkitSpeechRecognition/);

    // Compact 18px pins
    assert.match(script, /\.cir-pin\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;/);

    // SSE event listeners
    assert.match(script, /new EventSource\(SSE_URL\)/);
    assert.match(script, /addEventListener\('comments-updated'/);
    assert.match(script, /codex-reply-batch/);
    assert.match(script, /addEventListener\('agent-status'/);
    assert.match(script, /addEventListener\('html-updated'/);
  });

  it('enforces origin checks, path traversal rejection, and >2MB body size limits on InlineReviewServer', async () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);
    const server = new InlineReviewServer(4321, htmlFile, undefined, {
      env: {},
      requirementsPath: path.join(dir, 'no-requirements.toml'),
      skipModelDiscovery: true,
    });

    try {
      // 1. External Origin rejected with 403 on /__inline_review__/api/... and /__inline_review__/events
      const evilApiReq = new MockRequest('GET', '/__inline_review__/api/state', {
        host: '127.0.0.1:4321',
        origin: 'https://evil.com',
      });
      const evilApiRes = await dispatchHandleRequest(server, evilApiReq);
      assert.equal(evilApiRes.statusCode, 403);
      assert.deepEqual(JSON.parse(evilApiRes.body), { error: 'Forbidden origin' });

      const evilSseReq = new MockRequest('GET', '/__inline_review__/events', {
        host: '127.0.0.1:4321',
        origin: 'https://evil.com',
      });
      const evilSseRes = await dispatchHandleRequest(server, evilSseReq);
      assert.equal(evilSseRes.statusCode, 403);
      assert.deepEqual(JSON.parse(evilSseRes.body), { error: 'Forbidden origin' });

      // Allowed localhost origin succeeds & standalone unsandboxed server defaults to full-access
      const localApiReq = new MockRequest('GET', '/__inline_review__/api/health', {
        host: '127.0.0.1:4321',
        origin: 'http://localhost:4321',
      });
      const localApiRes = await dispatchHandleRequest(server, localApiReq);
      assert.equal(localApiRes.statusCode, 200);
      const localHealth = JSON.parse(localApiRes.body);
      assert.equal(localHealth.ok, true);
      assert.equal(localHealth.sandboxMode, 'full-access');
      assert.equal(localHealth.sandbox.controlSource, 'background-codex');
      assert.equal(localHealth.sandbox.canToggle, true);

      // Live sandbox toggle endpoint switches between full-access and workspace-write
      const toggleRestrictedReq = new MockRequest(
        'POST',
        '/__inline_review__/api/sandbox',
        { host: '127.0.0.1:4321', 'content-type': 'application/json' },
        JSON.stringify({ file: htmlFile, sandboxMode: 'workspace-write' })
      );
      const toggleRestrictedRes = await dispatchHandleRequest(server, toggleRestrictedReq);
      assert.equal(toggleRestrictedRes.statusCode, 200);
      const restrictedBody = JSON.parse(toggleRestrictedRes.body);
      assert.equal(restrictedBody.ok, true);
      assert.equal(restrictedBody.applied, true);
      assert.equal(restrictedBody.sandboxMode, 'workspace-write');
      assert.equal(restrictedBody.sandbox.effectiveMode, 'workspace-write');

      const stateAfterToggleReq = new MockRequest(
        'GET',
        `/__inline_review__/api/state?file=${encodeURIComponent(htmlFile)}`,
        { host: '127.0.0.1:4321' }
      );
      const stateAfterToggleRes = await dispatchHandleRequest(server, stateAfterToggleReq);
      assert.equal(stateAfterToggleRes.statusCode, 200);
      assert.equal(JSON.parse(stateAfterToggleRes.body).sandboxMode, 'workspace-write');
      assert.equal(JSON.parse(stateAfterToggleRes.body).sandbox.effectiveMode, 'workspace-write');

      const toggleBackReq = new MockRequest(
        'POST',
        '/__inline_review__/api/sandbox',
        { host: '127.0.0.1:4321', 'content-type': 'application/json' },
        JSON.stringify({ file: htmlFile, sandboxMode: 'full-access' })
      );
      const toggleBackRes = await dispatchHandleRequest(server, toggleBackReq);
      assert.equal(toggleBackRes.statusCode, 200);
      const backBody = JSON.parse(toggleBackRes.body);
      assert.equal(backBody.ok, true);
      assert.equal(backBody.applied, true);
      assert.equal(backBody.sandboxMode, 'full-access');
      assert.equal(backBody.sandbox.effectiveMode, 'full-access');

      // 2. Path traversal attempts rejected (403 on encoded traversal escaping baseDir; raw dot-segments collapsed & blocked)
      const encodedTraversalReq = new MockRequest('GET', '/..%2f..%2fetc/passwd', {
        host: '127.0.0.1:4321',
      });
      const encodedTraversalRes = await dispatchHandleRequest(server, encodedTraversalReq);
      assert.equal(encodedTraversalRes.statusCode, 403);
      assert.equal(encodedTraversalRes.body, 'Forbidden');

      const rawTraversalReq = new MockRequest('GET', '/../../etc/passwd', {
        host: '127.0.0.1:4321',
      });
      const rawTraversalRes = await dispatchHandleRequest(server, rawTraversalReq);
      assert.ok(rawTraversalRes.statusCode === 403 || rawTraversalRes.statusCode === 404);
      assert.doesNotMatch(rawTraversalRes.body, /root:/);

      // 3. Oversized >2MB JSON body rejected with 413
      const oversizedPayload = JSON.stringify({
        file: htmlFile,
        text: 'a'.repeat(2 * 1024 * 1024 + 1024),
      });

      const directLargeReq = new MockRequest(
        'POST',
        '/__inline_review__/api/comments',
        { host: '127.0.0.1:4321', 'content-type': 'application/json' },
        oversizedPayload
      );
      await assert.rejects(
        () => dispatchHandleRequest(server, directLargeReq),
        (err: unknown) => {
          assert.ok(err && typeof err === 'object' && 'statusCode' in err);
          assert.equal((err as { statusCode: number }).statusCode, 413);
          return true;
        }
      );

      // Also verify the http.Server request listener wrapper converts HttpError(413) into an HTTP 413 JSON response
      const listenerLargeReq = new MockRequest(
        'POST',
        '/__inline_review__/api/comments',
        { host: '127.0.0.1:4321', 'content-type': 'application/json' },
        oversizedPayload
      );
      const listenerLargeRes = new MockResponse();
      const internalHttpServer = (server as unknown as { server: { emit(ev: string, ...args: unknown[]): boolean } })
        .server;
      internalHttpServer.emit('request', listenerLargeReq, listenerLargeRes);
      await listenerLargeRes.waitForFinish();
      assert.equal(listenerLargeRes.statusCode, 413);
      assert.equal(JSON.parse(listenerLargeRes.body).error, 'Request body too large');
    } finally {
      await server.stop();
    }
  });

  it('supports graceful shutdown via POST /__inline_review__/api/shutdown', async () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);
    const server = new InlineReviewServer(4321, htmlFile);

    try {
      const evilShutdownReq = new MockRequest('POST', '/__inline_review__/api/shutdown', {
        host: '127.0.0.1:4321',
        origin: 'https://evil.com',
      });
      const evilShutdownRes = await dispatchHandleRequest(server, evilShutdownReq);
      assert.equal(evilShutdownRes.statusCode, 403);

      const getShutdownReq = new MockRequest('GET', '/__inline_review__/api/shutdown', {
        host: '127.0.0.1:4321',
      });
      const getShutdownRes = await dispatchHandleRequest(server, getShutdownReq);
      assert.equal(getShutdownRes.statusCode, 404);

      const shutdownReq = new MockRequest('POST', '/__inline_review__/api/shutdown', {
        host: '127.0.0.1:4321',
        origin: 'http://127.0.0.1:4321',
      });
      const shutdownRes = await dispatchHandleRequest(server, shutdownReq);
      assert.equal(shutdownRes.statusCode, 200);
      assert.deepEqual(JSON.parse(shutdownRes.body), { ok: true, shuttingDown: true });

      // Allow scheduled setImmediate(() => this.stop()) to execute before finally calls stop() again
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await server.stop();
    }
  });

  it('locks sandbox toggle while a connected Codex session is waiting and recovers afterward', async () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);
    const server = new InlineReviewServer(4321, htmlFile, undefined, {
      env: {},
      requirementsPath: path.join(dir, 'no-requirements.toml'),
    });

    try {
      const waitPromise = server.waitForSubmission(htmlFile, 5_000);

      const waitingStateReq = new MockRequest(
        'GET',
        `/__inline_review__/api/state?file=${encodeURIComponent(htmlFile)}`,
        { host: '127.0.0.1:4321' }
      );
      const waitingStateRes = await dispatchHandleRequest(server, waitingStateReq);
      const waitingState = JSON.parse(waitingStateRes.body);
      assert.equal(waitingState.waitingAgentsCount, 1);
      assert.equal(waitingState.sandbox.controlSource, 'connected-session');
      assert.equal(waitingState.sandbox.effectiveMode, 'session-controlled');
      assert.equal(waitingState.sandbox.canToggle, false);
      assert.equal(waitingState.sandbox.label, 'Session Sandbox');

      // Attempted toggle while session is listening must be refused honestly
      const blockedToggleReq = new MockRequest(
        'POST',
        '/__inline_review__/api/sandbox',
        { host: '127.0.0.1:4321', 'content-type': 'application/json' },
        JSON.stringify({ file: htmlFile, sandboxMode: 'workspace-write' })
      );
      const blockedToggleRes = await dispatchHandleRequest(server, blockedToggleReq);
      const blockedBody = JSON.parse(blockedToggleRes.body);
      assert.equal(blockedBody.ok, false);
      assert.equal(blockedBody.applied, false);
      assert.equal(blockedBody.sandbox.controlSource, 'connected-session');

      // Submitting resolves the connected session and restores standalone toggle control
      const submitReq = new MockRequest(
        'POST',
        '/__inline_review__/api/submit',
        { host: '127.0.0.1:4321', 'content-type': 'application/json' },
        JSON.stringify({ file: htmlFile, autoRunCodex: false })
      );
      const submitRes = await dispatchHandleRequest(server, submitReq);
      const submitBody = JSON.parse(submitRes.body);
      assert.equal(submitBody.notifiedWaiters, 1);
      assert.equal(submitBody.sandbox.controlSource, 'background-codex');
      assert.equal(submitBody.sandbox.canToggle, true);

      await waitPromise;

      // Aborting a waiter via AbortController also restores standalone toggle control
      const abortController = new AbortController();
      const abortedWait = server.waitForSubmission(htmlFile, 5_000, abortController.signal);
      abortController.abort();
      await abortedWait;

      const recoveredStateReq = new MockRequest(
        'GET',
        `/__inline_review__/api/state?file=${encodeURIComponent(htmlFile)}`,
        { host: '127.0.0.1:4321' }
      );
      const recoveredStateRes = await dispatchHandleRequest(server, recoveredStateReq);
      const recoveredState = JSON.parse(recoveredStateRes.body);
      assert.equal(recoveredState.waitingAgentsCount, 0);
      assert.equal(recoveredState.sandbox.controlSource, 'background-codex');
      assert.equal(recoveredState.sandbox.canToggle, true);
    } finally {
      await server.stop();
    }
  });

  it('cleans up waiter state when a POST /__inline_review__/api/wait client disconnects early', async () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);
    const server = new InlineReviewServer(4321, htmlFile, undefined, {
      env: {},
      requirementsPath: path.join(dir, 'no-requirements.toml'),
    });

    try {
      const waitReq = new MockRequest(
        'POST',
        '/__inline_review__/api/wait',
        { host: '127.0.0.1:4321', 'content-type': 'application/json' },
        JSON.stringify({ file: htmlFile, timeoutMs: 5_000 })
      );
      const waitRes = new MockResponse();
      const handlePromise = (
        server as unknown as {
          handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
        }
      ).handleRequest(waitReq as unknown as IncomingMessage, waitRes as unknown as ServerResponse);

      // Let readJsonBody finish and waitForSubmission register
      await new Promise((r) => setTimeout(r, 30));

      const activeStateReq = new MockRequest(
        'GET',
        `/__inline_review__/api/state?file=${encodeURIComponent(htmlFile)}`,
        { host: '127.0.0.1:4321' }
      );
      const activeStateRes = await dispatchHandleRequest(server, activeStateReq);
      assert.equal(JSON.parse(activeStateRes.body).waitingAgentsCount, 1);

      // Simulate client closing connection before response ends
      waitRes.emit('close');
      await handlePromise;

      const afterCloseReq = new MockRequest(
        'GET',
        `/__inline_review__/api/state?file=${encodeURIComponent(htmlFile)}`,
        { host: '127.0.0.1:4321' }
      );
      const afterCloseRes = await dispatchHandleRequest(server, afterCloseReq);
      const afterCloseState = JSON.parse(afterCloseRes.body);
      assert.equal(afterCloseState.waitingAgentsCount, 0);
      assert.equal(afterCloseState.sandbox.controlSource, 'background-codex');
    } finally {
      await server.stop();
    }
  });

  it('detects outer OS sandbox signals and locks Full Access toggling', async () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);
    const noReq = path.join(dir, 'no-requirements.toml');

    const seatbeltServer = new InlineReviewServer(4321, htmlFile, undefined, {
      env: { CODEX_SANDBOX: 'seatbelt' },
      requirementsPath: noReq,
    });
    try {
      const stateReq = new MockRequest(
        'GET',
        `/__inline_review__/api/state?file=${encodeURIComponent(htmlFile)}`,
        { host: '127.0.0.1:4321' }
      );
      const stateRes = await dispatchHandleRequest(seatbeltServer, stateReq);
      const stateBody = JSON.parse(stateRes.body);
      assert.equal(stateBody.sandboxMode, 'workspace-write');
      assert.equal(stateBody.sandbox.controlSource, 'externally-sandboxed');
      assert.equal(stateBody.sandbox.canToggle, false);
      assert.equal(stateBody.sandbox.label, 'Host Sandboxed');
      assert.equal(stateBody.sandbox.externalSandboxSignal, 'CODEX_SANDBOX=seatbelt');
      assert.ok(stateBody.sandbox.restartCommand);

      const toggleReq = new MockRequest(
        'POST',
        '/__inline_review__/api/sandbox',
        { host: '127.0.0.1:4321', 'content-type': 'application/json' },
        JSON.stringify({ file: htmlFile, sandboxMode: 'full-access' })
      );
      const toggleRes = await dispatchHandleRequest(seatbeltServer, toggleReq);
      const toggleBody = JSON.parse(toggleRes.body);
      assert.equal(toggleBody.ok, false);
      assert.equal(toggleBody.applied, false);
      assert.equal(toggleBody.sandbox.controlSource, 'externally-sandboxed');
    } finally {
      await seatbeltServer.stop();
    }

    const netDisabledServer = new InlineReviewServer(4321, htmlFile, undefined, {
      env: { CODEX_SANDBOX_NETWORK_DISABLED: '1' },
      requirementsPath: noReq,
    });
    try {
      const caps = netDisabledServer.getSandboxCapabilities(htmlFile);
      assert.equal(caps.controlSource, 'externally-sandboxed');
      assert.equal(caps.canToggle, false);
      assert.equal(caps.externalSandboxSignal, 'CODEX_SANDBOX_NETWORK_DISABLED=1');
    } finally {
      await netDisabledServer.stop();
    }
  });

  it('enforces system requirements.toml allowed_sandbox_modes policy', async () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);
    const restrictedReqPath = path.join(dir, 'restricted-requirements.toml');
    fs.writeFileSync(
      restrictedReqPath,
      '# Managed policy\nallowed_sandbox_modes = ["read-only", "workspace-write"]\n',
      'utf8'
    );

    const restrictedServer = new InlineReviewServer(4321, htmlFile, undefined, {
      env: {},
      requirementsPath: restrictedReqPath,
    });
    try {
      const caps = restrictedServer.getSandboxCapabilities(htmlFile);
      assert.equal(caps.configuredMode, 'workspace-write');
      assert.equal(caps.controlSource, 'policy-restricted');
      assert.equal(caps.canToggle, false);
      assert.equal(caps.label, 'Policy Sandboxed');

      const toggleReq = new MockRequest(
        'POST',
        '/__inline_review__/api/sandbox',
        { host: '127.0.0.1:4321', 'content-type': 'application/json' },
        JSON.stringify({ file: htmlFile, sandboxMode: 'full-access' })
      );
      const toggleRes = await dispatchHandleRequest(restrictedServer, toggleReq);
      const toggleBody = JSON.parse(toggleRes.body);
      assert.equal(toggleBody.ok, false);
      assert.equal(toggleBody.applied, false);
      assert.equal(toggleBody.sandbox.controlSource, 'policy-restricted');
    } finally {
      await restrictedServer.stop();
    }

    const permissiveReqPath = path.join(dir, 'permissive-requirements.toml');
    fs.writeFileSync(
      permissiveReqPath,
      'allowed_sandbox_modes = ["workspace-write", "danger-full-access"]\n',
      'utf8'
    );
    const permissiveServer = new InlineReviewServer(4321, htmlFile, undefined, {
      env: {},
      requirementsPath: permissiveReqPath,
    });
    try {
      const caps = permissiveServer.getSandboxCapabilities(htmlFile);
      assert.equal(caps.configuredMode, 'full-access');
      assert.equal(caps.controlSource, 'background-codex');
      assert.equal(caps.canToggle, true);
    } finally {
      await permissiveServer.stop();
    }
  });

  it('resolves workspace root, builds mode-aware Codex invocations, and diagnoses sandbox errors', () => {
    const repoDemo = path.join(REPO_ROOT, 'examples', 'demo.html');
    assert.equal(resolveWorkspaceRoot(repoDemo), REPO_ROOT);

    const isolatedDir = makeTempDir('non-git-html-');
    const isolatedHtml = makeTempHtml(isolatedDir);
    assert.equal(resolveWorkspaceRoot(isolatedHtml), path.resolve(isolatedDir));

    const fullInvocation = buildBackgroundCodexInvocation({
      filePath: repoDemo,
      reviewReport: '# Review',
      sandboxMode: 'full-access',
      nodeBin: process.execPath,
      cliPath: CLI_ENTRY,
      tmpOutFile: '/tmp/out.txt',
      inlineHtmlContent: '<h1>Short</h1>',
    });
    assert.equal(fullInvocation.workDir, REPO_ROOT);
    assert.ok(fullInvocation.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(fullInvocation.args.includes('web_search="live"'));
    assert.ok(fullInvocation.args.includes('-C'));
    assert.ok(fullInvocation.args.includes(REPO_ROOT));
    assert.equal(fullInvocation.args.includes('-m'), false);
    assert.equal(
      fullInvocation.args.some((arg) => arg.includes('model_reasoning_effort')),
      false
    );
    assert.equal(fullInvocation.agentPrompt.includes('Read ONLY'), false);
    assert.equal(fullInvocation.agentPrompt.includes('Scope strictly to'), false);
    assert.match(fullInvocation.agentPrompt, /Full Access mode/);
    assert.match(fullInvocation.agentPrompt, /reply-batch/);
    assert.match(fullInvocation.agentPrompt, /--stdin/);
    assert.match(fullInvocation.agentPrompt, /Do NOT read external SKILL\.md files/);
    assert.match(fullInvocation.agentPrompt, /## Current HTML File/);
    assert.ok(fullInvocation.agentPrompt.includes('<h1>Short</h1>'));

    const wsInvocation = buildBackgroundCodexInvocation({
      filePath: repoDemo,
      reviewReport: '# Review',
      sandboxMode: 'workspace-write',
      nodeBin: process.execPath,
      cliPath: CLI_ENTRY,
      tmpOutFile: '/tmp/out.txt',
      model: 'gpt-5.4',
      inlineHtmlContent: 'x'.repeat(60_001),
    });
    assert.equal(wsInvocation.workDir, REPO_ROOT);
    const sandboxIdx = wsInvocation.args.indexOf('--sandbox');
    assert.notEqual(sandboxIdx, -1);
    assert.equal(wsInvocation.args[sandboxIdx + 1], 'workspace-write');
    const modelIdx = wsInvocation.args.indexOf('-m');
    assert.notEqual(modelIdx, -1);
    assert.equal(wsInvocation.args[modelIdx + 1], 'gpt-5.4');
    assert.equal(
      wsInvocation.args.some((arg) => arg.includes('model_reasoning_effort')),
      false
    );
    assert.ok(wsInvocation.args.includes('web_search="disabled"'));
    assert.ok(wsInvocation.args.includes('sandbox_workspace_write.network_access=false'));
    assert.ok(wsInvocation.args.includes('features.apps=false'));
    assert.ok(wsInvocation.args.includes('features.plugins=false'));
    assert.ok(wsInvocation.args.includes('features.remote_plugin=false'));
    assert.ok(wsInvocation.args.includes('features.browser_use=false'));
    assert.ok(wsInvocation.args.includes('features.browser_use_external=false'));
    assert.match(wsInvocation.agentPrompt, /workspace-write sandbox mode/);
    assert.equal(wsInvocation.agentPrompt.includes('## Current HTML File'), false);
    assert.match(wsInvocation.agentPrompt, /Start by reading/);

    const fullWarning = detectSandboxErrorMessage(['sandbox-exec: Operation not permitted'], 'full-access');
    assert.ok(fullWarning);
    assert.match(fullWarning, /outer|sandboxed shell|Restart codex-markup/i);

    const wsWarning = detectSandboxErrorMessage(['curl: (6) Could not resolve host: example.com'], 'workspace-write');
    assert.ok(wsWarning);
    assert.match(wsWarning, /workspace-write|Switch to Full Access/i);

    const epermWarning = detectSandboxErrorMessage(['Error: EPERM: operation not permitted, open /etc/hosts'], 'workspace-write');
    assert.ok(epermWarning);

    assert.equal(detectSandboxErrorMessage(['Updated styles', 'Done'], 'full-access'), undefined);
  });

  it('supports batch reply HTTP API, model discovery/selection, and connected-session model locking', async () => {
    const catalog = parseCodexModelsCatalog(
      JSON.stringify({
        models: [
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide', priority: 1 },
          { slug: 'second-model', display_name: 'Second Model', visibility: 'list', priority: 20 },
          { slug: 'first-model', display_name: 'First Model', description: 'Top priority', visibility: 'list', priority: 10 },
        ],
      })
    );
    assert.deepEqual(catalog, [
      { slug: 'first-model', displayName: 'First Model', description: 'Top priority' },
      { slug: 'second-model', displayName: 'Second Model' },
    ]);
    assert.deepEqual(parseCodexModelsCatalog('not-json'), []);

    assert.equal(resolveDefaultModel(undefined, {}), null);
    assert.equal(resolveDefaultModel('default', {}), null);
    assert.equal(resolveDefaultModel('AUTO', {}), null);
    assert.equal(resolveDefaultModel('gpt-5.4', {}), 'gpt-5.4');
    assert.equal(resolveDefaultModel(undefined, { CODEX_MARKUP_MODEL: 'gpt-5' }), 'gpt-5');

    const codexHome = makeTempDir('codex-model-home-');
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      '# user default\nmodel = "gpt-5.4"\n[profiles.fast]\nmodel = "gpt-5-mini"\n',
      'utf8'
    );
    assert.equal(readCodexConfigDefaultModel({ CODEX_HOME: codexHome }), 'gpt-5.4');

    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir);
    createThread(htmlFile, { mode: 'element', selector: 'h1', tagName: 'h1' }, 'Fix title spacing');
    createThread(htmlFile, { mode: 'element', selector: 'p', tagName: 'p' }, 'Explain metric');

    const server = new InlineReviewServer(4321, htmlFile, undefined, {
      env: { CODEX_HOME: codexHome },
      requirementsPath: path.join(dir, 'no-requirements.toml'),
      skipModelDiscovery: true,
      availableModels: [{ slug: 'gpt-6-sol', displayName: 'GPT-6 Sol', description: 'Balanced model' }],
    });

    try {
      const batchRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'POST',
          '/__inline_review__/api/reply-batch',
          { host: '127.0.0.1:4321', 'content-type': 'application/json' },
          JSON.stringify({
            file: htmlFile,
            replies: [
              { id: '#1', reply: 'Adjusted title margin', status: 'resolved' },
              { id: '2', text: 'Conversion excludes trials' },
              { id: 'c-999', text: 'Should be missing' },
            ],
          })
        )
      );
      assert.equal(batchRes.statusCode, 200);
      const batchBody = JSON.parse(batchRes.body);
      assert.equal(batchBody.ok, true);
      assert.equal(batchBody.updatedCount, 2);
      assert.deepEqual(batchBody.missing, ['c-999']);
      assert.equal(loadReviewState(htmlFile).threads[0].status, 'resolved');
      assert.equal(loadReviewState(htmlFile).threads[1].status, 'answered');

      const missingBatchRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'POST',
          '/__inline_review__/api/reply-batch',
          { host: '127.0.0.1:4321', 'content-type': 'application/json' },
          JSON.stringify({ file: htmlFile, replies: [{ id: 'c-404', text: 'Missing' }] })
        )
      );
      assert.equal(missingBatchRes.statusCode, 404);

      const healthRes = await dispatchHandleRequest(
        server,
        new MockRequest('GET', '/__inline_review__/api/health', { host: '127.0.0.1:4321' })
      );
      const healthBody = JSON.parse(healthRes.body);
      assert.equal(healthBody.model.configuredModel, null);
      assert.equal(healthBody.model.effectiveModel, 'gpt-5.4');
      assert.equal(healthBody.model.label, 'gpt-5.4');
      assert.equal(healthBody.model.canSelect, true);
      assert.equal(healthBody.model.defaultConfigModel, 'gpt-5.4');

      const selectRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'POST',
          '/__inline_review__/api/model',
          { host: '127.0.0.1:4321', 'content-type': 'application/json' },
          JSON.stringify({ file: htmlFile, model: 'gpt-6-sol' })
        )
      );
      const selectBody = JSON.parse(selectRes.body);
      assert.equal(selectBody.ok, true);
      assert.equal(selectBody.applied, true);
      assert.equal(selectBody.model.configuredModel, 'gpt-6-sol');
      assert.equal(selectBody.model.label, 'GPT-6 Sol');

      const resetRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'POST',
          '/__inline_review__/api/model',
          { host: '127.0.0.1:4321', 'content-type': 'application/json' },
          JSON.stringify({ file: htmlFile, model: 'default' })
        )
      );
      const resetBody = JSON.parse(resetRes.body);
      assert.equal(resetBody.ok, true);
      assert.equal(resetBody.model.configuredModel, null);

      const abortController = new AbortController();
      const waitPromise = server.waitForSubmission(htmlFile, 5_000, abortController.signal);
      const waitingStateRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'GET',
          `/__inline_review__/api/state?file=${encodeURIComponent(htmlFile)}`,
          { host: '127.0.0.1:4321' }
        )
      );
      const waitingState = JSON.parse(waitingStateRes.body);
      assert.equal(waitingState.model.canSelect, false);
      assert.equal(waitingState.model.controlSource, 'connected-session');
      assert.equal(waitingState.model.label, 'Session Model');

      const blockedModelRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'POST',
          '/__inline_review__/api/model',
          { host: '127.0.0.1:4321', 'content-type': 'application/json' },
          JSON.stringify({ file: htmlFile, model: 'gpt-6-sol' })
        )
      );
      const blockedModelBody = JSON.parse(blockedModelRes.body);
      assert.equal(blockedModelBody.ok, false);
      assert.equal(blockedModelBody.applied, false);
      assert.equal(blockedModelBody.model.controlSource, 'connected-session');

      abortController.abort();
      await waitPromise;

      const recoveredRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'GET',
          `/__inline_review__/api/state?file=${encodeURIComponent(htmlFile)}`,
          { host: '127.0.0.1:4321' }
        )
      );
      const recoveredBody = JSON.parse(recoveredRes.body);
      assert.equal(recoveredBody.model.canSelect, true);
      assert.equal(recoveredBody.model.controlSource, 'background-codex');
    } finally {
      await server.stop();
    }
  });

  it('discovers valid models with fallback and supports picking different models across API, submit, and Codex invocation', async () => {
    const dir = makeTempDir('codex-models-fallback-');
    const htmlFile = makeTempHtml(dir);
    const cacheHome = path.join(dir, 'cache-home');
    fs.mkdirSync(cacheHome, { recursive: true });
    fs.writeFileSync(
      path.join(cacheHome, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', description: 'Fast model', visibility: 'list', priority: 4 },
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: 'Workhorse', visibility: 'list', priority: 1 },
          { slug: 'secret-hidden', display_name: 'Secret', visibility: 'hide', priority: 0 },
        ],
      }),
      'utf8'
    );
    const cachedModels = readCodexModelsCache({ CODEX_HOME: cacheHome });
    assert.deepEqual(
      cachedModels.map((m) => m.slug),
      ['gpt-6.1-sol', 'gpt-6-luna']
    );

    const blockedHome = path.join(dir, 'blocked-codex-home');
    const mockCodexBin = path.join(dir, 'mock-codex');
    fs.writeFileSync(
      mockCodexBin,
      [
        '#!/bin/sh',
        'if [ "$1" = "debug" ] && [ "$2" = "models" ]; then',
        `  if [ "$CODEX_HOME" = ${JSON.stringify(blockedHome)} ]; then`,
        '    echo "Error: Failed to read config file: Operation not permitted" >&2',
        '    exit 0',
        '  fi',
        '  cat <<\'JSON\'',
        '{"models":[',
        '  {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","description":"Frontier intelligence","visibility":"list","priority":2},',
        '  {"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","description":"Latest workhorse","visibility":"list","priority":1},',
        '  {"slug":"gpt-6-luna","display_name":"GPT-6-Luna","description":"Fast and affordable","visibility":"list","priority":3},',
        '  {"slug":"codex-hidden","display_name":"Hidden","visibility":"hide","priority":0}',
        ']}',
        'JSON',
        '  exit 0',
        'fi',
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    const discovered = await loadAvailableModels(mockCodexBin, { CODEX_HOME: blockedHome });
    assert.deepEqual(
      discovered.map((m) => m.slug),
      ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']
    );

    const server = new InlineReviewServer(4321, htmlFile, undefined, {
      env: { CODEX_HOME: blockedHome, CODEX_CLI_PATH: mockCodexBin },
      requirementsPath: path.join(dir, 'no-requirements.toml'),
    });

    try {
      const initialStateRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'GET',
          `/__inline_review__/api/state?file=${encodeURIComponent(htmlFile)}`,
          { host: '127.0.0.1:4321' }
        )
      );
      const initialState = JSON.parse(initialStateRes.body);
      assert.equal(initialState.model.configuredModel, null);
      assert.equal(initialState.model.effectiveModel, 'gpt-6.1-sol');
      assert.equal(initialState.model.label, 'GPT-6.1-Sol');
      assert.equal(initialState.model.canSelect, true);
      assert.deepEqual(
        initialState.model.availableModels.map((m: { slug: string }) => m.slug),
        ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']
      );

      // Pick first model: gpt-6-astra
      const pickAstraRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'POST',
          '/__inline_review__/api/model',
          { host: '127.0.0.1:4321', 'content-type': 'application/json' },
          JSON.stringify({ file: htmlFile, model: 'gpt-6-astra' })
        )
      );
      const pickAstraBody = JSON.parse(pickAstraRes.body);
      assert.equal(pickAstraBody.ok, true);
      assert.equal(pickAstraBody.applied, true);
      assert.equal(pickAstraBody.model.configuredModel, 'gpt-6-astra');
      assert.equal(pickAstraBody.model.effectiveModel, 'gpt-6-astra');
      assert.equal(pickAstraBody.model.label, 'GPT-6-Astra');

      // Switch to a different model: gpt-6-luna
      const pickLunaRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'POST',
          '/__inline_review__/api/model',
          { host: '127.0.0.1:4321', 'content-type': 'application/json' },
          JSON.stringify({ file: htmlFile, model: 'gpt-6-luna' })
        )
      );
      const pickLunaBody = JSON.parse(pickLunaRes.body);
      assert.equal(pickLunaBody.ok, true);
      assert.equal(pickLunaBody.model.configuredModel, 'gpt-6-luna');
      assert.equal(pickLunaBody.model.effectiveModel, 'gpt-6-luna');
      assert.equal(pickLunaBody.model.label, 'GPT-6-Luna');

      const stateAfterLunaRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'GET',
          `/__inline_review__/api/state?file=${encodeURIComponent(htmlFile)}`,
          { host: '127.0.0.1:4321' }
        )
      );
      const stateAfterLuna = JSON.parse(stateAfterLunaRes.body);
      assert.equal(stateAfterLuna.model.configuredModel, 'gpt-6-luna');
      assert.equal(stateAfterLuna.model.effectiveModel, 'gpt-6-luna');
      assert.equal(stateAfterLuna.model.label, 'GPT-6-Luna');

      const lunaInvocation = buildBackgroundCodexInvocation({
        filePath: htmlFile,
        reviewReport: '# Review',
        sandboxMode: 'full-access',
        nodeBin: process.execPath,
        cliPath: CLI_ENTRY,
        tmpOutFile: path.join(dir, 'out.txt'),
        model: stateAfterLuna.model.configuredModel,
      });
      const lunaIdx = lunaInvocation.args.indexOf('-m');
      assert.notEqual(lunaIdx, -1);
      assert.equal(lunaInvocation.args[lunaIdx + 1], 'gpt-6-luna');
      assert.equal(
        lunaInvocation.args.some((arg) => arg.includes('model_reasoning_effort')),
        false
      );

      // Switch model directly via /submit payload
      const submitSwitchRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'POST',
          '/__inline_review__/api/submit',
          { host: '127.0.0.1:4321', 'content-type': 'application/json' },
          JSON.stringify({ file: htmlFile, model: 'gpt-6.1-sol', autoRunCodex: false })
        )
      );
      const submitSwitchBody = JSON.parse(submitSwitchRes.body);
      assert.equal(submitSwitchBody.ok, true);
      assert.equal(submitSwitchBody.model.configuredModel, 'gpt-6.1-sol');
      assert.equal(submitSwitchBody.model.effectiveModel, 'gpt-6.1-sol');
      assert.equal(submitSwitchBody.model.label, 'GPT-6.1-Sol');

      // Reset to resolved default model
      const resetRes = await dispatchHandleRequest(
        server,
        new MockRequest(
          'POST',
          '/__inline_review__/api/model',
          { host: '127.0.0.1:4321', 'content-type': 'application/json' },
          JSON.stringify({ file: htmlFile, model: null })
        )
      );
      const resetBody = JSON.parse(resetRes.body);
      assert.equal(resetBody.ok, true);
      assert.equal(resetBody.model.configuredModel, null);
      assert.equal(resetBody.model.effectiveModel, 'gpt-6.1-sol');
      assert.equal(resetBody.model.label, 'GPT-6.1-Sol');
    } finally {
      await server.stop();
    }
  });
});

// =============================================================================
// Suite 3 — MCP Server Protocol & Tool Execution (src/mcp.ts)
// =============================================================================

type FramingMode = 'line' | 'content-length';

interface JsonRpcResponse {
  jsonrpc: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class McpTestClient {
  private child: ChildProcessWithoutNullStreams;
  private framing: FramingMode;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (msg: JsonRpcResponse) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private stderrLogs: string[] = [];

  constructor(framing: FramingMode) {
    this.framing = framing;
    this.child = spawn(process.execPath, ['--no-warnings', CLI_ENTRY, 'mcp'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CODEX_REVIEW_PORT: '99999',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainBuffer();
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrLogs.push(chunk.toString('utf8'));
    });

    this.child.on('exit', (code, signal) => {
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer);
        entry.reject(
          new Error(
            `MCP server exited (code=${code}, signal=${signal}) before responding to id=${id}. stderr=${this.stderrLogs.join('')}`
          )
        );
        this.pending.delete(id);
      }
    });
  }

  private drainBuffer(): void {
    while (this.buffer.length > 0) {
      if (this.framing === 'content-length') {
        const sepIdx = this.buffer.indexOf('\r\n\r\n');
        if (sepIdx === -1) break;
        const headerStr = this.buffer.subarray(0, sepIdx).toString('utf8');
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          throw new Error(`Invalid Content-Length frame header: ${JSON.stringify(headerStr)}`);
        }
        const byteLen = Number(match[1]);
        const bodyStart = sepIdx + 4;
        if (this.buffer.length < bodyStart + byteLen) break;
        const jsonStr = this.buffer.subarray(bodyStart, bodyStart + byteLen).toString('utf8');
        this.buffer = this.buffer.subarray(bodyStart + byteLen);
        this.resolveMessage(JSON.parse(jsonStr) as JsonRpcResponse);
      } else {
        const nlIdx = this.buffer.indexOf(0x0a);
        if (nlIdx === -1) break;
        const line = this.buffer.subarray(0, nlIdx).toString('utf8').trim();
        this.buffer = this.buffer.subarray(nlIdx + 1);
        if (!line) continue;
        this.resolveMessage(JSON.parse(line) as JsonRpcResponse);
      }
    }
  }

  private resolveMessage(msg: JsonRpcResponse): void {
    if (msg.id === undefined || msg.id === null) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    entry.resolve(msg);
  }

  private writeFrame(payload: Record<string, unknown>): void {
    const json = JSON.stringify(payload);
    if (this.framing === 'content-length') {
      const byteLen = Buffer.byteLength(json, 'utf8');
      this.child.stdin.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      this.child.stdin.write(`${json}\n`);
    }
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.writeFrame({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  request(method: string, params?: Record<string, unknown>, timeoutMs = 8_000): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response to ${method} (id=${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeFrame({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    });
  }

  async close(): Promise<void> {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        if (this.child.exitCode === null) {
          this.child.kill('SIGKILL');
        }
        resolve();
      }, 1_000);
      this.child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      this.child.stdin.end();
      this.child.kill('SIGTERM');
    });
  }
}

async function verifyMcpSession(framing: FramingMode): Promise<void> {
  const dir = makeTempDir();
  const htmlFile = makeTempHtml(dir);
  createThread(
    htmlFile,
    {
      mode: 'text',
      selector: 'h1',
      tagName: 'h1',
      selectedText: 'Hello',
      htmlSnippet: '<h1>Hello</h1>',
    },
    'Make greeting festive 🚀'
  );

  const client = new McpTestClient(framing);
  try {
    // initialize + initialized notification
    const initRes = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'eval-suite', version: '1.0.0' },
    });
    assert.equal(initRes.result?.protocolVersion, '2024-11-05');
    assert.deepEqual(initRes.result?.serverInfo, {
      name: 'codex-markup',
      version: '1.0.0',
    });
    client.notify('notifications/initialized');

    // ping
    const pingRes = await client.request('ping');
    assert.deepEqual(pingRes.result, {});

    // tools/list -> all 6 tools
    const listRes = await client.request('tools/list');
    const tools = (listRes.result?.tools as Array<{ name: string }>) || [];
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        'open_html_review',
        'wait_for_review',
        'get_inline_comments',
        'reply_to_comment',
        'reply_to_comments',
        'resolve_comment',
      ]
    );

    // open_html_review (non-blocking, no browser launch)
    const openRes = await client.request('tools/call', {
      name: 'open_html_review',
      arguments: { file_path: htmlFile, open_browser: false },
    });
    const openText = ((openRes.result?.content as Array<{ text: string }>) || [])[0]?.text || '';
    assert.match(openText, /Opened inline review for/);
    assert.ok(openText.includes(path.resolve(htmlFile)));

    // get_inline_comments
    const getRes = await client.request('tools/call', {
      name: 'get_inline_comments',
      arguments: { file_path: htmlFile, status: 'open' },
    });
    const getText = ((getRes.result?.content as Array<{ text: string }>) || [])[0]?.text || '';
    assert.match(getText, /Make greeting festive 🚀/);
    assert.match(getText, /ID: `c-1`/);

    // reply_to_comment
    const replyRes = await client.request('tools/call', {
      name: 'reply_to_comment',
      arguments: {
        file_path: htmlFile,
        comment_id: 'c-1',
        reply: 'Updated heading copy.',
        status: 'answered',
      },
    });
    const replyText = ((replyRes.result?.content as Array<{ text: string }>) || [])[0]?.text || '';
    assert.match(replyText, /Replied to comment c-1 \(status: answered\)/);
    assert.equal(loadReviewState(htmlFile).threads[0].status, 'answered');

    // resolve_comment
    const resolveRes = await client.request('tools/call', {
      name: 'resolve_comment',
      arguments: {
        file_path: htmlFile,
        comment_id: 'c-1',
        status: 'resolved',
      },
    });
    const resolveText = ((resolveRes.result?.content as Array<{ text: string }>) || [])[0]?.text || '';
    assert.match(resolveText, /Updated comment c-1 status to "resolved"/);
    assert.equal(loadReviewState(htmlFile).threads[0].status, 'resolved');

    // wait_for_review waking up when markSubmitted is triggered on disk
    createThread(htmlFile, { mode: 'element', selector: 'body', tagName: 'body' }, 'Check spacing after reload');
    const waitPromise = client.request('tools/call', {
      name: 'wait_for_review',
      arguments: { file_path: htmlFile, timeout_seconds: 8 },
    });

    setTimeout(() => {
      markSubmitted(htmlFile, 'Triggered via sidecar on disk');
    }, 80);

    const waitRes = await waitPromise;
    const waitText = ((waitRes.result?.content as Array<{ text: string }>) || [])[0]?.text || '';
    assert.match(waitText, /Check spacing after reload/);
    assert.match(waitText, /Triggered via sidecar on disk/);
    assert.match(waitText, /ID: `c-2`/);

    // reply_to_comments batch across multiple threads
    createThread(htmlFile, { mode: 'element', selector: 'footer', tagName: 'footer' }, 'Update footer copyright');
    const batchMcpRes = await client.request('tools/call', {
      name: 'reply_to_comments',
      arguments: {
        file_path: htmlFile,
        replies: [
          { comment_id: 'c-2', reply: 'Adjusted container gap to 24px.', status: 'resolved' },
          { comment_id: 'c-3', reply: 'Year is up to date.', status: 'answered' },
        ],
      },
    });
    const batchMcpText = ((batchMcpRes.result?.content as Array<{ text: string }>) || [])[0]?.text || '';
    assert.match(batchMcpText, /Replied to 2 comment\(s\) in batch \(c-2:resolved, c-3:answered\)/);
    const stateAfterMcpBatch = loadReviewState(htmlFile);
    assert.equal(stateAfterMcpBatch.threads.find((t) => t.id === 'c-2')?.status, 'resolved');
    assert.equal(stateAfterMcpBatch.threads.find((t) => t.id === 'c-3')?.status, 'answered');
  } finally {
    await client.close();
  }
}

describe('Suite 3 — MCP Server Protocol & Tool Execution', () => {
  it('handles newline-delimited JSON-RPC lifecycle, all 6 tools, and disk-triggered wait_for_review', async () => {
    await verifyMcpSession('line');
  });

  it('handles Content-Length framed JSON-RPC lifecycle, all 6 tools, and disk-triggered wait_for_review', async () => {
    await verifyMcpSession('content-length');
  });
});

// =============================================================================
// Suite 4 — CLI End-to-End Evaluation (src/cli.ts)
// =============================================================================

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ['--no-warnings', CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CODEX_REVIEW_PORT: '99999',
    },
  });
}

describe('Suite 4 — CLI End-to-End Evaluation', () => {
  it('installs config.toml, SKILL.md, and AGENTS.md into --codex-home idempotently', async () => {
    const codexHome = makeTempDir('codex-home-eval-');
    const configPath = path.join(codexHome, 'config.toml');
    const agentsPath = path.join(codexHome, 'AGENTS.md');
    const skillPath = path.join(codexHome, 'skills', 'inline-html-review', 'SKILL.md');

    // Seed pre-existing unrelated content and a quoted [mcp_servers."inline-review"] block to verify non-destructive merge
    fs.writeFileSync(
      configPath,
      'model = "gpt-5"\n\n[mcp_servers."inline-review"]\ncommand = "old-node"\nargs = ["old.ts"]\n',
      'utf8'
    );
    fs.writeFileSync(agentsPath, '# Custom User Instructions\nKeep diffs minimal.\n', 'utf8');

    const firstInstall = await runCli(['install', '--codex-home', codexHome]);
    assert.match(firstInstall.stdout, /✓ Verified MCP server \(6 tools:/);
    assert.match(firstInstall.stdout, /STATUS: OK/);

    const configAfterFirst = fs.readFileSync(configPath, 'utf8');
    const agentsAfterFirst = fs.readFileSync(agentsPath, 'utf8');
    const skillAfterFirst = fs.readFileSync(skillPath, 'utf8');

    assert.match(configAfterFirst, /^model = "gpt-5"/);
    assert.match(configAfterFirst, /\[mcp_servers\.inline-review\]/);
    assert.equal(configAfterFirst.includes('[mcp_servers."inline-review"]'), false);
    assert.equal(configAfterFirst.includes('old-node'), false);
    assert.ok(configAfterFirst.includes(JSON.stringify(process.execPath)));
    assert.ok(configAfterFirst.includes(CLI_ENTRY));

    assert.equal(skillAfterFirst.includes('<path-to-codex-markup>/src/cli.ts'), false);
    assert.equal(skillAfterFirst.includes('<path-to-codex-inline-review>/src/cli.ts'), false);
    assert.equal(skillAfterFirst.includes(CLI_ENTRY), true);

    assert.match(agentsAfterFirst, /# Custom User Instructions/);
    assert.match(agentsAfterFirst, /<!-- BEGIN CODEX-INLINE-REVIEW -->/);
    assert.match(agentsAfterFirst, /<!-- END CODEX-INLINE-REVIEW -->/);

    // Second install must preserve existing content and keep single section/marker blocks
    await runCli(['install', '--codex-home', codexHome]);

    const configAfterSecond = fs.readFileSync(configPath, 'utf8');
    const agentsAfterSecond = fs.readFileSync(agentsPath, 'utf8');
    const skillAfterSecond = fs.readFileSync(skillPath, 'utf8');

    assert.match(configAfterSecond, /^model = "gpt-5"/);
    assert.equal(configAfterSecond, configAfterFirst);
    assert.equal(configAfterSecond.match(/\[mcp_servers\.inline-review\]/g)?.length, 1);
    assert.equal(configAfterSecond.match(/command\s*=/g)?.length, 1);
    assert.equal(agentsAfterSecond, agentsAfterFirst);
    assert.equal(skillAfterSecond, skillAfterFirst);
    assert.equal(agentsAfterSecond.match(/<!-- BEGIN CODEX-INLINE-REVIEW -->/g)?.length, 1);
  });

  it('executes add-comment, comments --status, reply --resolve, and resolve --reopen end-to-end', async () => {
    const dir = makeTempDir();
    const htmlFile = makeTempHtml(dir, 'page.html', '<html><body><header class="hero">Banner</header></body></html>');

    const add1 = await runCli([
      'add-comment',
      htmlFile,
      'Make hero banner taller',
      '--selector',
      'header.hero',
      '--tag',
      'header',
    ]);
    assert.match(add1.stdout, /Added comment c-1 \(#1\)/);

    const add2 = await runCli([
      'add-comment',
      htmlFile,
      'Adjust body font size',
      '--selector',
      'body',
      '--tag',
      'body',
    ]);
    assert.match(add2.stdout, /Added comment c-2 \(#2\)/);

    const listOpen1 = await runCli(['comments', htmlFile, '--status', 'open']);
    assert.match(listOpen1.stdout, /Inline Comments \(2 open\)/);
    assert.match(listOpen1.stdout, /Make hero banner taller/);
    assert.match(listOpen1.stdout, /Adjust body font size/);

    const replyRes = await runCli([
      'reply',
      htmlFile,
      'c-1',
      'Increased hero padding to 64px.',
      '--resolve',
    ]);
    assert.match(replyRes.stdout, /Replied to c-1 \(status: resolved\)/);

    const listOpen2 = await runCli(['comments', htmlFile, '--status', 'open']);
    assert.match(listOpen2.stdout, /Inline Comments \(1 open\)/);
    assert.doesNotMatch(listOpen2.stdout, /Make hero banner taller/);
    assert.match(listOpen2.stdout, /Adjust body font size/);

    const listResolved = await runCli(['comments', htmlFile, '--status', 'resolved']);
    assert.match(listResolved.stdout, /Inline Comments \(1 resolved\)/);
    assert.match(listResolved.stdout, /Make hero banner taller/);
    assert.match(listResolved.stdout, /Increased hero padding to 64px\./);

    const reopenRes = await runCli(['resolve', htmlFile, 'c-1', '--reopen']);
    assert.match(reopenRes.stdout, /Updated c-1 status to open/);

    const listAll = await runCli(['comments', htmlFile, '--status', 'all']);
    assert.match(listAll.stdout, /Inline Comments \(2 total\)/);
    const listOpen3 = await runCli(['comments', htmlFile, '--status', 'open']);
    assert.match(listOpen3.stdout, /Inline Comments \(2 open\)/);

    const batchJsonRes = await runCli([
      'reply-batch',
      htmlFile,
      '--json',
      JSON.stringify([
        { id: 'c-1', reply: 'Batch JSON reply for c-1', status: 'answered' },
        { id: '#2', reply: 'Batch JSON reply for c-2', status: 'resolved' },
        { id: 'c-999', reply: 'Missing target thread' },
      ]),
    ]);
    assert.match(batchJsonRes.stdout, /Replied to 2 comment\(s\) in batch/);
    assert.match(batchJsonRes.stderr, /Missing comment ID\(s\): c-999/);
    const stateAfterJsonBatch = loadReviewState(htmlFile);
    assert.equal(stateAfterJsonBatch.threads[0].status, 'answered');
    assert.equal(stateAfterJsonBatch.threads[1].status, 'resolved');

    const stdinOutput = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--no-warnings', CLI_ENTRY, 'reply-batch', htmlFile, '--stdin', '--resolve'],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            CODEX_REVIEW_PORT: '99999',
          },
        }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`reply-batch --stdin exited ${code}: ${stderr || stdout}`));
        } else {
          resolve({ stdout, stderr });
        }
      });
      child.stdin.write(
        JSON.stringify([
          { id: 'c-1', reply: 'Resolved c-1 via stdin' },
          { id: 'c-2', reply: 'Resolved c-2 via stdin' },
        ])
      );
      child.stdin.end();
    });
    assert.match(stdinOutput.stdout, /Replied to 2 comment\(s\) in batch/);
    const stateAfterStdinBatch = loadReviewState(htmlFile);
    assert.equal(stateAfterStdinBatch.threads[0].status, 'resolved');
    assert.equal(stateAfterStdinBatch.threads[1].status, 'resolved');
    assert.equal(stateAfterStdinBatch.threads[0].messages.at(-1)?.text, 'Resolved c-1 via stdin');
  });

  it('supports --copy runtime relocation, doctor verification, and clean uninstall round-trip', async () => {
    assert.equal(isSupportedNodeVersion('22.18.0'), true);
    assert.equal(isSupportedNodeVersion('22.6.0'), false);
    assert.equal(isSupportedNodeVersion('22.17.0'), false);
    assert.equal(isSupportedNodeVersion('23.0.0'), false);
    assert.equal(isSupportedNodeVersion('v24.1.0'), true);
    assert.equal(isSupportedNodeVersion('22.5.9'), false);
    assert.equal(isSupportedNodeVersion('20.19.0'), false);

    assert.equal(isEphemeralCheckoutPath('/tmp/codex-markup'), true);
    assert.equal(isEphemeralCheckoutPath('/Users/u/.npm/_npx/123/node_modules/codex-markup'), true);
    assert.equal(isEphemeralCheckoutPath('/Users/u/Projects/codex-markup'), false);

    const codexHome = makeTempDir('codex-home-copy-');
    const configPath = path.join(codexHome, 'config.toml');
    const agentsPath = path.join(codexHome, 'AGENTS.md');
    const copiedRoot = path.join(codexHome, 'tools', 'codex-markup');
    const copiedCli = path.join(copiedRoot, 'src', 'cli.ts');
    const skillPath = path.join(codexHome, 'skills', 'inline-html-review', 'SKILL.md');

    fs.writeFileSync(configPath, 'model = "gpt-5"\n', 'utf8');
    fs.writeFileSync(agentsPath, '# Custom\nKeep local notes.\n', 'utf8');

    const installOut = await runCli(['install', '--codex-home', codexHome, '--copy']);
    assert.match(installOut.stdout, /✓ Installed runtime files to/);
    assert.match(installOut.stdout, /STATUS: OK/);
    assert.equal(fs.existsSync(copiedCli), true);

    const configText = fs.readFileSync(configPath, 'utf8');
    const skillText = fs.readFileSync(skillPath, 'utf8');
    assert.equal(configText.includes(copiedCli), true);
    assert.equal(skillText.includes(copiedCli), true);

    const doctorOk = await runCli(['doctor', '--codex-home', codexHome]);
    assert.match(doctorOk.stdout, /\[node-version\]/);
    assert.match(doctorOk.stdout, /\[mcp-handshake\]/);
    assert.match(doctorOk.stdout, /STATUS: OK/);

    const emptyHome = makeTempDir('codex-home-empty-');
    await assert.rejects(
      () => runCli(['doctor', '--codex-home', emptyHome]),
      (err: unknown) => {
        assert.ok(err && typeof err === 'object' && 'stdout' in err);
        assert.match(String((err as { stdout: string }).stdout), /STATUS: FAILED/);
        return true;
      }
    );

    const uninstallOut = await runCli(['uninstall', '--codex-home', codexHome]);
    assert.match(uninstallOut.stdout, /✓ Uninstalled codex-markup/);
    assert.equal(fs.existsSync(path.join(codexHome, 'skills', 'inline-html-review')), false);
    assert.equal(fs.existsSync(copiedRoot), false);

    const configAfterUninstall = fs.readFileSync(configPath, 'utf8');
    const agentsAfterUninstall = fs.readFileSync(agentsPath, 'utf8');
    assert.match(configAfterUninstall, /^model = "gpt-5"/);
    assert.equal(configAfterUninstall.includes('inline-review'), false);
    assert.match(agentsAfterUninstall, /# Custom/);
    assert.equal(agentsAfterUninstall.includes('BEGIN CODEX-INLINE-REVIEW'), false);
  });

  it('validates install.sh offline idempotently and bin/codex-markup.js entrypoint', async () => {
    const installScript = path.join(REPO_ROOT, 'install.sh');
    await execFileAsync('bash', ['-n', installScript], { cwd: REPO_ROOT });

    const shHome = makeTempDir('codex-home-sh-');
    const shEnv = {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
      CODEX_HOME: shHome,
      CODEX_MARKUP_SOURCE_DIR: REPO_ROOT,
      CODEX_REVIEW_PORT: '99999',
    };

    const firstRun = await execFileAsync('bash', [installScript], { cwd: REPO_ROOT, env: shEnv });
    assert.match(firstRun.stdout, /STATUS: OK/);
    assert.equal(fs.existsSync(path.join(shHome, 'tools', 'codex-markup', 'src', 'cli.ts')), true);

    const configFirst = fs.readFileSync(path.join(shHome, 'config.toml'), 'utf8');
    const agentsFirst = fs.readFileSync(path.join(shHome, 'AGENTS.md'), 'utf8');

    const secondRun = await execFileAsync('bash', [installScript], { cwd: REPO_ROOT, env: shEnv });
    assert.match(secondRun.stdout, /STATUS: OK/);
    assert.equal(fs.readFileSync(path.join(shHome, 'config.toml'), 'utf8'), configFirst);
    assert.equal(fs.readFileSync(path.join(shHome, 'AGENTS.md'), 'utf8'), agentsFirst);

    const binHelp = await execFileAsync(
      process.execPath,
      [path.join(REPO_ROOT, 'bin', 'codex-markup.js'), '--help'],
      { cwd: REPO_ROOT }
    );
    assert.match(binHelp.stdout, /\bdoctor\b/);
    assert.match(binHelp.stdout, /\buninstall\b/);
  });
});

describe('Installation distribution and recovery', () => {
  it('installs a packed package from node_modules and removes its custom runtime', async () => {
    const dir = makeTempDir('codex-package-');
    const pack = await execFileAsync('npm', ['pack', '--json', '--pack-destination', dir], { cwd: REPO_ROOT });
    const archives = fs.readdirSync(dir).filter((name) => name.endsWith('.tgz'));
    assert.equal(archives.length, 1, pack.stdout);
    const packagedRoot = path.join(dir, 'node_modules', 'codex-markup');
    fs.mkdirSync(packagedRoot, { recursive: true });
    await execFileAsync('tar', ['-xzf', path.join(dir, archives[0]), '--strip-components=1', '-C', packagedRoot]);
    const home = path.join(dir, "configuration 'quoted'");
    const runtime = path.join(dir, "permanent 'runtime'");
    const installed = await execFileAsync(process.execPath, [path.join(packagedRoot, 'bin', 'codex-markup.js'),
      'install', '--codex-home', home, '--install-dir', runtime, '--json']);
    const result = JSON.parse(installed.stdout);
    assert.equal(result.status, 'verified');
    assert.equal(result.runtimeRoot, runtime);
    assert.equal(result.restartRequired, true);
    assert.ok(result.phaseMs.verification >= 0);
    assert.equal(fs.existsSync(path.join(runtime, 'examples', 'demo.html')), true);
    const repeated = await execFileAsync(process.execPath, [path.join(runtime, 'src', 'cli.ts'),
      'install', '--codex-home', home, '--install-dir', runtime]);
    const doctorCommand = repeated.stdout.split('\n').find((line) => line.startsWith('Doctor: '));
    assert.ok(doctorCommand);
    await execFileAsync('bash', ['-c', doctorCommand.slice('Doctor: '.length)]);
    // Prove the installed CLI survives removal of the package cache.
    fs.rmSync(packagedRoot, { recursive: true });
    await execFileAsync(process.execPath, [path.join(runtime, 'src', 'cli.ts'), 'doctor', '--codex-home', home]);
    await execFileAsync(process.execPath, [path.join(runtime, 'src', 'cli.ts'), 'uninstall', '--codex-home', home]);
    assert.equal(fs.existsSync(runtime), false);
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8').includes('inline-review'), false);
  });

  it('preserves an unowned directory and contributor source checkout during uninstall', async () => {
    const home = makeTempDir('codex-ownership-');
    const runtime = path.join(home, 'foreign');
    fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, 'notes.txt'), 'keep me');
    await assert.rejects(() => runCli(['install', '--codex-home', home, '--install-dir', runtime]));
    assert.equal(fs.readFileSync(path.join(runtime, 'notes.txt'), 'utf8'), 'keep me');
    // A forged manifest alone cannot authorize removal without a matching runtime marker.
    fs.writeFileSync(path.join(home, 'codex-markup-install.json'), JSON.stringify({ runtimeRoot: runtime, codexHome: home, managed: true }));
    await runCli(['uninstall', '--codex-home', home]);
    assert.equal(fs.existsSync(runtime), true);
    const source = path.join(home, 'checkout');
    fs.cpSync(REPO_ROOT, source, { recursive: true, filter: (entry) => !['.git', 'node_modules'].includes(path.basename(entry)) });
    const { installForCodex } = await import('../src/install.ts');
    // Installing in place must never confer ownership of a contributor checkout.
    await installForCodex({ sourceRoot: source, codexHome: home, installDir: source, json: true });
    await runCli(['uninstall', '--codex-home', home]);
    assert.equal(fs.existsSync(path.join(source, 'src', 'cli.ts')), true);
  });

  it('keeps a working install after download or verification failure and replaces it on success', async () => {
    const dir = makeTempDir('codex-update-');
    const remote = path.join(dir, 'remote');
    fs.cpSync(REPO_ROOT, remote, { recursive: true, filter: (entry) => !['.git', 'node_modules'].includes(path.basename(entry)) });
    await execFileAsync('git', ['init', '-b', 'main', remote]);
    await execFileAsync('git', ['add', '.'], { cwd: remote });
    await execFileAsync('git', ['-c', 'user.name=Installation Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: remote });
    const home = path.join(dir, 'home');
    const runtime = path.join(dir, 'runtime');
    const script = path.join(REPO_ROOT, 'install.sh');
    const env = { ...process.env, CODEX_HOME: home, CODEX_MARKUP_DIR: runtime,
      CODEX_MARKUP_SOURCE_DIR: '', CODEX_MARKUP_REPO: remote };
    await execFileAsync('bash', [script], { env });
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    fs.writeFileSync(path.join(runtime, 'sentinel'), 'old runtime');
    await assert.rejects(() => execFileAsync('bash', [script], { env: { ...env, CODEX_MARKUP_REPO: path.join(dir, 'missing-repository') } }));
    assert.equal(fs.readFileSync(path.join(runtime, 'sentinel'), 'utf8'), 'old runtime');
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), config);
    fs.writeFileSync(path.join(remote, 'src', 'cli.ts'), 'throw new Error("bad release");');
    await execFileAsync('git', ['add', '.'], { cwd: remote });
    await execFileAsync('git', ['-c', 'user.name=Installation Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'broken fixture'], { cwd: remote });
    await assert.rejects(() => execFileAsync('bash', [script], { env }));
    assert.equal(fs.readFileSync(path.join(runtime, 'sentinel'), 'utf8'), 'old runtime');
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), config);
    await execFileAsync(process.execPath, [path.join(runtime, 'src', 'cli.ts'), 'doctor', '--codex-home', home]);
    await execFileAsync('git', ['revert', '--no-edit', 'HEAD'], { cwd: remote, env: { ...process.env,
      GIT_COMMITTER_NAME: 'Installation Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
    const workingCli = fs.readFileSync(path.join(remote, 'src', 'cli.ts'), 'utf8');
    fs.writeFileSync(path.join(remote, 'src', 'cli.ts'),
      `import failureFs from 'node:fs'; if (process.argv.includes(${JSON.stringify(home)})) { failureFs.writeFileSync(${JSON.stringify(path.join(home, 'config.toml'))}, 'partial configuration'); process.exit(1); }\n` + workingCli);
    await execFileAsync('git', ['add', '.'], { cwd: remote });
    await execFileAsync('git', ['-c', 'user.name=Installation Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'registration failure fixture'], { cwd: remote });
    await assert.rejects(() => execFileAsync('bash', [script], { env }));
    assert.equal(fs.readFileSync(path.join(runtime, 'sentinel'), 'utf8'), 'old runtime');
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), config);
    await execFileAsync(process.execPath, [path.join(runtime, 'src', 'cli.ts'), 'doctor', '--codex-home', home]);
    await execFileAsync('git', ['revert', '--no-edit', 'HEAD'], { cwd: remote, env: { ...process.env,
      GIT_COMMITTER_NAME: 'Installation Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
    await execFileAsync('bash', [script], { env });
    assert.equal(fs.existsSync(path.join(runtime, 'sentinel')), false);
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), config);
    await execFileAsync(process.execPath, [path.join(runtime, 'src', 'cli.ts'), 'uninstall', '--codex-home', home]);
    assert.equal(fs.existsSync(runtime), false);
  });
});
