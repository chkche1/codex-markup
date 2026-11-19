import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const EXPECTED_MCP_TOOLS = [
  'open_html_review',
  'wait_for_review',
  'get_inline_comments',
  'reply_to_comment',
  'resolve_comment',
];

const MCP_SECTION_RE =
  /\[mcp_servers\.(?:inline-review|"inline-review"|'inline-review')\][\s\S]*?(?=\n\[|\s*$)/;
const AGENTS_MARKER_START = '<!-- BEGIN CODEX-INLINE-REVIEW -->';
const AGENTS_MARKER_END = '<!-- END CODEX-INLINE-REVIEW -->';
const AGENTS_MARKER_RE = new RegExp(`${AGENTS_MARKER_START}[\\s\\S]*?${AGENTS_MARKER_END}`, 'm');

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  codexHome: string;
  checks: DoctorCheck[];
  tools: string[];
}

export interface InstallOptions {
  codexHome?: string;
  copy?: boolean;
  installDir?: string;
  skipVerify?: boolean;
  sourceRoot?: string;
  nodeBin?: string;
  json?: boolean;
}

export interface InstallResult {
  codexHome: string;
  installRoot: string;
  cliEntry: string;
  nodeBin: string;
  relocated: boolean;
  doctor?: DoctorReport;
}

export interface UninstallOptions {
  codexHome?: string;
  keepRuntime?: boolean;
}

export interface UninstallResult {
  codexHome: string;
  removedConfigSection: boolean;
  removedSkillDir: boolean;
  removedAgentsBlock: boolean;
  removedRuntimeDir: boolean;
}

const MANIFEST = 'codex-markup-install.json';
const OWNER_MARKER = '.codex-markup-owned.json';

function readInstallation(file: string): { runtimeRoot: string; codexHome: string; managed: boolean } | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value && typeof value === 'object' &&
        'runtimeRoot' in value && typeof value.runtimeRoot === 'string' &&
        'codexHome' in value && typeof value.codexHome === 'string' &&
        'managed' in value && typeof value.managed === 'boolean') {
      return { runtimeRoot: value.runtimeRoot, codexHome: value.codexHome, managed: value.managed };
    }
  } catch { /* An absent or invalid manifest never authorizes runtime removal. */ }
  return undefined;
}

function ownsRuntime(runtimeRoot: string, codexHome: string): boolean {
  const owner = readInstallation(path.join(runtimeRoot, OWNER_MARKER));
  return Boolean(owner?.managed && owner.runtimeRoot === runtimeRoot && owner.codexHome === codexHome &&
    !fs.lstatSync(runtimeRoot).isSymbolicLink());
}

function isLegacyManagedRuntime(runtimeRoot: string, codexHome: string): boolean {
  if (runtimeRoot !== path.join(codexHome, 'tools', 'codex-markup') || !fs.existsSync(runtimeRoot) ||
      fs.lstatSync(runtimeRoot).isSymbolicLink()) return false;
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
    const config = extractMcpServerConfig(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    return Boolean(pkg && typeof pkg === 'object' && 'name' in pkg && pkg.name === 'codex-markup' &&
      config?.args.includes(path.join(runtimeRoot, 'src', 'cli.ts')));
  } catch { return false; }
}

