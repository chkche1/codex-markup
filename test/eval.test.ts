import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

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
import { readServerVersion } from '../src/mcp.ts';
import {
  UserCustomizationError,
  computeRuntimeSha256,
  copyRuntimeToDir,
  installForCodex,
  isEphemeralCheckoutPath,
  isSupportedNodeVersion,
  readInstallManifest,
  runDoctor,
  syncCodexSetup,
  uninstallFromCodex,
  updateInstallation,
} from '../src/install.ts';

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
    await execFileAsync('git', ['-c', 'user.name=Installation Test', '-c', 'user.email=test@example.invalid', 'revert', '--no-edit', 'HEAD'], { cwd: remote });
    const workingCli = fs.readFileSync(path.join(remote, 'src', 'cli.ts'), 'utf8');
    fs.writeFileSync(path.join(remote, 'src', 'cli.ts'),
      `import failureFs from 'node:fs'; if (process.argv.includes(${JSON.stringify(home)})) { failureFs.writeFileSync(${JSON.stringify(path.join(home, 'config.toml'))}, 'partial configuration'); process.exit(1); }\n` + workingCli);
    await execFileAsync('git', ['add', '.'], { cwd: remote });
    await execFileAsync('git', ['-c', 'user.name=Installation Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'registration failure fixture'], { cwd: remote });
    await assert.rejects(() => execFileAsync('bash', [script], { env }));
    assert.equal(fs.readFileSync(path.join(runtime, 'sentinel'), 'utf8'), 'old runtime');
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), config);
    await execFileAsync(process.execPath, [path.join(runtime, 'src', 'cli.ts'), 'doctor', '--codex-home', home]);
    await execFileAsync('git', ['-c', 'user.name=Installation Test', '-c', 'user.email=test@example.invalid', 'revert', '--no-edit', 'HEAD'], { cwd: remote });
    await execFileAsync('bash', [script], { env });
    assert.equal(fs.existsSync(path.join(runtime, 'sentinel')), false);
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), config);
    await execFileAsync(process.execPath, [path.join(runtime, 'src', 'cli.ts'), 'uninstall', '--codex-home', home]);
    assert.equal(fs.existsSync(runtime), false);
  });
});

// =============================================================================
// Suite 6 — Manifest v2, Sync, Self-Update, User-Edit Protection & Skill Scopes
// =============================================================================

