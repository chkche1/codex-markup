import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import {
  loadReviewState,
  createThread,
  addReply,
  addRepliesBatch,
  updateThreadStatus,
  deleteThread,
  markSubmitted,
  formatReviewForCodex,
  getSidecarPath,
  type BatchReplyInput,
  type CommentTarget,
  type CommentStatus,
  type MessageAuthor,
  type ReviewDocumentState,
} from './store.ts';
import { getWidgetScript } from './widget.ts';

export const DEFAULT_PORT = Number(process.env.CODEX_REVIEW_PORT || 4321);
export type CodexSandboxMode = 'workspace-write' | 'full-access';
export type SandboxControlSource =
  | 'background-codex'
  | 'connected-session'
  | 'externally-sandboxed'
  | 'policy-restricted';

export interface SandboxCapabilities {
  configuredMode: CodexSandboxMode;
  effectiveMode: CodexSandboxMode | 'session-controlled' | 'externally-sandboxed';
  controlSource: SandboxControlSource;
  canToggle: boolean;
  label: string;
  reason: string;
  hint?: string;
  workspaceRoot?: string;
  externalSandboxSignal?: string;
  restartCommand?: string;
}

export interface ModelOption {
  slug: string;
  displayName: string;
  description?: string;
}

export interface ModelCapabilities {
  configuredModel: string | null;
  effectiveModel: string | null;
  defaultConfigModel?: string;
  controlSource: 'background-codex' | 'connected-session';
  canSelect: boolean;
  label: string;
  reason: string;
  hint?: string;
  availableModels: ModelOption[];
}

export interface InlineReviewServerOptions {
  env?: NodeJS.ProcessEnv;
  requirementsPath?: string;
  model?: string | null;
  availableModels?: ModelOption[];
  skipModelDiscovery?: boolean;
}

export function normalizeModelSelection(model?: string | null): string | null {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === 'default' || lower === 'auto') {
    return null;
  }
  return trimmed;
}

export function resolveDefaultModel(
  model?: string | null,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (model !== undefined) {
    return normalizeModelSelection(model);
  }
  return normalizeModelSelection(env.CODEX_MARKUP_MODEL);
}

export function readCodexConfigDefaultModel(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  try {
    const codexHome = env.CODEX_HOME
      ? path.resolve(env.CODEX_HOME)
      : path.join(os.homedir(), '.codex');
    const configPath = path.join(codexHome, 'config.toml');
    if (!fs.existsSync(configPath)) return undefined;
    const raw = fs.readFileSync(configPath, 'utf8');
    const stripped = raw.replace(/#.*$/gm, '');
    const topSectionIdx = stripped.search(/^\s*\[/m);
    const topLevel = topSectionIdx === -1 ? stripped : stripped.slice(0, topSectionIdx);
    const match = topLevel.match(/^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/m);
    const val = match ? (match[1] || match[2] || '').trim() : '';
    return val || undefined;
  } catch {
    return undefined;
  }
}

export function parseCodexModelsCatalog(rawJson: string): ModelOption[] {
  try {
    const parsed = JSON.parse(rawJson) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        description?: string;
        visibility?: string;
        priority?: number;
      }>;
    };
    if (!parsed || !Array.isArray(parsed.models)) return [];
    return parsed.models
      .filter((m) => m && typeof m.slug === 'string' && m.visibility === 'list')
      .sort(
        (a, b) =>
          (typeof a.priority === 'number' ? a.priority : 999) -
          (typeof b.priority === 'number' ? b.priority : 999)
      )
      .map((m) => ({
        slug: String(m.slug),
        displayName: String(m.display_name || m.slug),
        ...(m.description ? { description: String(m.description) } : {}),
      }));
  } catch {
    return [];
  }
}

function findCodexBin(env: NodeJS.ProcessEnv): string {
  const candidateCodexBins = [
    env.CODEX_CLI_PATH,
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ].filter((p): p is string => Boolean(p));

  return candidateCodexBins.find((p) => fs.existsSync(p)) || 'codex';
}

export function readCodexModelsCache(env: NodeJS.ProcessEnv = process.env): ModelOption[] {
  try {
    const codexHome = env.CODEX_HOME
      ? path.resolve(env.CODEX_HOME)
      : path.join(os.homedir(), '.codex');
    const cachePath = path.join(codexHome, 'models_cache.json');
    if (!fs.existsSync(cachePath)) return [];
    const raw = fs.readFileSync(cachePath, 'utf8');
    return parseCodexModelsCatalog(raw);
  } catch {
    return [];
  }
}

function execModelsCatalog(codexBin: string, runEnv: NodeJS.ProcessEnv): Promise<ModelOption[]> {
  return new Promise((resolve) => {
    execFile(
      codexBin,
      ['debug', 'models'],
      { env: runEnv, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        resolve(parseCodexModelsCatalog(stdout));
      }
    );
  });
}