export function isSupportedNodeVersion(versionStr: string): boolean {
  const match = versionStr.trim().match(/^v?(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 24 || (major === 22 && minor >= 18);
}

export function resolveCodexHome(
  customCodexHome?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (customCodexHome) {
    return path.resolve(customCodexHome);
  }
  if (env.CODEX_HOME) {
    return path.resolve(env.CODEX_HOME);
  }
  return path.join(os.homedir(), '.codex');
}

export function resolveInstallNodeBin(
  execPath = process.execPath,
  nodeVersion = process.versions.node
): string {
  if (!isSupportedNodeVersion(nodeVersion)) {
    throw new Error(
      `codex-markup requires Node.js 22.18+ (22.x) or 24+ (running v${nodeVersion} at ${execPath}). Switch to Node 22.18+ and retry.`
    );
  }
  return execPath;
}

function safeRealpath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isWithinDir(candidate: string, parentDir: string): boolean {
  const normCandidate = path.resolve(candidate);
  const normParent = path.resolve(parentDir);
  return (
    normCandidate === normParent || normCandidate.startsWith(normParent + path.sep)
  );
}

export function isEphemeralCheckoutPath(repoRoot: string): boolean {
  const candidates = new Set<string>([path.resolve(repoRoot), safeRealpath(repoRoot)]);
  const tempRoots = new Set<string>([
    path.resolve(os.tmpdir()),
    safeRealpath(os.tmpdir()),
    '/tmp',
    '/private/tmp',
  ]);

  for (const candidate of candidates) {
    for (const tmpRoot of tempRoots) {
      if (isWithinDir(candidate, tmpRoot)) {
        return true;
      }
    }
    if (candidate.startsWith('/var/folders/')) {
      return true;
    }
    if (
      /[\\/]_npx[\\/]/.test(candidate) ||
      /[\\/]pnpm-dlx[\\/]/.test(candidate) ||
      /[\\/]\.bun[\\/]install[\\/]cache[\\/]/.test(candidate)
    ) {
      return true;
    }
  }
  return false;
}

export function copyRuntimeToDir(sourceRoot: string, targetDir: string): void {
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedTarget = path.resolve(targetDir);
  if (resolvedSource !== resolvedTarget &&
      (isWithinDir(resolvedTarget, resolvedSource) || isWithinDir(resolvedSource, resolvedTarget))) {
    throw new Error('Runtime source and destination must not contain one another');
  }
  if (
    resolvedSource === resolvedTarget ||
    (fs.existsSync(resolvedTarget) && safeRealpath(resolvedSource) === safeRealpath(resolvedTarget))
  ) {
    return;
  }

  fs.mkdirSync(resolvedTarget, { recursive: true });
  const entries = ['package.json', 'bin', 'src', 'skills', 'examples/demo.html', 'README.md', 'LICENSE'];
  for (const entry of entries) {
    const srcPath = path.join(resolvedSource, entry);
    if (!fs.existsSync(srcPath)) continue;
    const dstPath = path.join(resolvedTarget, entry);
    fs.cpSync(srcPath, dstPath, { recursive: true, force: true });
  }

  for (const binFile of ['codex-markup.js', 'codex-inline-review.js']) {
    const binPath = path.join(resolvedTarget, 'bin', binFile);
    if (fs.existsSync(binPath)) {
      try {
        fs.chmodSync(binPath, 0o755);
      } catch {
        // Ignore chmod errors on platforms/filesystems that do not support POSIX modes
      }
    }
  }
}

function parseTomlStringLiteral(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return null;
}

function parseTomlStringArray(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null;
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  const tokenRe = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(inner)) !== null) {
    if (match[1] !== undefined) {
      try {
        items.push(String(JSON.parse(`"${match[1]}"`)));
      } catch {
        items.push(match[1]);
      }
    } else if (match[2] !== undefined) {
      items.push(match[2]);
    }
  }
  return items;
}