function createUstarTarGz(
  entries: Array<{ name: string; content?: Buffer | string; type?: 'file' | 'dir' | 'symlink' | 'hardlink'; linkname?: string }>
): Buffer {
  const blocks: Buffer[] = [];
  const writeOctal = (buf: Buffer, offset: number, length: number, value: number) => {
    const str = value.toString(8).padStart(length - 1, '0') + '\0';
    buf.write(str, offset, length, 'ascii');
  };

  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    const isDir = entry.type === 'dir';
    const typeflag =
      entry.type === 'symlink'
        ? '2'
        : entry.type === 'hardlink'
          ? '1'
          : isDir
            ? '5'
            : '0';
    const data =
      typeflag === '0'
        ? Buffer.isBuffer(entry.content)
          ? entry.content
          : Buffer.from(entry.content ?? '', 'utf8')
        : Buffer.alloc(0);

    header.write(entry.name, 0, 100, 'utf8');
    writeOctal(header, 100, 8, isDir ? 0o755 : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header.fill(0x20, 148, 156); // checksum placeholder
    header.write(typeflag, 156, 1, 'ascii');
    if (entry.linkname) {
      header.write(entry.linkname, 157, 100, 'utf8');
    }
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');

    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header);

    if (data.length > 0) {
      blocks.push(data);
      const rem = data.length % 512;
      if (rem !== 0) {
        blocks.push(Buffer.alloc(512 - rem, 0));
      }
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function makeRuntimeCopy(dir: string, version?: string): string {
  fs.cpSync(REPO_ROOT, dir, {
    recursive: true,
    filter: (entry) => {
      const base = path.basename(entry);
      return !['.git', 'node_modules', 'README.html', 'README.html.comments.json'].includes(base) &&
        !base.endsWith('.comments.json');
    },
  });
  if (version) {
    const pkgPath = path.join(dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    pkg.version = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
  return dir;
}

describe('Suite 6 — Manifest v2, Sync, Self-Update, User-Edit Protection & Skill Scopes', () => {
  it('keeps repeated sync unchanged and restarts only for integration or runtime changes', async () => {
    const home = makeTempDir('noop-sync-home-');
    const source = makeRuntimeCopy(makeTempDir('noop-sync-source-'));
    const installed = await installForCodex({ sourceRoot: source, codexHome: home, copy: true, json: true });
    const manifestPath = path.join(home, 'codex-markup-install.json');
    const manifest = readInstallManifest(manifestPath);
    assert.ok(manifest?.schemaVersion === 2);
    manifest.installedAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const before = fs.readFileSync(manifestPath);

    for (let i = 0; i < 2; i++) {
      const synced = await syncCodexSetup({ codexHome: home, json: true });
      assert.equal(synced.status, 'up-to-date');
      assert.equal(synced.restartRequired, false);
      assert.deepEqual(synced.updatedFiles, []);
      assert.deepEqual(fs.readFileSync(manifestPath), before);
    }

    // Repairing metadata alone does not require reloading the integration.
    manifest.version = 'outdated metadata';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const metadataSync = await syncCodexSetup({ codexHome: home, json: true });
    assert.equal(metadataSync.status, 'synced');
    assert.deepEqual(metadataSync.updatedFiles, [manifestPath]);
    assert.equal(metadataSync.restartRequired, false);

    // A runtime change still needs a restart even when only the manifest is written.
    fs.appendFileSync(path.join(installed.installRoot, 'src', 'mcp.ts'), '\n// Runtime changed\n');
    const runtimeSync = await syncCodexSetup({ codexHome: home, json: true });
    assert.deepEqual(runtimeSync.updatedFiles, [manifestPath]);
    assert.equal(runtimeSync.restartRequired, true);
  });

  it('protects edited skill files removed upstream until force is requested', async () => {
    const home = makeTempDir('removed-edit-home-');
    const source = makeRuntimeCopy(makeTempDir('removed-edit-source-'));
    const sourceNotes = path.join(source, 'skills', 'inline-html-review', 'notes.txt');
    fs.writeFileSync(sourceNotes, 'original notes');
    const installed = await installForCodex({ sourceRoot: source, codexHome: home, copy: true, json: true });
    const diskNotes = path.join(home, 'skills', 'inline-html-review', 'notes.txt');
    fs.writeFileSync(diskNotes, 'user edited notes');
    fs.unlinkSync(sourceNotes);

    await assert.rejects(
      () => updateInstallation({ codexHome: home, from: source, json: true }),
      (err: unknown) => err instanceof UserCustomizationError && err.customizedFiles.includes(diskNotes)
    );
    assert.equal(fs.readFileSync(diskNotes, 'utf8'), 'user edited notes');

    fs.unlinkSync(path.join(installed.installRoot, 'skills', 'inline-html-review', 'notes.txt'));
    await assert.rejects(
      () => syncCodexSetup({ codexHome: home, json: true }),
      (err: unknown) => err instanceof UserCustomizationError && err.customizedFiles.includes(diskNotes)
    );
    assert.equal(fs.readFileSync(diskNotes, 'utf8'), 'user edited notes');
    await syncCodexSetup({ codexHome: home, force: true, json: true });
    assert.equal(fs.existsSync(diskNotes), false);
  });

  for (const entryPoint of ['update', 'install.sh']) {
    it(`isolates ${entryPoint} verification from CODEX_MARKUP_AGENTS_DIR`, async () => {
      const dir = makeTempDir('verify-agents-');
      const source = makeRuntimeCopy(path.join(dir, 'source'));
      const home = path.join(dir, 'home');
      const runtime = path.join(dir, 'runtime');
      const agentsDir = path.join(dir, 'agents');
      await installForCodex({ sourceRoot: source, codexHome: home, installDir: runtime, skillScope: 'agents', agentsDir, json: true });
      const skillPath = path.join(agentsDir, 'skills', 'inline-html-review', 'SKILL.md');
      const before = fs.readFileSync(skillPath);
      const pkgPath = path.join(source, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.version = '1.0.1';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      const env = {
        ...process.env,
        CODEX_HOME: home,
        CODEX_MARKUP_DIR: runtime,
        CODEX_MARKUP_AGENTS_DIR: agentsDir,
        CODEX_MARKUP_SOURCE_DIR: '',
        CODEX_MARKUP_REPO: source,
        CODEX_MARKUP_BRANCH: 'main',
        CODEX_REVIEW_PORT: '99999',
      };
      if (entryPoint === 'update') {
        await execFileAsync(process.execPath, ['--no-warnings', CLI_ENTRY, 'update', '--codex-home', home, '--from', source, '--json'], { env });
      } else {
        await execFileAsync('git', ['init', '-b', 'main', source]);
        await execFileAsync('git', ['add', '.'], { cwd: source });
        await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'release'], { cwd: source });
        await execFileAsync('bash', [path.join(REPO_ROOT, 'install.sh')], { env });
      }
      assert.deepEqual(fs.readFileSync(skillPath), before);
      assert.equal(readInstallManifest(path.join(home, 'codex-markup-install.json'))?.schemaVersion, 2);
      const doctor = await runDoctor({ codexHome: home, agentsDir, quiet: true });
      assert.equal(doctor.ok, true);
      assert.equal(doctor.needsSync, false);
      assert.equal(doctor.version, '1.0.1');
    });
  }

  it('reads dynamic package.json version in src/mcp.ts initialize handshake', async () => {
    const repoPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    assert.equal(readServerVersion(), repoPkg.version);

    const staged = makeRuntimeCopy(makeTempDir('mcp-dynamic-ver-'), '2.4.7-test');
    const child = spawn(
      process.execPath,
      ['--no-warnings', path.join(staged, 'src', 'cli.ts'), 'mcp'],
      {
        cwd: staged,
        env: { ...process.env, CODEX_REVIEW_PORT: '99999' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    try {
      const response = await new Promise<{ result?: { serverInfo?: { name: string; version: string } } }>(
        (resolve, reject) => {
          let buf = '';
          const timer = setTimeout(() => reject(new Error('MCP initialize timed out')), 5000);
          child.stdout.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            const nl = buf.indexOf('\n');
            if (nl !== -1) {
              clearTimeout(timer);
              resolve(JSON.parse(buf.slice(0, nl)) as { result?: { serverInfo?: { name: string; version: string } } });
            }
          });
          child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'version-test', version: '1.0.0' },
              },
            }) + '\n'
          );
        }
      );
      assert.deepEqual(response.result?.serverInfo, {
        name: 'codex-markup',
        version: '2.4.7-test',
      });
    } finally {
      child.stdin.end();
      child.kill('SIGTERM');
    }
  });

  it('writes Manifest v2, handles parseArgs flag ordering, and supports doctor/uninstall --json', async () => {
    const home = makeTempDir('manifest-v2-home-');
    const nonGitSource = makeRuntimeCopy(makeTempDir('non-git-src-'), '1.5.0');
    const installOut = await execFileAsync(
      process.execPath,
      ['--no-warnings', path.join(nonGitSource, 'src', 'cli.ts'), 'install', '--codex-home', home, '--copy', '--json'],
      { env: { ...process.env, CODEX_REVIEW_PORT: '99999' } }
    );
    const installJson = JSON.parse(installOut.stdout) as {
      status: string;
      version: string;
      managed: boolean;
      skillScope: string;
      runtimeSha256: string;
    };
    assert.equal(installJson.status, 'verified');
    assert.equal(installJson.version, '1.5.0');
    assert.equal(installJson.managed, true);
    assert.equal(installJson.skillScope, 'codex');

    const manifest = readInstallManifest(path.join(home, 'codex-markup-install.json'));
    assert.ok(manifest && manifest.schemaVersion === 2);
    assert.equal(manifest.version, '1.5.0');
    assert.equal(manifest.managed, true);
    assert.equal(manifest.sourceCommit, undefined);
    assert.equal(manifest.runtimeSha256, computeRuntimeSha256(path.join(home, 'tools', 'codex-markup')));
    assert.equal(manifest.artifacts.skillScope, 'codex');
    assert.equal(manifest.artifacts.skillDir, path.join(home, 'skills', 'inline-html-review'));
    assert.ok(manifest.artifacts.skillFiles['SKILL.md']);
    assert.ok(manifest.artifacts.agentsBlockSha256);
    assert.ok(manifest.artifacts.configMcpSha256);

    // parseArgs: boolean --json BEFORE subcommand, --flag=value, and -- delimiter
    const earlyJsonDoctor = await runCli(['--json', 'doctor', `--codex-home=${home}`]);
    const doctorPayload = JSON.parse(earlyJsonDoctor.stdout) as {
      ok: boolean;
      managed: boolean;
      needsSync: boolean;
      customizedFiles: string[];
      checks: Array<{ name: string; status: string }>;
    };
    assert.equal(doctorPayload.ok, true);
    assert.equal(doctorPayload.managed, true);
    assert.equal(doctorPayload.needsSync, false);
    assert.deepEqual(doctorPayload.customizedFiles, []);
    assert.equal(doctorPayload.checks.find((c) => c.name === 'sync-drift')?.status, 'pass');
    // Isolated --codex-home must never check real ~/.agents for duplicates
    assert.equal(doctorPayload.checks.some((c) => c.name === 'skill-duplicates'), false);

    // Context-sensitive --json payload on reply-batch and -- delimiter on add-comment
    const htmlDir = makeTempDir('cli-parse-html-');
    const htmlFile = makeTempHtml(htmlDir);
    await runCli(['add-comment', htmlFile, '--', '- leading dash comment']);
    const batchRes = await runCli([
      'reply-batch',
      htmlFile,
      '--json',
      JSON.stringify([{ id: 'c-1', reply: 'Handled dash comment', status: 'resolved' }]),
    ]);
    assert.match(batchRes.stdout, /Replied to 1 comment\(s\) in batch/);
    assert.equal(loadReviewState(htmlFile).threads[0].messages[0].text, '- leading dash comment');
    assert.equal(loadReviewState(htmlFile).threads[0].status, 'resolved');

    const uninstallOut = await runCli(['--json', 'uninstall', '--codex-home', home]);
    const uninstallJson = JSON.parse(uninstallOut.stdout) as {
      removedConfigSection: boolean;
      removedSkillDir: boolean;
      removedAgentsBlock: boolean;
      removedRuntimeDir: boolean;
    };
    assert.equal(uninstallJson.removedConfigSection, true);
    assert.equal(uninstallJson.removedSkillDir, true);
    assert.equal(uninstallJson.removedAgentsBlock, true);
    assert.equal(uninstallJson.removedRuntimeDir, true);
  });

  it('syncs recursive skill assets, prunes obsolete files, and preserves managed=false after git pull', async () => {
    const srcDir = makeRuntimeCopy(makeTempDir('sync-src-'));
    const copyDst = makeTempDir('sync-copy-dst-');
    fs.writeFileSync(path.join(srcDir, 'src', 'obsolete.ts'), 'export const old = 1;\n');
    fs.writeFileSync(path.join(srcDir, 'bin', 'obsolete.js'), 'console.log(1);\n');
    fs.writeFileSync(path.join(srcDir, 'skills', 'inline-html-review', 'obsolete-skill.md'), 'old\n');
    fs.mkdirSync(path.join(srcDir, 'skills', 'inline-html-review', 'references'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'skills', 'inline-html-review', 'references', 'guide.md'), '# Guide v1\n');

    copyRuntimeToDir(srcDir, copyDst);
    assert.equal(fs.existsSync(path.join(copyDst, 'src', 'obsolete.ts')), true);
    assert.equal(fs.existsSync(path.join(copyDst, 'skills', 'inline-html-review', 'references', 'guide.md')), true);

    fs.unlinkSync(path.join(srcDir, 'src', 'obsolete.ts'));
    fs.unlinkSync(path.join(srcDir, 'bin', 'obsolete.js'));
    fs.unlinkSync(path.join(srcDir, 'skills', 'inline-html-review', 'obsolete-skill.md'));
    copyRuntimeToDir(srcDir, copyDst);
    assert.equal(fs.existsSync(path.join(copyDst, 'src', 'obsolete.ts')), false);
    assert.equal(fs.existsSync(path.join(copyDst, 'bin', 'obsolete.js')), false);
    assert.equal(fs.existsSync(path.join(copyDst, 'skills', 'inline-html-review', 'obsolete-skill.md')), false);

    // Contributor checkout (managed: false) initialized as git repo
    const home = makeTempDir('sync-contrib-home-');
    await execFileAsync('git', ['init', '-b', 'main', srcDir]);
    await execFileAsync('git', ['add', '.'], { cwd: srcDir });
    await execFileAsync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'v1'],
      { cwd: srcDir }
    );
    const commit1 = (await execFileAsync('git', ['-C', srcDir, 'rev-parse', 'HEAD'])).stdout.trim();

    await installForCodex({ sourceRoot: srcDir, codexHome: home, installDir: srcDir, json: true });
    const manifest1 = readInstallManifest(path.join(home, 'codex-markup-install.json'));
    assert.ok(manifest1 && manifest1.schemaVersion === 2);
    assert.equal(manifest1.managed, false);
    assert.equal(manifest1.sourceCommit, commit1);
    assert.equal(
      fs.readFileSync(path.join(home, 'skills', 'inline-html-review', 'references', 'guide.md'), 'utf8'),
      '# Guide v1\n'
    );

    // Simulate git pull updating SKILL.md, pruning references/guide.md, adding assets/icon.txt
    fs.rmSync(path.join(srcDir, 'skills', 'inline-html-review', 'references'), { recursive: true, force: true });
    fs.mkdirSync(path.join(srcDir, 'skills', 'inline-html-review', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'skills', 'inline-html-review', 'assets', 'icon.txt'), 'icon\n');
    const skillTplPath = path.join(srcDir, 'skills', 'inline-html-review', 'SKILL.md');
    fs.writeFileSync(skillTplPath, fs.readFileSync(skillTplPath, 'utf8') + '\n<!-- pulled update -->\n');
    await execFileAsync('git', ['add', '.'], { cwd: srcDir });
    await execFileAsync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'v2'],
      { cwd: srcDir }
    );
    const commit2 = (await execFileAsync('git', ['-C', srcDir, 'rev-parse', 'HEAD'])).stdout.trim();

    const doctorDrift = await runDoctor({ codexHome: home, quiet: true });
    assert.equal(doctorDrift.ok, true);
    assert.equal(doctorDrift.needsSync, true);
    assert.equal(doctorDrift.checks.find((c) => c.name === 'sync-drift')?.status, 'warn');

    const syncOut = await runCli(['sync', '--codex-home', home, '--json']);
    const syncJson = JSON.parse(syncOut.stdout) as {
      status: string;
      managed: boolean;
      needsSync: boolean;
      restartRequired: boolean;
    };
    assert.equal(syncJson.status, 'synced');
    assert.equal(syncJson.managed, false);
    assert.equal(syncJson.needsSync, false);
    assert.equal(syncJson.restartRequired, true);

    assert.equal(fs.existsSync(path.join(home, 'skills', 'inline-html-review', 'references', 'guide.md')), false);
    assert.equal(
      fs.readFileSync(path.join(home, 'skills', 'inline-html-review', 'assets', 'icon.txt'), 'utf8'),
      'icon\n'
    );
    const manifest2 = readInstallManifest(path.join(home, 'codex-markup-install.json'));
    assert.ok(manifest2 && manifest2.schemaVersion === 2);
    assert.equal(manifest2.managed, false);
    assert.equal(manifest2.sourceCommit, commit2);

    const doctorClean = await runDoctor({ codexHome: home, quiet: true });
    assert.equal(doctorClean.needsSync, false);
    assert.equal(doctorClean.checks.find((c) => c.name === 'sync-drift')?.status, 'pass');

    // Sync also preserves managed: true on managed installs
    const managedHome = makeTempDir('sync-managed-home-');
    await installForCodex({ sourceRoot: srcDir, codexHome: managedHome, copy: true, json: true });
    fs.unlinkSync(path.join(managedHome, 'skills', 'inline-html-review', 'assets', 'icon.txt'));
    const managedSync = await syncCodexSetup({ codexHome: managedHome, json: true });
    assert.equal(managedSync.managed, true);
    assert.equal(managedSync.status, 'synced');
    assert.equal(fs.existsSync(path.join(managedHome, 'skills', 'inline-html-review', 'assets', 'icon.txt')), true);
  });

  it('protects local edits in SKILL.md and AGENTS.md unless --force (CLI + install.sh)', async () => {
    const home = makeTempDir('user-edit-home-');
    const skillPath = path.join(home, 'skills', 'inline-html-review', 'SKILL.md');
    const agentsPath = path.join(home, 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# Personal Rules\nAlways preserve me.\n', 'utf8');

    await installForCodex({ sourceRoot: REPO_ROOT, codexHome: home, copy: true, json: true });

    // Edit SKILL.md locally
    fs.appendFileSync(skillPath, '\n<!-- local user customization -->\n');
    const doctorCustomized = await runDoctor({ codexHome: home, quiet: true });
    assert.equal(doctorCustomized.ok, true);
    assert.equal(doctorCustomized.checks.find((c) => c.name === 'sync-drift')?.status, 'warn');
    assert.ok((doctorCustomized.customizedFiles || []).some((f) => f.endsWith('SKILL.md')));

    await assert.rejects(
      () => installForCodex({ sourceRoot: REPO_ROOT, codexHome: home, copy: true, json: true }),
      (err: unknown) => err instanceof UserCustomizationError && err.customizedFiles.some((f) => f.endsWith('SKILL.md'))
    );
    await assert.rejects(
      () => syncCodexSetup({ codexHome: home, json: true }),
      (err: unknown) => err instanceof UserCustomizationError
    );
    const v2Dir = makeRuntimeCopy(makeTempDir('user-edit-v2-'), '1.1.0');
    await assert.rejects(
      () => updateInstallation({ codexHome: home, from: v2Dir, json: true }),
      (err: unknown) => err instanceof UserCustomizationError
    );
    // Original customized file and version stayed intact
    assert.match(fs.readFileSync(skillPath, 'utf8'), /local user customization/);
    assert.equal(readInstallManifest(path.join(home, 'codex-markup-install.json'))?.schemaVersion, 2);

    // Sync with --force overwrites SKILL.md
    await syncCodexSetup({ codexHome: home, force: true, json: true });
    assert.equal(fs.readFileSync(skillPath, 'utf8').includes('local user customization'), false);

    // Edit inside AGENTS.md marker block
    const agentsBefore = fs.readFileSync(agentsPath, 'utf8');
    fs.writeFileSync(
      agentsPath,
      agentsBefore.replace('<!-- END CODEX-INLINE-REVIEW -->', 'User custom step.\n<!-- END CODEX-INLINE-REVIEW -->'),
      'utf8'
    );
    await assert.rejects(
      () => syncCodexSetup({ codexHome: home, json: true }),
      (err: unknown) => err instanceof UserCustomizationError && err.customizedFiles.some((f) => f.endsWith('AGENTS.md'))
    );
    await syncCodexSetup({ codexHome: home, force: true, json: true });
    const agentsAfterForce = fs.readFileSync(agentsPath, 'utf8');
    assert.match(agentsAfterForce, /# Personal Rules/);
    assert.equal(agentsAfterForce.includes('User custom step.'), false);

    // install.sh refuses without --force (rolling back cleanly) and succeeds with --force or CODEX_MARKUP_FORCE=1
    const dir = makeTempDir('sh-force-');
    const remote = makeRuntimeCopy(path.join(dir, 'remote'));
    await execFileAsync('git', ['init', '-b', 'main', remote]);
    await execFileAsync('git', ['add', '.'], { cwd: remote });
    await execFileAsync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'init'],
      { cwd: remote }
    );
    const shHome = path.join(dir, 'home');
    const shRuntime = path.join(dir, 'runtime');
    const script = path.join(REPO_ROOT, 'install.sh');
    const shEnv = {
      ...process.env,
      CODEX_HOME: shHome,
      CODEX_MARKUP_DIR: shRuntime,
      CODEX_MARKUP_SOURCE_DIR: '',
      CODEX_MARKUP_REPO: remote,
      CODEX_REVIEW_PORT: '99999',
    };
    await execFileAsync('bash', [script], { env: shEnv });
    fs.writeFileSync(path.join(shRuntime, 'sentinel'), 'keep-on-reject');
    const shSkill = path.join(shHome, 'skills', 'inline-html-review', 'SKILL.md');
    fs.appendFileSync(shSkill, '\n<!-- user shell edit -->\n');

    await assert.rejects(() => execFileAsync('bash', [script], { env: shEnv }));
    assert.equal(fs.readFileSync(path.join(shRuntime, 'sentinel'), 'utf8'), 'keep-on-reject');
    assert.match(fs.readFileSync(shSkill, 'utf8'), /user shell edit/);

    await execFileAsync('bash', [script, '--force'], { env: shEnv });
    assert.equal(fs.existsSync(path.join(shRuntime, 'sentinel')), false);
    assert.equal(fs.readFileSync(shSkill, 'utf8').includes('user shell edit'), false);

    fs.appendFileSync(shSkill, '\n<!-- user env edit -->\n');
    await execFileAsync('bash', [script], { env: { ...shEnv, CODEX_MARKUP_FORCE: '1' } });
    assert.equal(fs.readFileSync(shSkill, 'utf8').includes('user env edit'), false);
  });

  it('supports opt-in --skill-scope agents with --agents-dir isolation, duplicate warning, and scope switching', async () => {
    const home = makeTempDir('scope-home-');
    const agentsDir = makeTempDir('scope-agents-');
    const codexSkillDir = path.join(home, 'skills', 'inline-html-review');
    const agentsSkillDir = path.join(agentsDir, 'skills', 'inline-html-review');

    const res = await installForCodex({
      sourceRoot: REPO_ROOT,
      codexHome: home,
      copy: true,
      skillScope: 'agents',
      agentsDir,
      json: true,
    });
    assert.equal(res.skillScope, 'agents');
    assert.equal(res.skillDir, agentsSkillDir);
    assert.equal(fs.existsSync(path.join(agentsSkillDir, 'SKILL.md')), true);
    assert.equal(fs.existsSync(codexSkillDir), false);

    const docClean = await runDoctor({ codexHome: home, quiet: true });
    assert.equal(docClean.ok, true);
    assert.equal(docClean.skillScope, 'agents');
    assert.equal(docClean.checks.find((c) => c.name === 'skill-file')?.status, 'pass');
    assert.equal(docClean.checks.find((c) => c.name === 'skill-duplicates')?.status, 'pass');

    // Duplicate warning when both codex and agents skill directories exist
    fs.mkdirSync(codexSkillDir, { recursive: true });
    fs.writeFileSync(path.join(codexSkillDir, 'SKILL.md'), 'duplicate\n', 'utf8');
    const docDup = await runDoctor({ codexHome: home, quiet: true });
    assert.equal(docDup.ok, true);
    assert.equal(docDup.checks.find((c) => c.name === 'skill-duplicates')?.status, 'warn');

    // Switch back to codex scope (with --force because manual duplicate existed in codexSkillDir)
    await installForCodex({
      sourceRoot: REPO_ROOT,
      codexHome: home,
      copy: true,
      skillScope: 'codex',
      force: true,
      json: true,
    });
    assert.equal(fs.existsSync(path.join(codexSkillDir, 'SKILL.md')), true);
    assert.equal(fs.existsSync(agentsSkillDir), false);
    // Parent dirs remain intact
    assert.equal(fs.existsSync(path.join(agentsDir, 'skills')), true);

    // Switch back to agents scope and verify codexSkillDir is cleaned up + uninstall cleans agentsSkillDir
    await installForCodex({
      sourceRoot: REPO_ROOT,
      codexHome: home,
      copy: true,
      skillScope: 'agents',
      agentsDir,
      json: true,
    });
    assert.equal(fs.existsSync(codexSkillDir), false);
    assert.equal(fs.existsSync(path.join(agentsSkillDir, 'SKILL.md')), true);

    const uninst = uninstallFromCodex({ codexHome: home, json: true });
    assert.equal(uninst.removedSkillDir, true);
    assert.equal(fs.existsSync(agentsSkillDir), false);
    assert.equal(fs.existsSync(path.join(agentsDir, 'skills')), true);
  });

  it('executes offline update --check/apply, tarball validation, HTTP ETag 304->200, rollbacks, and legacy/v1 compat', async () => {
    const dir = makeTempDir('update-e2e-');
    const remote = makeRuntimeCopy(path.join(dir, 'remote'), '1.0.0');
    await execFileAsync('git', ['init', '-b', 'main', remote]);
    await execFileAsync('git', ['add', '.'], { cwd: remote });
    await execFileAsync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'v1.0.0'],
      { cwd: remote }
    );
    const c1 = (await execFileAsync('git', ['-C', remote, 'rev-parse', 'HEAD'])).stdout.trim();

    const home = path.join(dir, 'home');
    const runtime = path.join(dir, 'runtime');
    await execFileAsync('bash', [path.join(REPO_ROOT, 'install.sh')], {
      env: {
        ...process.env,
        CODEX_HOME: home,
        CODEX_MARKUP_DIR: runtime,
        CODEX_MARKUP_SOURCE_DIR: '',
        CODEX_MARKUP_REPO: remote,
        CODEX_REVIEW_PORT: '99999',
      },
    });

    // 1. Git check up-to-date -> commit v1.1.0 -> check update-available -> apply
    const check1 = await runCli(['update', '--check', '--codex-home', home, '--json']);
    const check1Json = JSON.parse(check1.stdout) as { status: string; updateAvailable: boolean };
    assert.equal(check1Json.status, 'up-to-date');
    assert.equal(check1Json.updateAvailable, false);

    const pkgPath = path.join(remote, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    pkg.version = '1.1.0';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: remote });
    await execFileAsync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'v1.1.0'],
      { cwd: remote }
    );
    const c2 = (await execFileAsync('git', ['-C', remote, 'rev-parse', 'HEAD'])).stdout.trim();

    const check2 = await runCli(['update', '--check', '--codex-home', home, '--json']);
    const check2Json = JSON.parse(check2.stdout) as {
      status: string;
      updateAvailable: boolean;
      remoteCommit: string;
    };
    assert.equal(check2Json.status, 'update-available');
    assert.equal(check2Json.updateAvailable, true);
    assert.equal(check2Json.remoteCommit, c2);

    const applyGit = await runCli(['update', '--codex-home', home, '--json']);
    const applyGitJson = JSON.parse(applyGit.stdout) as {
      status: string;
      previousVersion: string;
      version: string;
      previousCommit: string;
      sourceCommit: string;
    };
    assert.equal(applyGitJson.status, 'updated');
    assert.equal(applyGitJson.previousVersion, '1.0.0');
    assert.equal(applyGitJson.version, '1.1.0');
    assert.equal(applyGitJson.previousCommit, c1);
    assert.equal(applyGitJson.sourceCommit, c2);

    // 2. --from <dir> (non-git) clears stale sourceCommit
    const v2Dir = makeRuntimeCopy(path.join(dir, 'v2-dir'), '1.2.0');
    const applyDir = await updateInstallation({ codexHome: home, from: v2Dir, json: true });
    assert.equal(applyDir.mode, 'apply');
    assert.equal(applyDir.status, 'updated');
    assert.equal(applyDir.version, '1.2.0');
    const afterDirManifest = readInstallManifest(path.join(home, 'codex-markup-install.json'));
    assert.ok(afterDirManifest && afterDirManifest.schemaVersion === 2);
    assert.equal(afterDirManifest.sourceCommit, undefined);

    // 3. --from <tgz> local archive
    const v3Dir = makeRuntimeCopy(path.join(dir, 'v3-dir'), '1.3.0');
    const v3Tgz = path.join(dir, 'v3.tgz');
    await execFileAsync('tar', ['-czf', v3Tgz, '-C', dir, 'v3-dir']);
    const applyTgz = await updateInstallation({ codexHome: home, from: v3Tgz, json: true });
    assert.equal(applyTgz.mode, 'apply');
    assert.equal(applyTgz.version, '1.3.0');

    // 4. Reject malicious .tgz archives (traversal, leading /, backslash, drive prefix, symlink, hardlink)
    const maliciousArchives: Array<[string, Buffer]> = [
      ['traversal', createUstarTarGz([{ name: 'pkg/../escape.txt', content: 'x' }])],
      ['abs-path', createUstarTarGz([{ name: '/etc/evil', content: 'x' }])],
      ['backslash', createUstarTarGz([{ name: 'pkg\\evil.txt', content: 'x' }])],
      ['drive-prefix', createUstarTarGz([{ name: 'C:evil.txt', content: 'x' }])],
      ['symlink', createUstarTarGz([{ name: 'pkg/sym', type: 'symlink', linkname: '/etc/passwd' }])],
      ['hardlink', createUstarTarGz([{ name: 'pkg/a.txt', content: 'hi' }, { name: 'pkg/hard', type: 'hardlink', linkname: 'pkg/a.txt' }])],
    ];
    for (const [label, buf] of maliciousArchives) {
      const badTgz = path.join(dir, `bad-${label}.tgz`);
      fs.writeFileSync(badTgz, buf);
      await assert.rejects(
        () => updateInstallation({ codexHome: home, from: badTgz, json: true }),
        (err: unknown) => err instanceof Error && /Refusing tarball/i.test(err.message),
        `Expected ${label} tarball to be rejected`
      );
    }

    // 5. Loopback HTTP HEAD If-None-Match 304 -> 200 ETag update
    const v4Dir = makeRuntimeCopy(path.join(dir, 'v4-dir'), '1.4.0');
    const v4Tgz = path.join(dir, 'v4.tgz');
    await execFileAsync('tar', ['-czf', v4Tgz, '-C', dir, 'v4-dir']);

    let currentEtag = '"v3-etag"';
    let currentTgzBytes = fs.readFileSync(v3Tgz);
    const seenMethods: string[] = [];
    const seenIfNoneMatch: Array<string | null> = [];
    const handleHttpReq = (method: string, ifNoneMatch: string | null) => {
      seenMethods.push(method);
      seenIfNoneMatch.push(ifNoneMatch);
      if (ifNoneMatch === currentEtag) {
        return { status: 304, headers: { ETag: currentEtag }, body: Buffer.alloc(0) };
      }
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/gzip',
          ETag: currentEtag,
          'Content-Length': String(currentTgzBytes.byteLength),
        },
        body: method === 'HEAD' ? Buffer.alloc(0) : currentTgzBytes,
      };
    };

    const httpServer = http.createServer((req, res) => {
      const reply = handleHttpReq(
        req.method || 'GET',
        typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : null
      );
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    });

    let restoreFetch: (() => void) | undefined;
    let tarballUrl = 'http://127.0.0.1:49999/release.tgz';
    let serverListening = false;
    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => {
          serverListening = true;
          resolve();
        });
      });
      const addr = httpServer.address();
      assert.ok(addr && typeof addr === 'object');
      tarballUrl = `http://127.0.0.1:${addr.port}/release.tgz`;
      // Probe whether loopback fetch is permitted in this runtime/sandbox
      await fetch(tarballUrl, { method: 'HEAD' });
      seenMethods.length = 0;
      seenIfNoneMatch.length = 0;
    } catch (probeErr: unknown) {
      const code =
        (probeErr as { code?: string; cause?: { code?: string } })?.cause?.code ??
        (probeErr as { code?: string })?.code;
      if (code !== 'EPERM') throw probeErr;
      // Sandbox denies TCP loopback sockets; route fetch through the same handler in-process.
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (urlStr !== tarballUrl) {
          return realFetch(input, init);
        }
        const headers = new Headers(init?.headers);
        const reply = handleHttpReq(init?.method || 'GET', headers.get('If-None-Match'));
        return new Response(
          reply.status === 304 || init?.method === 'HEAD' ? null : new Uint8Array(reply.body),
          {
            status: reply.status,
            headers: reply.headers,
          }
        );
      }) as typeof fetch;
      restoreFetch = () => {
        globalThis.fetch = realFetch;
      };
    }

    try {
      const firstHttpUpdate = await updateInstallation({ codexHome: home, tarballUrl, json: true });
      assert.equal(firstHttpUpdate.mode, 'apply');
      assert.equal(firstHttpUpdate.version, '1.3.0');

      // Now update --check uses saved tarballUrl + If-None-Match -> 304 up-to-date
      const httpCheck304 = await updateInstallation({ codexHome: home, check: true, json: true });
      assert.equal(httpCheck304.mode, 'check');
      assert.equal(httpCheck304.status, 'up-to-date');
      assert.equal(httpCheck304.updateAvailable, false);
      assert.equal(seenMethods.at(-1), 'HEAD');
      assert.equal(seenIfNoneMatch.at(-1), '"v3-etag"');

      // Flip server ETag and tarball bytes to 1.4.0
      currentEtag = '"v4-etag"';
      currentTgzBytes = fs.readFileSync(v4Tgz);
      const httpCheck200 = await updateInstallation({ codexHome: home, check: true, json: true });
      assert.equal(httpCheck200.mode, 'check');
      assert.equal(httpCheck200.status, 'update-available');
      assert.equal(httpCheck200.remoteEtag, '"v4-etag"');
      assert.equal(seenMethods.at(-1), 'HEAD');
      assert.equal(seenIfNoneMatch.at(-1), '"v3-etag"');

      const secondHttpUpdate = await updateInstallation({ codexHome: home, json: true });
      assert.equal(secondHttpUpdate.mode, 'apply');
      assert.equal(secondHttpUpdate.version, '1.4.0');
    } finally {
      restoreFetch?.();
      if (serverListening) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    }

    // 6. Rollback on broken cli.ts during verify-home & post-swap registration failure
    const configSnapshot = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    fs.writeFileSync(path.join(runtime, 'sentinel'), 'preserve-me');

    const brokenVerifyDir = makeRuntimeCopy(path.join(dir, 'broken-verify'), '1.5.0');
    fs.writeFileSync(path.join(brokenVerifyDir, 'src', 'cli.ts'), 'throw new Error("broken release");\n');
    await assert.rejects(() => updateInstallation({ codexHome: home, from: brokenVerifyDir, json: true }));
    assert.equal(fs.readFileSync(path.join(runtime, 'sentinel'), 'utf8'), 'preserve-me');
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), configSnapshot);

    const brokenRegDir = makeRuntimeCopy(path.join(dir, 'broken-reg'), '1.6.0');
    const origCli = fs.readFileSync(path.join(brokenRegDir, 'src', 'cli.ts'), 'utf8');
    fs.writeFileSync(
      path.join(brokenRegDir, 'src', 'cli.ts'),
      `import failFs from 'node:fs'; if (process.argv.includes(${JSON.stringify(home)})) { failFs.writeFileSync(${JSON.stringify(path.join(home, 'config.toml'))}, 'CORRUPTED_CONFIG'); process.exit(1); }\n` +
        origCli
    );
    await assert.rejects(() => updateInstallation({ codexHome: home, from: brokenRegDir, json: true }));
    assert.equal(fs.readFileSync(path.join(runtime, 'sentinel'), 'utf8'), 'preserve-me');
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), configSnapshot);
    const postRollbackDoc = await runDoctor({ codexHome: home, quiet: true });
    assert.equal(postRollbackDoc.ok, true);

    // 7. Contributor managed=false refusal
    const contribHome = makeTempDir('contrib-refuse-home-');
    const contribCheckout = makeRuntimeCopy(makeTempDir('contrib-refuse-src-'));
    await installForCodex({ sourceRoot: contribCheckout, installDir: contribCheckout, codexHome: contribHome, json: true });
    assert.equal(readInstallManifest(path.join(contribHome, 'codex-markup-install.json'))?.managed, false);
    await assert.rejects(
      () => updateInstallation({ codexHome: contribHome, from: v4Dir, json: true }),
      (err: unknown) => err instanceof Error && /unmanaged checkout/i.test(err.message)
    );

    // 8. Forged manifest rejection (no .codex-markup-owned.json inside unowned dir)
    const forgedHome = makeTempDir('forged-update-home-');
    const unownedRuntime = makeRuntimeCopy(makeTempDir('unowned-runtime-'));
    fs.writeFileSync(
      path.join(forgedHome, 'codex-markup-install.json'),
      JSON.stringify({ runtimeRoot: unownedRuntime, codexHome: forgedHome, managed: true })
    );
    await assert.rejects(
      () => updateInstallation({ codexHome: forgedHome, from: v4Dir, json: true }),
      (err: unknown) => err instanceof Error && /unowned runtime directory/i.test(err.message)
    );

    // 9. v1 & legacy pre-manifest compatibility
    const v1Home = makeTempDir('v1-compat-home-');
    await installForCodex({ sourceRoot: REPO_ROOT, codexHome: v1Home, copy: true, json: true });
    fs.writeFileSync(
      path.join(v1Home, 'codex-markup-install.json'),
      JSON.stringify({
        runtimeRoot: path.join(v1Home, 'tools', 'codex-markup'),
        codexHome: v1Home,
        managed: true,
      })
    );
    const v1Doc = await runDoctor({ codexHome: v1Home, quiet: true });
    assert.equal(v1Doc.ok, true);
    assert.equal(v1Doc.checks.find((c) => c.name === 'sync-drift')?.status, 'warn');
    await updateInstallation({ codexHome: v1Home, from: v4Dir, json: true });
    assert.equal(readInstallManifest(path.join(v1Home, 'codex-markup-install.json'))?.schemaVersion, 2);

    // Legacy pre-manifest (no manifest file & no .codex-markup-owned.json)
    const legacyHome = makeTempDir('legacy-compat-home-');
    await installForCodex({ sourceRoot: REPO_ROOT, codexHome: legacyHome, copy: true, json: true });
    fs.unlinkSync(path.join(legacyHome, 'codex-markup-install.json'));
    fs.unlinkSync(path.join(legacyHome, 'tools', 'codex-markup', '.codex-markup-owned.json'));
    const legacyDoc = await runDoctor({ codexHome: legacyHome, quiet: true });
    assert.equal(legacyDoc.ok, true);
    assert.equal(legacyDoc.checks.find((c) => c.name === 'sync-drift')?.status, 'warn');
    const legacySync = await syncCodexSetup({ codexHome: legacyHome, json: true });
    assert.equal(legacySync.managed, true);
    assert.equal(readInstallManifest(path.join(legacyHome, 'codex-markup-install.json'))?.schemaVersion, 2);
  });
});