export async function loadAvailableModels(
  codexBin: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ModelOption[]> {
  const direct = await execModelsCatalog(codexBin, env);
  if (direct.length > 0) {
    return direct;
  }

  let tmpCodexHome: string | undefined;
  try {
    tmpCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-'));
    return await execModelsCatalog(codexBin, {
      ...env,
      CODEX_HOME: tmpCodexHome,
    });
  } catch {
    return [];
  } finally {
    if (tmpCodexHome) {
      try {
        fs.rmSync(tmpCodexHome, { recursive: true, force: true });
      } catch {
        // Ignore temp dir cleanup errors
      }
    }
  }
}

export function detectExternalSandbox(
  env: NodeJS.ProcessEnv = process.env
): { sandboxed: boolean; signal?: string } {
  const codexSandbox = (env.CODEX_SANDBOX || '').trim();
  if (
    codexSandbox &&
    !['none', 'off', '0', 'false', 'danger-full-access'].includes(codexSandbox.toLowerCase())
  ) {
    return { sandboxed: true, signal: `CODEX_SANDBOX=${codexSandbox}` };
  }

  const netDisabled = (env.CODEX_SANDBOX_NETWORK_DISABLED || '').trim();
  if (netDisabled === '1' || netDisabled.toLowerCase() === 'true') {
    return { sandboxed: true, signal: `CODEX_SANDBOX_NETWORK_DISABLED=${netDisabled}` };
  }

  const extSandbox = (env.CODEX_MARKUP_EXTERNAL_SANDBOX || '').trim();
  if (extSandbox === '1' || extSandbox.toLowerCase() === 'true') {
    return { sandboxed: true, signal: `CODEX_MARKUP_EXTERNAL_SANDBOX=${extSandbox}` };
  }

  const seatbeltProfile = (env.SEATBELT_PROFILE || '').trim();
  if (seatbeltProfile) {
    return { sandboxed: true, signal: 'SEATBELT_PROFILE' };
  }

  return { sandboxed: false };
}

export function detectPolicyFullAccessBlocked(
  requirementsPath?: string,
  env: NodeJS.ProcessEnv = process.env
): { blocked: boolean; path?: string } {
  const reqPath = requirementsPath ?? env.CODEX_REQUIREMENTS_PATH ?? '/etc/codex/requirements.toml';
  try {
    if (!fs.existsSync(reqPath)) {
      return { blocked: false };
    }
    const raw = fs.readFileSync(reqPath, 'utf8');
    const stripped = raw.replace(/#.*$/gm, '');
    const match = stripped.match(/allowed_sandbox_modes\s*=\s*\[([\s\S]*?)\]/);
    if (match && !/['"]danger-full-access['"]/.test(match[1])) {
      return { blocked: true, path: reqPath };
    }
  } catch {
    return { blocked: false };
  }
  return { blocked: false };
}

export function resolveWorkspaceRoot(filePath: string): string {
  const startDir = path.dirname(path.resolve(filePath));
  const homeDir = path.resolve(os.homedir());
  let cur = startDir;
  while (true) {
    if (cur === homeDir && startDir !== homeDir) {
      return startDir;
    }
    if (fs.existsSync(path.join(cur, '.git'))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return startDir;
    }
    cur = parent;
  }
}

export function resolveDefaultSandboxMode(
  mode?: string,
  env: NodeJS.ProcessEnv = process.env,
  requirementsPath?: string
): CodexSandboxMode {
  const raw = (mode ?? env.CODEX_MARKUP_SANDBOX ?? '').trim().toLowerCase();
  if (raw === 'workspace-write' || raw === 'sandboxed' || raw === 'read-only') {
    return 'workspace-write';
  }
  if (raw === 'full-access' || raw === 'danger-full-access') {
    return 'full-access';
  }
  if (
    detectExternalSandbox(env).sandboxed ||
    detectPolicyFullAccessBlocked(requirementsPath, env).blocked
  ) {
    return 'workspace-write';
  }
  return 'full-access';
}

export function buildBackgroundCodexInvocation(opts: {
  filePath: string;
  reviewReport: string;
  sandboxMode: CodexSandboxMode;
  nodeBin: string;
  cliPath: string;
  tmpOutFile: string;
  model?: string | null;
  inlineHtmlContent?: string;
}): { workDir: string; args: string[]; agentPrompt: string } {
  const resolved = path.resolve(opts.filePath);
  const workDir = resolveWorkspaceRoot(resolved);
  const sandboxArgs =
    opts.sandboxMode === 'full-access'
      ? ['--dangerously-bypass-approvals-and-sandbox', '-c', 'web_search="live"']
      : [
          '--sandbox',
          'workspace-write',
          '-c',
          'web_search="disabled"',
          '-c',
          'sandbox_workspace_write.network_access=false',
          '-c',
          'features.apps=false',
          '-c',
          'features.plugins=false',
          '-c',
          'features.remote_plugin=false',
          '-c',
          'features.browser_use=false',
          '-c',
          'features.browser_use_external=false',
        ];

  const normalizedModel = normalizeModelSelection(opts.model);
  const modelArgs = normalizedModel ? ['-m', normalizedModel] : [];

  const args = [
    'exec',
    '--ephemeral',
    '-c',
    'mcp_servers={}',
    ...sandboxArgs,
    ...modelArgs,
    '--skip-git-repo-check',
    '-C',
    workDir,
    '--output-last-message',
    opts.tmpOutFile,
    '-',
  ];

  const hasInlineHtml =
    typeof opts.inlineHtmlContent === 'string' && opts.inlineHtmlContent.length <= 60_000;

  const instruction1 = hasInlineHtml
    ? `1. The current HTML file is included above (${resolved}); only re-read from disk if you need additional context.`
    : `1. Start by reading ${resolved} to understand the context of each open comment.`;

  const instruction2 =
    opts.sandboxMode === 'full-access'
      ? `2. Edit ${resolved} (and any related files requested by the comments) directly.`
      : `2. Edit ${resolved} (and any related files inside ${workDir} if requested by the comments) directly.`;

  const instruction4 =
    opts.sandboxMode === 'full-access'
      ? `4. You are running in Full Access mode (workspace root: ${workDir}). If an inline comment asks you to inspect other local files, reference project code, fetch web assets, or run commands, you may do so directly. Avoid unrelated repository builds or test suites unless an inline comment asks for them. Do NOT read external SKILL.md files (all reply instructions are already provided above).`
      : `4. You are running in workspace-write sandbox mode (writable root: ${workDir}, network disabled). Focus on ${resolved} and related files in ${workDir}; do NOT run unrelated repository builds or test suites unless a comment asks for them. If a comment requires network access or writes outside ${workDir} that your sandbox blocks, explain that clearly in your inline reply. Do NOT read external SKILL.md files (all reply instructions are already provided above).`;

  const promptSections = [
    `You are responding to inline review comments left by the user on the HTML file: ${resolved}`,
    ``,
    opts.reviewReport,
  ];

  if (hasInlineHtml) {
    promptSections.push(
      ``,
      `## Current HTML File (${resolved})`,
      `\`\`\`html`,
      opts.inlineHtmlContent as string,
      `\`\`\``
    );
  }

  promptSections.push(
    ``,
    `IMPORTANT INSTRUCTIONS:`,
    instruction1,
    instruction2,
    `3. Reply to ALL open comment threads in ONE single batch command (do NOT run separate reply commands per comment):`,
    `   ${opts.nodeBin} --no-warnings ${opts.cliPath} reply-batch ${JSON.stringify(resolved)} --stdin <<'EOF'`,
    `   [{"id":"c-1","reply":"<your detailed answer or summary of changes>","status":"resolved"}]`,
    `   EOF`,
    `   (Use "status":"resolved" when a requested edit is complete, or "status":"answered" when answering a question.)`,
    instruction4
  );

  const agentPrompt = promptSections.join('\n');

  return { workDir, args, agentPrompt };
}

export function detectSandboxErrorMessage(
  lines: string[],
  sandboxMode: CodexSandboxMode
): string | undefined {
  const joined = lines.join('\n');
  if (
    !/operation not permitted|\beperm\b|sandbox-exec|seatbelt|landlock|read-only file system|allowed_sandbox_modes|blocked by.*policy|network.*disabled|could not resolve host|sandbox.*denied/i.test(
      joined
    )
  ) {
    return undefined;
  }
  if (sandboxMode === 'full-access') {
    return 'Codex hit an OS sandbox or policy restriction even in Full Access mode. The review server may have been started inside a sandboxed shell, or a system Codex policy is enforcing restrictions. Restart codex-markup from a normal terminal if unrestricted access is needed.';
  }
  return 'Codex was blocked by workspace-write sandbox restrictions (no network or writes outside the workspace). Switch to Full Access in the toolbar (when standalone) or adjust your Codex session permissions.';
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

function formatAgentStatusPhase(line: string): string | null {
  if (
    !line ||
    /^[-=*_]{3,}$/.test(line) ||
    /^(<|\/?>|\.|#|\{|\}|\/\*|\*\/|--)(\s|$|[a-zA-Z0-9_-])/.test(line) ||
    /^(OpenAI Codex|workdir:|model:|provider:|approval:|sandbox:|reasoning |session id:|tokens used$|succeeded in |warning:)/i.test(
      line
    ) ||
    /\/bin\/(z?sh|bash)\b.*\bcat\b/.test(line) ||
    /^\d[\d,]*$/.test(line)
  ) {
    return null;
  }
  if (/^web search:|search_service\.web_run/i.test(line)) {
    return 'Searching web...';
  }
  if (/\breply-batch\b|\bcli\.ts\s+reply\b/.test(line)) {
    return 'Posting replies...';
  }
  if (/^exec$/i.test(line) || /^\/bin\/(z?sh|bash)\b/.test(line)) {
    return 'Running command...';
  }
  if (/^codex$/i.test(line)) {
    return 'Drafting response...';
  }
  const snippet = line.length > 72 ? line.slice(0, 69) + '...' : line;
  return `Codex: ${snippet}`;
}

function parseFallbackRepliesFromMessage(
  lastMessage: string
): Array<{ commentId: string; text: string; status?: CommentStatus }> | null {
  let raw = lastMessage.trim();
  const fenceMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    raw = fenceMatch[1].trim();
  }
  if (!raw.startsWith('[') && !raw.startsWith('{')) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { replies?: unknown }).replies)
        ? (parsed as { replies: unknown[] }).replies
        : null;
    if (!arr) return null;
    const items: Array<{ commentId: string; text: string; status?: CommentStatus }> = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const commentId = String(rec.commentId ?? rec.comment_id ?? rec.id ?? '').trim();
      const text = String(rec.text ?? rec.reply ?? '').trim();
      const status =
        rec.status === 'open' || rec.status === 'answered' || rec.status === 'resolved'
          ? rec.status
          : undefined;
      if (commentId && text) {
        items.push({ commentId, text, status });
      }
    }
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

export class InlineReviewServer {
  private server: http.Server;
  private port: number;
  private activeFilePath: string | null = null;
  private sseClients = new Set<SSEClient>();
  private waiters = new Set<PendingWaiter>();
  private watchedFiles = new Map<string, fs.FSWatcher>();
  private activeCodexRuns = new Map<string, { startedAt: string; statusText: string; queued?: boolean }>();
  private pendingCodexRerun = new Set<string>();
  private lastInternalSidecarWrite = new Map<string, number>();
  private sandboxMode: CodexSandboxMode;
  private selectedModel: string | null;
  private defaultConfigModel?: string;
  private availableModels: ModelOption[] = [];
  private modelsReadyPromise: Promise<void> = Promise.resolve();
  private env: NodeJS.ProcessEnv;
  private requirementsPath?: string;

  constructor(
    port = DEFAULT_PORT,
    initialFile?: string,
    sandboxMode?: CodexSandboxMode,
    options?: InlineReviewServerOptions
  ) {
    this.port = port;
    this.env = options?.env ?? process.env;
    this.requirementsPath = options?.requirementsPath;
    this.sandboxMode = resolveDefaultSandboxMode(sandboxMode, this.env, this.requirementsPath);
    this.selectedModel = resolveDefaultModel(options?.model, this.env);
    this.defaultConfigModel = readCodexConfigDefaultModel(this.env);
    if (options?.availableModels) {
      this.availableModels = options.availableModels;
    } else if (!options?.skipModelDiscovery && Object.keys(this.env).length > 0) {
      const cached = readCodexModelsCache(this.env);
      if (cached.length > 0) {
        this.availableModels = cached;
      }
      const codexBin = findCodexBin(this.env);
      this.modelsReadyPromise = loadAvailableModels(codexBin, {
        ...this.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${this.env.PATH || '/usr/bin:/bin'}`,
      }).then((models) => {
        if (models.length > 0) {
          this.availableModels = models;
          if (this.activeFilePath) {
            this.broadcastSSE(this.activeFilePath, 'comments-updated', {
              reason: 'model-changed',
              model: this.getModelCapabilities(this.activeFilePath),
            });
          }
        }
      });
    }
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

  public getModelCapabilities(filePath?: string | null): ModelCapabilities {
    const targetFile = filePath ? path.resolve(filePath) : this.activeFilePath;
    const waitingCount = targetFile ? this.getWaitersCount(targetFile) : this.waiters.size;

    if (waitingCount > 0) {
      return {
        configuredModel: this.selectedModel,
        effectiveModel: null,
        ...(this.defaultConfigModel ? { defaultConfigModel: this.defaultConfigModel } : {}),
        controlSource: 'connected-session',
        canSelect: false,
        label: 'Session Model',
        reason:
          'Model selection is owned by your connected Codex CLI/Desktop session. MCP does not allow an external server to change the host Codex session model.',
        hint:
          'Switch models directly in Codex Desktop/CLI, or submit when no session is listening to pick a model for standalone background runs.',
        availableModels: this.availableModels,
      };
    }

    const resolvedDefault = this.defaultConfigModel || this.availableModels[0]?.slug || null;
    const effectiveModel = this.selectedModel || resolvedDefault;
    const matchedOption = effectiveModel
      ? this.availableModels.find((m) => m.slug === effectiveModel)
      : undefined;
    const label = matchedOption?.displayName || effectiveModel || 'Codex Model';
    const slugNote =
      matchedOption && effectiveModel && matchedOption.displayName.toLowerCase() !== effectiveModel.toLowerCase()
        ? ` (${effectiveModel})`
        : '';
    const reason = effectiveModel
      ? `Standalone background Codex will answer using ${label}${slugNote}. Click to switch models.`
      : 'Standalone background Codex will answer using your active Codex configuration. Click to switch models.';

    return {
      configuredModel: this.selectedModel,
      effectiveModel,
      ...(this.defaultConfigModel ? { defaultConfigModel: this.defaultConfigModel } : {}),
      controlSource: 'background-codex',
      canSelect: true,
      label,
      reason,
      availableModels: this.availableModels,
    };
  }

  public getSandboxCapabilities(filePath?: string | null): SandboxCapabilities {
    const targetFile = filePath ? path.resolve(filePath) : this.activeFilePath;
    const waitingCount = targetFile ? this.getWaitersCount(targetFile) : this.waiters.size;
    const workspaceRoot = targetFile ? resolveWorkspaceRoot(targetFile) : process.cwd();
    const cliPath = path.resolve(import.meta.dirname || '.', 'cli.ts');
    const restartCommand = targetFile
      ? `node --no-warnings ${cliPath} restart ${JSON.stringify(targetFile)}`
      : `node --no-warnings ${cliPath} restart`;

    if (waitingCount > 0) {
      return {
        configuredMode: this.sandboxMode,
        effectiveMode: 'session-controlled',
        controlSource: 'connected-session',
        canToggle: false,
        label: 'Session Sandbox',
        reason:
          'Controlled by your connected Codex session. Submissions go directly to the listening Codex CLI/Desktop session and run under its own sandbox permissions.',
        hint:
          'To allow network or access outside the workspace, change permissions in your Codex session (e.g., Full Access in Codex Desktop or --sandbox danger-full-access in Codex CLI).',
        workspaceRoot,
      };
    }

    const ext = detectExternalSandbox(this.env);
    if (ext.sandboxed) {
      return {
        configuredMode: this.sandboxMode,
        effectiveMode: 'externally-sandboxed',
        controlSource: 'externally-sandboxed',
        canToggle: false,
        label: 'Host Sandboxed',
        reason: `This review server was launched inside an outer OS sandbox (${ext.signal}). Child processes cannot escape an outer sandbox, so Full Access cannot be enabled here.`,
        hint: 'Restart codex-markup from an unsandboxed terminal to enable Full Access.',
        workspaceRoot,
        externalSandboxSignal: ext.signal,
        restartCommand,
      };
    }

    const policy = detectPolicyFullAccessBlocked(this.requirementsPath, this.env);
    if (policy.blocked) {
      return {
        configuredMode: this.sandboxMode,
        effectiveMode: 'workspace-write',
        controlSource: 'policy-restricted',
        canToggle: false,
        label: 'Policy Sandboxed',
        reason: `System Codex policy (${policy.path}) restricts danger-full-access, so background runs stay in workspace-write sandbox mode.`,
        hint: 'Update your Codex requirements policy if Full Access is permitted on this machine.',
        workspaceRoot,
      };
    }

    if (this.sandboxMode === 'full-access') {
      return {
        configuredMode: this.sandboxMode,
        effectiveMode: 'full-access',
        controlSource: 'background-codex',
        canToggle: true,
        label: 'Full Access',
        reason: `Standalone background Codex runs with Full Access (--dangerously-bypass-approvals-and-sandbox): can read/write local files, access the network, and run commands. Workspace root: ${workspaceRoot}. Click to switch to Sandboxed.`,
        workspaceRoot,
      };
    }

    return {
      configuredMode: this.sandboxMode,
      effectiveMode: 'workspace-write',
      controlSource: 'background-codex',
      canToggle: true,
      label: 'Sandboxed',
      reason: `Standalone background Codex runs in workspace-write sandbox (writable root: ${workspaceRoot}, no network). Click to switch to Full Access.`,
      workspaceRoot,
    };
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
    for (const w of this.waiters) {
      if (w.timer) clearTimeout(w.timer);
    }
    this.waiters.clear();
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
    timeoutMs = 600_000,
    signal?: AbortSignal
  ): Promise<{ state: ReviewDocumentState; prompt: string }> {
    const resolved = this.setActiveFile(filePath);
    if (signal?.aborted) {
      const state = loadReviewState(resolved);
      const prompt = formatReviewForCodex(resolved, 'open');
      return Promise.resolve({ state, prompt });
    }
    return new Promise((resolve) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        this.broadcastWaitersCount(resolved);
        const state = loadReviewState(resolved);
        const prompt = formatReviewForCodex(resolved, 'open');
        resolve({ state, prompt });
      };
      const waiter: PendingWaiter = {
        filePath: resolved,
        resolve: (res) => {
          if (settled) return;
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          if (waiter.timer) clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          this.broadcastWaitersCount(resolved);
          resolve(res);
        },
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
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
    this.broadcastSSE(filePath, 'waiters-updated', {
      waitingAgentsCount: count,
      sandbox: this.getSandboxCapabilities(filePath),
      model: this.getModelCapabilities(filePath),
    });
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
    const sidecar = getSidecarPath(resolved);
    const dir = path.dirname(resolved);
    const sidecarBase = path.basename(sidecar);
    const htmlBase = path.basename(resolved);
    const dirWatchKey = `dir:${dir}:${htmlBase}:${sidecarBase}`;

    if (!this.watchedFiles.has(dirWatchKey) && fs.existsSync(dir)) {
      let sidecarDebounce: NodeJS.Timeout | null = null;
      let htmlDebounce: NodeJS.Timeout | null = null;
      try {
        const watcher = fs.watch(dir, (_eventType, filename) => {
          if (filename === sidecarBase) {
            if (Date.now() - (this.lastInternalSidecarWrite.get(resolved) || 0) < 350) {
              return;
            }
            if (sidecarDebounce) clearTimeout(sidecarDebounce);
            sidecarDebounce = setTimeout(() => {
              this.broadcastSSE(resolved, 'comments-updated', { reason: 'file-sync' });
            }, 100);
          } else if (filename === htmlBase) {
            if (htmlDebounce) clearTimeout(htmlDebounce);
            htmlDebounce = setTimeout(() => {
              this.broadcastSSE(resolved, 'html-updated', { filePath: resolved, timestamp: Date.now() });
            }, 120);
          }
        });
        this.watchedFiles.set(dirWatchKey, watcher);
        return;
      } catch {
        // Fallback to direct file watch below
      }
    }

    if (!this.watchedFiles.has(dirWatchKey) && !this.watchedFiles.has(resolved) && fs.existsSync(resolved)) {
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

  private async waitForModelsReady(maxWaitMs = 2500): Promise<void> {
    if (this.availableModels.length > 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.modelsReadyPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, maxWaitMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const endpoint = url.pathname.replace('/__inline_review__/api', '');

    if (endpoint === '/health' && req.method === 'GET') {
      await this.waitForModelsReady();
      this.sendJson(res, 200, {
        ok: true,
        port: this.port,
        activeFilePath: this.activeFilePath,
        sandboxMode: this.sandboxMode,
        sandbox: this.getSandboxCapabilities(this.activeFilePath),
        model: this.getModelCapabilities(this.activeFilePath),
      });
      return;
    }

    if (endpoint === '/state' && req.method === 'GET') {
      await this.waitForModelsReady();
      const file = this.resolveRequestedFile(url.searchParams.get('file'));
      const state = loadReviewState(file);
      this.sendJson(res, 200, {
        state,
        waitingAgentsCount: this.getWaitersCount(file),
        codexRun: this.activeCodexRuns.get(file) || null,
        sandboxMode: this.sandboxMode,
        sandbox: this.getSandboxCapabilities(file),
        model: this.getModelCapabilities(file),
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
      this.lastInternalSidecarWrite.set(file, Date.now());
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
      this.lastInternalSidecarWrite.set(file, Date.now());
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

    if (endpoint === '/reply-batch' && req.method === 'POST') {
      const file = this.resolveRequestedFile(body.file as string);
      if (!Array.isArray(body.replies)) {
        this.sendJson(res, 400, { ok: false, error: 'Missing replies array' });
        return;
      }
      const normalized: BatchReplyInput[] = body.replies
        .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
        .map((r) => ({
          commentId: String(r.commentId ?? r.comment_id ?? r.id ?? ''),
          text: String(r.text ?? r.reply ?? ''),
          author: ((r.author as MessageAuthor) || 'codex'),
          status: r.status as CommentStatus | undefined,
        }))
        .filter((r) => r.commentId.trim().length > 0);

      this.lastInternalSidecarWrite.set(file, Date.now());
      const { updated, missing } = addRepliesBatch(file, normalized);
      if (normalized.length > 0 && updated.length === 0) {
        this.logEvent(`[API /reply-batch] 404 file=${file} missing=${missing.join(',')}`);
        this.sendJson(res, 404, {
          ok: false,
          error: `No matching comments found (${missing.join(', ')})`,
          missing,
        });
        return;
      }

      this.logEvent(
        `[API /reply-batch] file=${file} updated=${updated.length} missing=${missing.length}`
      );
      if (updated.length > 0) {
        this.broadcastSSE(file, 'comments-updated', {
          reason: 'codex-reply-batch',
          count: updated.length,
          commentIds: updated.map((t) => t.id),
          numbers: updated.map((t) => t.number),
        });
      }
      this.sendJson(res, 200, {
        ok: true,
        threads: updated,
        updatedCount: updated.length,
        missing,
      });
      return;
    }

    if (endpoint === '/status' && req.method === 'POST') {
      const file = this.resolveRequestedFile(body.file as string);
      const commentId = String(body.commentId || '');
      const status = (body.status as CommentStatus) || 'resolved';
      this.lastInternalSidecarWrite.set(file, Date.now());
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
      this.lastInternalSidecarWrite.set(file, Date.now());
      const deleted = deleteThread(file, commentId);
      this.broadcastSSE(file, 'comments-updated', { reason: 'deleted', commentId });
      this.sendJson(res, 200, { ok: deleted });
      return;
    }

    if (endpoint === '/sandbox' && req.method === 'POST') {
      const targetFile = typeof body.file === 'string' ? this.setActiveFile(body.file) : this.activeFilePath;
      const currentCaps = this.getSandboxCapabilities(targetFile);
      if (!currentCaps.canToggle) {
        this.logEvent(
          `[API /sandbox] Blocked toggle (controlSource=${currentCaps.controlSource}, sandboxMode=${this.sandboxMode})`
        );
        this.sendJson(res, 200, {
          ok: false,
          applied: false,
          error: currentCaps.reason,
          sandboxMode: this.sandboxMode,
          sandbox: currentCaps,
        });
        return;
      }

      const requested = typeof body.sandboxMode === 'string' ? body.sandboxMode : undefined;
      this.sandboxMode =
        requested === 'full-access' || requested === 'danger-full-access'
          ? 'full-access'
          : 'workspace-write';
      const nextCaps = this.getSandboxCapabilities(targetFile);
      this.logEvent(`[API /sandbox] sandboxMode=${this.sandboxMode}`);
      if (targetFile) {
        const resolved = this.setActiveFile(targetFile);
        this.broadcastSSE(resolved, 'comments-updated', {
          reason: 'sandbox-mode',
          sandboxMode: this.sandboxMode,
          sandbox: nextCaps,
        });
      }
      this.sendJson(res, 200, {
        ok: true,
        applied: true,
        sandboxMode: this.sandboxMode,
        sandbox: nextCaps,
      });
      return;
    }

    if (endpoint === '/model' && req.method === 'POST') {
      const targetFile = typeof body.file === 'string' ? this.setActiveFile(body.file) : this.activeFilePath;
      const currentCaps = this.getModelCapabilities(targetFile);
      if (!currentCaps.canSelect) {
        this.logEvent(
          `[API /model] Blocked change (controlSource=${currentCaps.controlSource}, selectedModel=${this.selectedModel ?? 'default'})`
        );
        this.sendJson(res, 200, {
          ok: false,
          applied: false,
          error: currentCaps.reason,
          model: currentCaps,
        });
        return;
      }

      const requested =
        body.model === null || typeof body.model === 'string' ? body.model : undefined;
      this.selectedModel = normalizeModelSelection(requested);
      const nextCaps = this.getModelCapabilities(targetFile);
      this.logEvent(`[API /model] selectedModel=${this.selectedModel ?? 'default'}`);
      if (targetFile) {
        const resolved = this.setActiveFile(targetFile);
        this.broadcastSSE(resolved, 'comments-updated', {
          reason: 'model-changed',
          model: nextCaps,
        });
      }
      this.sendJson(res, 200, {
        ok: true,
        applied: true,
        model: nextCaps,
      });
      return;
    }

    if (endpoint === '/submit' && req.method === 'POST') {
      const file = this.resolveRequestedFile(body.file as string);
      const capsBefore = this.getSandboxCapabilities(file);
      if (typeof body.sandboxMode === 'string' && capsBefore.canToggle) {
        this.sandboxMode =
          body.sandboxMode === 'full-access' || body.sandboxMode === 'danger-full-access'
            ? 'full-access'
            : 'workspace-write';
      }
      if (body.model !== undefined && this.getModelCapabilities(file).canSelect) {
        this.selectedModel = normalizeModelSelection(
          body.model === null || typeof body.model === 'string' ? body.model : undefined
        );
      }
      this.lastInternalSidecarWrite.set(file, Date.now());
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
      let queued = false;
      const openThreads = state.threads.filter((t) => t.status === 'open');
      this.logEvent(
        `[API /submit] file=${file} openCount=${openThreads.length} notifiedWaiters=${notifiedWaiters} autoRunCodex=${body.autoRunCodex !== false}`
      );
      if (notifiedWaiters === 0 && openThreads.length > 0 && body.autoRunCodex !== false) {
        const outcome = this.runBackgroundCodex(file, openThreads.map((t) => t.id));
        spawnedCodex = outcome === 'spawned';
        queued = outcome === 'queued';
      }

      this.sendJson(res, 200, {
        ok: true,
        state,
        prompt,
        notifiedWaiters,
        spawnedCodex,
        queued,
        sandbox: this.getSandboxCapabilities(file),
        model: this.getModelCapabilities(file),
      });
      return;
    }

    if (endpoint === '/wait' && req.method === 'POST') {
      const file = this.resolveRequestedFile(body.file as string);
      const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 600_000;
      const abortController = new AbortController();
      const onResClose = () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      };
      res.on('close', onResClose);
      try {
        const result = await this.waitForSubmission(file, timeoutMs, abortController.signal);
        if (res.writableEnded || res.destroyed) {
          return;
        }
        this.sendJson(res, 200, { ok: true, ...result });
      } finally {
        res.off('close', onResClose);
      }
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

  private runBackgroundCodex(filePath: string, openThreadIds: string[]): 'spawned' | 'queued' {
    const resolved = path.resolve(filePath);
    const existingRun = this.activeCodexRuns.get(resolved);
    if (existingRun) {
      this.pendingCodexRerun.add(resolved);
      existingRun.queued = true;
      this.logEvent(`[runBackgroundCodex] Queued follow-up batch for ${resolved}`);
      this.broadcastSSE(resolved, 'agent-status', { running: true, ...existingRun });
      return 'queued';
    }

    const runState = {
      startedAt: new Date().toISOString(),
      statusText: 'Codex is reviewing your inline comments...',
    };
    this.activeCodexRuns.set(resolved, runState);
    this.broadcastSSE(resolved, 'agent-status', { running: true, ...runState });

    const codexBin = findCodexBin(this.env);

    const nodeBin = fs.existsSync('/opt/homebrew/bin/node')
      ? '/opt/homebrew/bin/node'
      : process.execPath;

    const cliPath = path.resolve(import.meta.dirname || '.', 'cli.ts');
    const tmpOutFile = path.join(os.tmpdir(), `codex-inline-reply-${Date.now()}.txt`);
    const reviewReport = formatReviewForCodex(resolved, 'open');

    let inlineHtmlContent: string | undefined;
    try {
      if (fs.existsSync(resolved)) {
        const rawHtml = fs.readFileSync(resolved, 'utf8');
        if (rawHtml.length <= 60_000) {
          inlineHtmlContent = rawHtml;
        }
      }
    } catch {
      // Ignore inline read error; Codex can still read from disk
    }

    const beforeReplyCounts = new Map<string, number>();
    const initialState = loadReviewState(resolved);
    for (const t of initialState.threads) {
      beforeReplyCounts.set(t.id, t.messages.length);
    }

    const caps = this.getSandboxCapabilities(resolved);
    const effectiveRunMode: CodexSandboxMode =
      caps.effectiveMode === 'full-access' ? 'full-access' : 'workspace-write';

    const { workDir, args, agentPrompt } = buildBackgroundCodexInvocation({
      filePath: resolved,
      reviewReport,
      sandboxMode: effectiveRunMode,
      nodeBin,
      cliPath,
      tmpOutFile,
      model: this.selectedModel,
      inlineHtmlContent,
    });

    const env = {
      ...this.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${this.env.PATH || '/usr/bin:/bin'}`,
    };

    this.logEvent(
      `[runBackgroundCodex] Spawning ${codexBin} for ${resolved} (sandboxMode=${effectiveRunMode}, model=${this.selectedModel ?? 'default'}, workDir=${workDir}, threads=${openThreadIds.join(',')}, promptBytes=${Buffer.byteLength(agentPrompt, 'utf8')})`
    );

    const child = spawn(codexBin, args, {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let lastErrorLine = '';
    const collectedLines: string[] = [];
    let lastStatusBroadcastAt = Date.now();

    const handleStreamChunk = (source: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (collectedLines.length >= 120) {
          collectedLines.shift();
        }
        collectedLines.push(line);
        if (/\bERROR\b|unexpected status [45]\d\d/i.test(line)) {
          lastErrorLine = line;
        }
        if (source === 'stderr') {
          console.error(`[${new Date().toISOString()}] [codex-exec stderr] ${line}`);
        } else {
          console.log(`[${new Date().toISOString()}] [codex-exec stdout] ${line}`);
        }
        const phaseText = formatAgentStatusPhase(line);
        const active = this.activeCodexRuns.get(resolved);
        const now = Date.now();
        if (active && phaseText && phaseText !== active.statusText && now - lastStatusBroadcastAt >= 300) {
          active.statusText = phaseText;
          lastStatusBroadcastAt = now;
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
      this.pendingCodexRerun.delete(resolved);
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

        // Fallback: if Codex answered in its final output without invoking `reply-batch` / `reply`
        // on any of the open threads, attach its response automatically in one batch write.
        if (lastMessage) {
          const afterState = loadReviewState(resolved);
          const unRepliedIds = openThreadIds.filter((threadId) => {
            const thread = afterState.threads.find((t) => t.id === threadId);
            const prevCount = beforeReplyCounts.get(threadId) || 0;
            return Boolean(thread && thread.messages.length <= prevCount);
          });

          if (unRepliedIds.length > 0) {
            const parsedReplies = parseFallbackRepliesFromMessage(lastMessage);
            const batchInputs: BatchReplyInput[] = [];
            if (parsedReplies) {
              for (const item of parsedReplies) {
                const thread = afterState.threads.find(
                  (t) => t.id === item.commentId || `c-${t.number}` === item.commentId || String(t.number) === item.commentId
                );
                if (thread && unRepliedIds.includes(thread.id)) {
                  batchInputs.push({
                    commentId: thread.id,
                    text: item.text,
                    author: 'codex',
                    status: item.status || (thread.status === 'open' ? 'answered' : thread.status),
                  });
                }
              }
            } else {
              for (const threadId of unRepliedIds) {
                const thread = afterState.threads.find((t) => t.id === threadId);
                if (!thread) continue;
                batchInputs.push({
                  commentId: threadId,
                  text: lastMessage,
                  author: 'codex',
                  status: thread.status === 'open' ? 'answered' : thread.status,
                });
              }
            }

            if (batchInputs.length > 0) {
              this.lastInternalSidecarWrite.set(resolved, Date.now());
              const { updated } = addRepliesBatch(resolved, batchInputs);
              if (updated.length > 0) {
                this.logEvent(
                  `[runBackgroundCodex] Attached ${updated.length} fallback reply(ies) (${updated.map((t) => t.id).join(', ')})`
                );
                this.broadcastSSE(
                  resolved,
                  'comments-updated',
                  updated.length === 1
                    ? {
                        reason: 'codex-reply',
                        commentId: updated[0].id,
                        number: updated[0].number,
                      }
                    : {
                        reason: 'codex-reply-batch',
                        count: updated.length,
                        commentIds: updated.map((t) => t.id),
                        numbers: updated.map((t) => t.number),
                      }
                );
              }
            }
          }
        }
      } catch (err) {
        console.error(`[${new Date().toISOString()}] [InlineReviewServer] Post-run check error:`, err);
      } finally {
        const sandboxWarning = detectSandboxErrorMessage(collectedLines, effectiveRunMode);
        this.activeCodexRuns.delete(resolved);
        this.broadcastSSE(resolved, 'agent-status', {
          running: false,
          completed: code === 0 && !lastErrorLine,
          error: lastErrorLine || (code !== 0 ? `Codex exited with code ${code}` : undefined),
          ...(sandboxWarning ? { sandboxWarning } : {}),
        });
        if (this.pendingCodexRerun.delete(resolved)) {
          const latestState = loadReviewState(resolved);
          const remainingOpenIds = latestState.threads
            .filter((t) => t.status === 'open')
            .map((t) => t.id);
          if (remainingOpenIds.length > 0) {
            this.runBackgroundCodex(resolved, remainingOpenIds);
          }
        }
      }
    });

    return 'spawned';
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