function extractMcpServerConfig(configRaw: string): { command: string; args: string[] } | null {
  const sectionMatch = MCP_SECTION_RE.exec(configRaw);
  if (!sectionMatch) return null;
  const block = sectionMatch[0].replace(/#.*$/gm, '');
  const cmdMatch = block.match(/^\s*command\s*=\s*(.+)$/m);
  const argsMatch = block.match(/^\s*args\s*=\s*(\[[\s\S]*?\])/m);
  if (!cmdMatch || !argsMatch) return null;
  const command = parseTomlStringLiteral(cmdMatch[1]);
  const args = parseTomlStringArray(argsMatch[1]);
  if (!command || !args) return null;
  return { command, args };
}

function findCliScriptArg(args: string[]): string | undefined {
  return args.find((arg) => /(?:^|[\\/])cli\.ts$/.test(arg));
}

function runMcpSmokeTest(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    let stderrBuf = '';
    let gotInit = false;
    let tools: string[] = [];

    const child = spawn(command, args, {
      env: {
        ...process.env,
        CODEX_REVIEW_PORT: '99999',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const cleanupChild = () => {
      try {
        child.stdin.end();
      } catch {
        // Ignore
      }
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore
        }
        const killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill('SIGKILL');
            } catch {
              // Ignore
            }
          }
        }, 500);
        killTimer.unref();
      }
    };

    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      cleanupChild();
      resolve({ ok, tools, error });
    };

    const timeoutTimer = setTimeout(() => {
      finish(
        false,
        `MCP handshake timed out after ${timeoutMs}ms${stderrBuf ? ` (stderr: ${stderrBuf.trim()})` : ''}`
      );
    }, timeoutMs);
    timeoutTimer.unref();

    child.on('error', (err) => {
      finish(false, `Failed to spawn MCP command (${command}): ${err.message}`);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            result?: {
              serverInfo?: { name?: string };
              tools?: Array<{ name?: string }>;
            };
            error?: { message?: string };
          };
          if (msg.id === 1) {
            if (msg.error) {
              finish(false, `MCP initialize error: ${msg.error.message || 'unknown'}`);
              return;
            }
            if (msg.result?.serverInfo?.name !== 'codex-markup') {
              finish(
                false,
                `Unexpected MCP serverInfo.name: ${String(msg.result?.serverInfo?.name)}`
              );
              return;
            }
            gotInit = true;
          } else if (msg.id === 2) {
            if (msg.error) {
              finish(false, `MCP tools/list error: ${msg.error.message || 'unknown'}`);
              return;
            }
            tools = (msg.result?.tools || [])
              .map((t) => t.name)
              .filter((n): n is string => Boolean(n));
            const missing = EXPECTED_MCP_TOOLS.filter((expected) => !tools.includes(expected));
            if (!gotInit) {
              finish(false, 'Received tools/list before initialize response');
              return;
            }
            if (missing.length > 0) {
              finish(false, `Missing MCP tools: ${missing.join(', ')}`);
              return;
            }
            finish(true);
            return;
          }
        } catch {
          // Ignore non-JSON lines if any
        }
      }
    });

    child.on('exit', (code, signal) => {
      if (!settled) {
        finish(
          false,
          `MCP server exited prematurely (code=${code}, signal=${signal})${stderrBuf ? `: ${stderrBuf.trim()}` : ''}`
        );
      }
    });

    try {
      const initReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'codex-markup-doctor', version: '1.0.0' },
        },
      });
      const initializedNotif = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      const listReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });
      child.stdin.write(`${initReq}\n${initializedNotif}\n${listReq}\n`);
    } catch (err) {
      finish(
        false,
        `Failed writing to MCP stdin: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });
}

export async function runDoctor(options?: {
  codexHome?: string;
  quiet?: boolean;
  timeoutMs?: number;
}): Promise<DoctorReport> {
  const codexHome = resolveCodexHome(options?.codexHome);
  const checks: DoctorCheck[] = [];
  let tools: string[] = [];

  // 1. Node.js version
  if (isSupportedNodeVersion(process.versions.node)) {
    checks.push({
      name: 'node-version',
      status: 'pass',
      detail: `Node.js v${process.versions.node} (22.18+ (22.x) or 24+)`,
    });
  } else {
    checks.push({
      name: 'node-version',
      status: 'fail',
      detail: `Node.js v${process.versions.node} is unsupported; use 22.18+ (22.x) or 24+`,
    });
  }

  // 2. config.toml [mcp_servers.inline-review]
  const configPath = path.join(codexHome, 'config.toml');
  let parsedMcp: { command: string; args: string[] } | null = null;
  if (!fs.existsSync(configPath)) {
    checks.push({
      name: 'config-toml',
      status: 'fail',
      detail: `Missing ${configPath}`,
    });
  } else {
    const configRaw = fs.readFileSync(configPath, 'utf8');
    parsedMcp = extractMcpServerConfig(configRaw);
    if (parsedMcp) {
      checks.push({
        name: 'config-toml',
        status: 'pass',
        detail: `Configured [mcp_servers.inline-review] in ${configPath}`,
      });
    } else {
      checks.push({
        name: 'config-toml',
        status: 'fail',
        detail: `Missing or invalid [mcp_servers.inline-review] section in ${configPath}`,
      });
    }
  }

  // 3. Runtime cli.ts presence and permanence
  const cliArg = parsedMcp ? findCliScriptArg(parsedMcp.args) : undefined;
  let runtimeExists = false;
  if (!parsedMcp) {
    checks.push({
      name: 'runtime-files',
      status: 'fail',
      detail: 'Skipped runtime check because [mcp_servers.inline-review] is not configured',
    });
  } else if (!cliArg || !fs.existsSync(cliArg)) {
    checks.push({
      name: 'runtime-files',
      status: 'fail',
      detail: `Configured CLI script not found: ${cliArg || '(missing cli.ts in args)'}`,
    });
  } else {
    runtimeExists = true;
    const runtimeRoot = path.dirname(path.dirname(cliArg));
    if (isEphemeralCheckoutPath(runtimeRoot)) {
      checks.push({
        name: 'runtime-files',
        status: 'warn',
        detail: `Runtime path is in a temporary/ephemeral directory (${runtimeRoot}); re-run install with --copy`,
      });
    } else {
      checks.push({
        name: 'runtime-files',
        status: 'pass',
        detail: `Runtime verified at ${cliArg}`,
      });
    }
  }

  // 4. Skill file
  const skillPath = path.join(codexHome, 'skills', 'inline-html-review', 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    checks.push({
      name: 'skill-file',
      status: 'fail',
      detail: `Missing ${skillPath}`,
    });
  } else {
    const skillRaw = fs.readFileSync(skillPath, 'utf8');
    if (
      skillRaw.includes('<path-to-codex-markup>') ||
      skillRaw.includes('<path-to-codex-inline-review>')
    ) {
      checks.push({
        name: 'skill-file',
        status: 'fail',
        detail: `Unresolved placeholder path in ${skillPath}`,
      });
    } else {
      checks.push({
        name: 'skill-file',
        status: 'pass',
        detail: `Skill installed at ${skillPath}`,
      });
    }
  }

  // 5. Global AGENTS.md marker block
  const agentsPath = path.join(codexHome, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    checks.push({
      name: 'agents-md',
      status: 'fail',
      detail: `Missing ${agentsPath}`,
    });
  } else {
    const agentsRaw = fs.readFileSync(agentsPath, 'utf8');
    if (agentsRaw.includes(AGENTS_MARKER_START) && agentsRaw.includes(AGENTS_MARKER_END)) {
      checks.push({
        name: 'agents-md',
        status: 'pass',
        detail: `Global instructions block present in ${agentsPath}`,
      });
    } else {
      checks.push({
        name: 'agents-md',
        status: 'fail',
        detail: `Missing codex-markup instruction block in ${agentsPath}`,
      });
    }
  }

  // 6. MCP stdio handshake
  if (parsedMcp && runtimeExists) {
    const smoke = await runMcpSmokeTest(
      parsedMcp.command,
      parsedMcp.args,
      options?.timeoutMs ?? 6000
    );
    tools = smoke.tools;
    if (smoke.ok) {
      checks.push({
        name: 'mcp-handshake',
        status: 'pass',
        detail: `Verified MCP server (${tools.length} tools: ${tools.join(', ')})`,
      });
    } else {
      checks.push({
        name: 'mcp-handshake',
        status: 'fail',
        detail: smoke.error || 'MCP handshake failed',
      });
    }
  } else {
    checks.push({
      name: 'mcp-handshake',
      status: 'fail',
      detail: 'Skipped MCP handshake because config or runtime files are missing',
    });
  }

  const ok = checks.every((c) => c.status !== 'fail');
  const report: DoctorReport = { ok, codexHome, checks, tools };

  if (!options?.quiet) {
    for (const check of checks) {
      const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
      console.log(`${icon} [${check.name}] ${check.detail}`);
    }
    console.log(ok ? 'STATUS: OK' : 'STATUS: FAILED');
  }

  return report;
}

export async function installForCodex(options?: InstallOptions): Promise<InstallResult> {
  const started = performance.now();
  let phaseStart = started;
  const phaseMs: Record<string, number> = {};
  const phase = (name: string) => {
    const now = performance.now();
    phaseMs[name] = Math.round((now - phaseStart) * 100) / 100;
    phaseStart = now;
  };
  const log = (message: string) => { if (!options?.json) console.log(message); };
  const codexHome = resolveCodexHome(options?.codexHome);
  const sourceRoot = path.resolve(
    options?.sourceRoot || path.resolve(import.meta.dirname || '.', '..')
  );
  const nodeBin = options?.nodeBin ?? resolveInstallNodeBin();

  const ephemeral = isEphemeralCheckoutPath(sourceRoot);
  const shouldCopy = Boolean(options?.copy || options?.installDir || ephemeral);
  const installRoot = shouldCopy
    ? path.resolve(options?.installDir || path.join(codexHome, 'tools', 'codex-markup'))
    : sourceRoot;

  if (isWithinDir(codexHome, installRoot)) {
    throw new Error('Runtime directory must not contain the Codex configuration directory');
  }
  if (shouldCopy && fs.existsSync(installRoot) && fs.lstatSync(installRoot).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite a symlink runtime directory: ${installRoot}`);
  }
  if (shouldCopy && installRoot !== sourceRoot && fs.existsSync(installRoot) &&
      !ownsRuntime(installRoot, codexHome) && !isLegacyManagedRuntime(installRoot, codexHome) && fs.readdirSync(installRoot).length > 0) {
    throw new Error(`Refusing to overwrite an unowned runtime directory: ${installRoot}`);
  }
  if (shouldCopy) {
    copyRuntimeToDir(sourceRoot, installRoot);
    log(
      `✓ Installed runtime files to ${installRoot}${ephemeral ? ' (relocated from ephemeral path)' : ''}`
    );
  }

  phase('runtime');
  const cliEntry = path.join(installRoot, 'src', 'cli.ts');
  fs.mkdirSync(codexHome, { recursive: true });

  // 1. Configure ~/.codex/config.toml
  const configPath = path.join(codexHome, 'config.toml');
  const tomlBlock = [
    `[mcp_servers.inline-review]`,
    `command = ${JSON.stringify(nodeBin)}`,
    `args = ["--no-warnings", ${JSON.stringify(cliEntry)}, "mcp"]`,
  ].join('\n');

  let existingConfig = '';
  if (fs.existsSync(configPath)) {
    existingConfig = fs.readFileSync(configPath, 'utf8');
  }

  let updatedConfig: string;
  if (MCP_SECTION_RE.test(existingConfig)) {
    updatedConfig = existingConfig.replace(MCP_SECTION_RE, tomlBlock);
  } else {
    const trimmed = existingConfig.trimEnd();
    updatedConfig = trimmed ? `${trimmed}\n\n${tomlBlock}\n` : `${tomlBlock}\n`;
  }
  fs.writeFileSync(configPath, updatedConfig, 'utf8');
  log(`✓ Configured MCP server [mcp_servers.inline-review] in ${configPath}`);

  // 2. Install Skill into ~/.codex/skills/inline-html-review/SKILL.md
  const sourceSkillPath = path.join(installRoot, 'skills', 'inline-html-review', 'SKILL.md');
  const targetSkillDir = path.join(codexHome, 'skills', 'inline-html-review');
  const targetSkillPath = path.join(targetSkillDir, 'SKILL.md');
  fs.mkdirSync(targetSkillDir, { recursive: true });
  const rawSkill = fs.readFileSync(sourceSkillPath, 'utf8');
  const resolvedSkill = rawSkill
    .replaceAll('<path-to-codex-markup>/src/cli.ts', cliEntry)
    .replaceAll('<path-to-codex-inline-review>/src/cli.ts', cliEntry);
  fs.writeFileSync(targetSkillPath, resolvedSkill, 'utf8');
  log(`✓ Installed Codex skill to ${targetSkillPath}`);

  // 3. Add global instruction block to ~/.codex/AGENTS.md
  const agentsPath = path.join(codexHome, 'AGENTS.md');
  const agentsSnippet = [
    AGENTS_MARKER_START,
    `## Inline HTML Preview & Commenting (\`inline-review\` MCP)`,
    `Whenever you generate or update an HTML file/artifact for the user, or when the user asks to preview an HTML page or address inline comments:`,
    `1. Call the \`open_html_review\` MCP tool with \`file_path\` to open the live browser preview with inline text & DOM commenting.`,
    `2. Call \`wait_for_review\` (or pass \`wait_for_submission: true\` to \`open_html_review\`) to wait for the user to click **"🚀 Submit to Codex"** in the browser, or call \`get_inline_comments\` when asked to check comments.`,
    `3. Edit the HTML file to address each comment and call \`reply_to_comment\` with \`comment_id\` (e.g. \`c-1\`), your explanation/answer, and \`status: "resolved"\` (or \`"answered"\` for questions).`,
    AGENTS_MARKER_END,
  ].join('\n');

  let existingAgents = '';
  if (fs.existsSync(agentsPath)) {
    existingAgents = fs.readFileSync(agentsPath, 'utf8');
  }
  let updatedAgents: string;
  if (AGENTS_MARKER_RE.test(existingAgents)) {
    updatedAgents = existingAgents.replace(AGENTS_MARKER_RE, agentsSnippet);
  } else {
    const trimmed = existingAgents.trimEnd();
    updatedAgents = trimmed ? `${trimmed}\n\n${agentsSnippet}\n` : `${agentsSnippet}\n`;
  }
  fs.writeFileSync(agentsPath, updatedAgents, 'utf8');
  log(`✓ Updated global instructions in ${agentsPath}`);

  phase('registration');
  let doctor: DoctorReport | undefined;
  if (!options?.skipVerify) {
    doctor = await runDoctor({ codexHome, quiet: true });
    if (doctor.ok) {
      log(`✓ Verified MCP server (${doctor.tools.length} tools: ${doctor.tools.join(', ')})`);
    } else {
      for (const check of doctor.checks) {
        if (check.status === 'fail') {
          console.error(`✗ [${check.name}] ${check.detail}`);
        }
      }
      throw new Error('Installation verification failed');
    }
  }

  phase('verification');
  const managed = (shouldCopy && installRoot !== sourceRoot) || ownsRuntime(installRoot, codexHome) || isLegacyManagedRuntime(installRoot, codexHome);
  const installation = { runtimeRoot: installRoot, codexHome, managed };
  if (managed) {
    fs.writeFileSync(path.join(installRoot, OWNER_MARKER), JSON.stringify(installation, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(codexHome, MANIFEST), JSON.stringify(installation, null, 2) + '\n');
  const packageInfo: unknown = JSON.parse(fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8'));
  const version = packageInfo && typeof packageInfo === 'object' && 'version' in packageInfo
    ? String(packageInfo.version) : 'unknown';
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const result = { status: doctor?.ok ? 'verified' : 'unverified', version, runtimeRoot: installRoot,
    codexHome, elapsedMs, phaseMs, restartRequired: true };
  if (options?.json) {
    console.log(JSON.stringify(result));
  } else {
    log(`Installed codex-markup ${version} at ${installRoot} (${elapsedMs} ms)`);
    log(`Timing: runtime ${phaseMs.runtime} ms; registration ${phaseMs.registration} ms; verification ${phaseMs.verification} ms`);
    log(doctor?.ok ? 'STATUS: OK — Restart Codex to load [mcp_servers.inline-review].' : 'STATUS: UNVERIFIED — run doctor before use.');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const cli = quote(cliEntry);
    const node = quote(nodeBin);
    const home = ` --codex-home ${quote(codexHome)}`;
    log(`Doctor: ${node} --no-warnings ${cli} doctor${home}`);
    log(`Demo: ${node} --no-warnings ${cli} serve ${quote(path.join(installRoot, 'examples', 'demo.html'))}`);
    log(`Review: ${node} --no-warnings ${cli} serve /path/to/page.html`);
    log(`Uninstall: ${node} --no-warnings ${cli} uninstall${home}`);
  }

  return {
    codexHome,
    installRoot,
    cliEntry,
    nodeBin,
    relocated: shouldCopy,
    doctor,
  };
}

export function uninstallFromCodex(options?: UninstallOptions): UninstallResult {
  const codexHome = resolveCodexHome(options?.codexHome);
  const manifestPath = path.join(codexHome, MANIFEST);
  const legacyRoot = path.join(codexHome, 'tools', 'codex-markup');
  const legacyManaged = isLegacyManagedRuntime(legacyRoot, codexHome);
  const installation = readInstallation(manifestPath) ??
    (legacyManaged ? { runtimeRoot: legacyRoot, codexHome, managed: true } : undefined);
  let removedConfigSection = false;
  let removedSkillDir = false;
  let removedAgentsBlock = false;
  let removedRuntimeDir = false;

  const configPath = path.join(codexHome, 'config.toml');
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    if (MCP_SECTION_RE.test(raw)) {
      const cleaned = raw
        .replace(MCP_SECTION_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      fs.writeFileSync(configPath, cleaned ? `${cleaned}\n` : '', 'utf8');
      removedConfigSection = true;
      console.log(`✓ Removed [mcp_servers.inline-review] from ${configPath}`);
    }
  }

  const skillDir = path.join(codexHome, 'skills', 'inline-html-review');
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    removedSkillDir = true;
    console.log(`✓ Removed skill directory ${skillDir}`);
  }

  const agentsPath = path.join(codexHome, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    const raw = fs.readFileSync(agentsPath, 'utf8');
    if (AGENTS_MARKER_RE.test(raw)) {
      const cleaned = raw
        .replace(AGENTS_MARKER_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      fs.writeFileSync(agentsPath, cleaned ? `${cleaned}\n` : '', 'utf8');
      removedAgentsBlock = true;
      console.log(`✓ Removed inline-review instructions from ${agentsPath}`);
    }
  }

  if (!options?.keepRuntime && installation?.managed && installation.codexHome === codexHome &&
      (ownsRuntime(installation.runtimeRoot, codexHome) || (legacyManaged && installation.runtimeRoot === legacyRoot))) {
    fs.rmSync(installation.runtimeRoot, { recursive: true, force: true });
    removedRuntimeDir = true;
    console.log(`✓ Removed runtime directory ${installation.runtimeRoot}`);
  }
  if (!options?.keepRuntime && fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
  console.log('Restart Codex to unload the integration; existing preview servers must be closed separately.');

  console.log(`✓ Uninstalled codex-markup from ${codexHome}`);
  return {
    codexHome,
    removedConfigSection,
    removedSkillDir,
    removedAgentsBlock,
    removedRuntimeDir,
  };
}
