import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const EXPECTED_MCP_TOOLS = [
  'open_html_review',
  'wait_for_review',
  'get_inline_comments',
  'reply_to_comment',
  'reply_to_comments',
  'resolve_comment',
];

export const DEFAULT_REPO_URL = 'https://github.com/chkche1/codex-markup.git';
export const DEFAULT_BRANCH = 'main';
export const DEFAULT_TARBALL_URL =
  'https://github.com/chkche1/codex-markup/archive/refs/heads/main.tar.gz';

const RUNTIME_ENTRIES = [
  'package.json',
  'bin',
  'src',
  'skills',
  'examples/demo.html',
  'README.md',
  'LICENSE',
] as const;

const SYNCED_RUNTIME_DIRS = ['bin', 'src', 'skills'] as const;
const SYNCED_RUNTIME_FILES = ['package.json', 'examples/demo.html', 'README.md', 'LICENSE'] as const;

const MCP_SECTION_RE =
  /\[mcp_servers\.(?:inline-review|"inline-review"|'inline-review')\][\s\S]*?(?=\n\[|\s*$)/;
const AGENTS_MARKER_START = '<!-- BEGIN CODEX-INLINE-REVIEW -->';
const AGENTS_MARKER_END = '<!-- END CODEX-INLINE-REVIEW -->';
const AGENTS_MARKER_RE = new RegExp(`${AGENTS_MARKER_START}[\\s\\S]*?${AGENTS_MARKER_END}`, 'm');

const MANIFEST = 'codex-markup-install.json';
const OWNER_MARKER = '.codex-markup-owned.json';

export type SkillScope = 'codex' | 'agents';
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface InstallArtifacts {
  skillScope: SkillScope;
  skillDir: string;
  skillFiles: Record<string, string>;
  agentsBlockSha256: string;
  configMcpSha256: string;
}

export interface InstallManifestV1 {
  schemaVersion?: 1;
  runtimeRoot: string;
  codexHome: string;
  managed: boolean;
}

export interface InstallManifestV2 {
  schemaVersion: 2;
  runtimeRoot: string;
  codexHome: string;
  managed: boolean;
  version: string;
  runtimeSha256: string;
  sourceCommit?: string;
  sourceRepo?: string;
  sourceBranch?: string;
  tarballUrl?: string;
  tarballEtag?: string;
  installedAt: string;
  artifacts: InstallArtifacts;
}

export type InstallationManifest = InstallManifestV1 | InstallManifestV2;

/** Error thrown when installing, syncing, or updating would overwrite local user edits without --force. */
export class UserCustomizationError extends Error {
  readonly customizedFiles: string[];

  constructor(customizedFiles: string[], message?: string) {
    super(
      message ||
        `Refusing to overwrite locally customized file(s): ${customizedFiles.join(', ')}. Re-run with --force to overwrite.`
    );
    this.name = 'UserCustomizationError';
    this.customizedFiles = customizedFiles;
  }
}

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  detail: string;
}

export interface DoctorOptions {
  codexHome?: string;
  quiet?: boolean;
  json?: boolean;
  timeoutMs?: number;
  agentsDir?: string;
}

export interface DoctorReport {
  ok: boolean;
  codexHome: string;
  checks: DoctorCheck[];
  tools: string[];
  managed?: boolean;
  needsSync?: boolean;
  customizedFiles?: string[];
  skillScope?: SkillScope;
  skillDir?: string;
  runtimeRoot?: string;
  version?: string;
}

export interface InstallOptions {
  codexHome?: string;
  copy?: boolean;
  installDir?: string;
  skipVerify?: boolean;
  sourceRoot?: string;
  nodeBin?: string;
  json?: boolean;
  skillScope?: SkillScope;
  agentsDir?: string;
  force?: boolean;
}

export interface InstallResult {
  codexHome: string;
  installRoot: string;
  cliEntry: string;
  nodeBin: string;
  relocated: boolean;
  skillScope?: SkillScope;
  skillDir?: string;
  manifest?: InstallManifestV2;
  doctor?: DoctorReport;
}

export interface UninstallOptions {
  codexHome?: string;
  keepRuntime?: boolean;
  agentsDir?: string;
  json?: boolean;
}

export interface UninstallResult {
  codexHome: string;
  removedConfigSection: boolean;
  removedSkillDir: boolean;
  removedAgentsBlock: boolean;
  removedRuntimeDir: boolean;
  removedSkillDirs?: string[];
}

export interface SyncOptions {
  codexHome?: string;
  skillScope?: SkillScope;
  agentsDir?: string;
  force?: boolean;
  skipVerify?: boolean;
  json?: boolean;
  nodeBin?: string;
}

export interface SyncResult {
  status: 'synced' | 'up-to-date';
  codexHome: string;
  runtimeRoot: string;
  managed: boolean;
  version: string;
  runtimeSha256: string;
  skillScope: SkillScope;
  skillDir: string;
  updatedFiles: string[];
  needsSync: boolean;
  customizedFiles: string[];
  restartRequired: boolean;
  doctor?: DoctorReport;
}

export interface UpdateOptions {
  codexHome?: string;
  check?: boolean;
  from?: string;
  repo?: string;
  branch?: string;
  tarballUrl?: string;
  force?: boolean;
  skipVerify?: boolean;
  json?: boolean;
  skillScope?: SkillScope;
  agentsDir?: string;
  nodeBin?: string;
}

export interface UpdateCheckResult {
  mode: 'check';
  status: 'up-to-date' | 'update-available' | 'sync-needed';
  codexHome: string;
  runtimeRoot: string;
  managed: boolean;
  currentVersion: string;
  currentCommit?: string;
  currentRuntimeSha256: string;
  remoteCommit?: string;
  remoteEtag?: string;
  remoteVersion?: string;
  sourceType: 'dir' | 'tarball' | 'git' | 'tarball-http';
  sourceLocation: string;
  updateAvailable: boolean;
  needsSync: boolean;
  customizedFiles: string[];
  reasons: string[];
}

export interface UpdateApplyResult {
  mode: 'apply';
  status: 'updated' | 'up-to-date' | 'synced';
  codexHome: string;
  runtimeRoot: string;
  managed: boolean;
  previousVersion: string;
  version: string;
  previousCommit?: string;
  sourceCommit?: string;
  runtimeSha256: string;
  skillScope: SkillScope;
  skillDir: string;
  needsSync: boolean;
  customizedFiles: string[];
  restartRequired: boolean;
  doctor?: DoctorReport;
}

export interface TargetSkillLocation {
  skillScope: SkillScope;
  skillDir: string;
  agentsRoot?: string;
  explicitAgentsDir?: string;
  isolatedFromHomeAgents: boolean;
}

export interface InstalledRuntimeState {
  installed: boolean;
  codexHome: string;
  runtimeRoot?: string;
  cliEntry?: string;
  managed: boolean;
  owned: boolean;
  manifest?: InstallationManifest;
  manifestV2?: InstallManifestV2;
  skillScope: SkillScope;
  skillDir: string;
  agentsRoot?: string;
  parsedMcp: { command: string; args: string[] } | null;
}

export interface ArtifactDriftReport {
  hasManifestV2: boolean;
  isV1OrLegacy: boolean;
  needsSync: boolean;
  behindFiles: string[];
  customizedFiles: string[];
  skillScope: SkillScope;
  skillDir: string;
  expectedSkillFiles: Record<string, string>;
  expectedAgentsHash: string;
  expectedConfigHash: string;
}

interface SkillDirSnapshot {
  dir: string;
  existed: boolean;
  files: Map<string, Buffer>;
}

interface CodexArtifactsSnapshot {
  files: Map<string, Buffer | null>;
  skillDirs: SkillDirSnapshot[];
}

function cleanEnvValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const norm = value.trim().toLowerCase();
  return norm === '1' || norm === 'true' || norm === 'yes';
}

function isForceEnabled(explicitForce?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(explicitForce || isTruthyEnv(env.CODEX_MARKUP_FORCE));
}

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function shouldIgnoreTreeEntry(name: string): boolean {
  return (
    name === '.git' ||
    name === 'node_modules' ||
    name === OWNER_MARKER ||
    name === '.DS_Store' ||
    name.endsWith('.comments.json')
  );
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function collectFilesSorted(baseDir: string, currentRel: string, out: string[]): void {
  const abs = currentRel ? path.join(baseDir, currentRel) : baseDir;
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(abs);
  } catch {
    return;
  }
  const baseName = path.basename(abs);
  if (currentRel && shouldIgnoreTreeEntry(baseName)) {
    return;
  }
  if (lstat.isSymbolicLink()) {
    return;
  }
  if (lstat.isFile()) {
    out.push(currentRel.split(path.sep).join('/'));
    return;
  }
  if (lstat.isDirectory()) {
    const children = fs.readdirSync(abs).sort(compareAscii);
    for (const child of children) {
      if (shouldIgnoreTreeEntry(child)) continue;
      const childRel = currentRel ? path.join(currentRel, child) : child;
      collectFilesSorted(baseDir, childRel, out);
    }
  }
}

/** Computes a deterministic SHA-256 digest across the shipped runtime entries. */
export function computeRuntimeSha256(runtimeRoot: string): string {
  const resolved = path.resolve(runtimeRoot);
  const relFiles: string[] = [];
  for (const entry of RUNTIME_ENTRIES) {
    const abs = path.join(resolved, entry);
    if (!fs.existsSync(abs)) continue;
    collectFilesSorted(resolved, entry, relFiles);
  }
  relFiles.sort(compareAscii);
  const hash = crypto.createHash('sha256');
  for (const relPosix of relFiles) {
    const abs = path.join(resolved, ...relPosix.split('/'));
    const data = fs.readFileSync(abs);
    hash.update(relPosix);
    hash.update('\0');
    hash.update(String(data.byteLength));
    hash.update('\0');
    hash.update(data);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function readPackageVersion(runtimeRoot: string): string {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
    if (pkg && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    // Fallback below
  }
  return 'unknown';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const entry of Object.values(value)) {
    if (typeof entry !== 'string') return false;
  }
  return true;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === 'string' && val.trim().length > 0 ? val : undefined;
}

/** Reads and validates a v1 or v2 installation manifest without trusting malformed shapes. */
export function readInstallManifest(filePath: string): InstallationManifest | undefined {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const obj = raw as Record<string, unknown>;
    if (
      typeof obj.runtimeRoot !== 'string' ||
      typeof obj.codexHome !== 'string' ||
      typeof obj.managed !== 'boolean'
    ) {
      return undefined;
    }

    if (obj.schemaVersion === undefined || obj.schemaVersion === 1) {
      return {
        ...(obj.schemaVersion === 1 ? { schemaVersion: 1 as const } : {}),
        runtimeRoot: obj.runtimeRoot,
        codexHome: obj.codexHome,
        managed: obj.managed,
      };
    }

    if (obj.schemaVersion === 2) {
      const artifacts = obj.artifacts;
      if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) return undefined;
      const artObj = artifacts as Record<string, unknown>;
      if (
        typeof obj.version !== 'string' ||
        typeof obj.runtimeSha256 !== 'string' ||
        typeof obj.installedAt !== 'string' ||
        (artObj.skillScope !== 'codex' && artObj.skillScope !== 'agents') ||
        typeof artObj.skillDir !== 'string' ||
        !isStringRecord(artObj.skillFiles) ||
        typeof artObj.agentsBlockSha256 !== 'string' ||
        typeof artObj.configMcpSha256 !== 'string'
      ) {
        return undefined;
      }

      return {
        schemaVersion: 2,
        runtimeRoot: obj.runtimeRoot,
        codexHome: obj.codexHome,
        managed: obj.managed,
        version: obj.version,
        runtimeSha256: obj.runtimeSha256,
        ...(optionalString(obj, 'sourceCommit') ? { sourceCommit: optionalString(obj, 'sourceCommit') } : {}),
        ...(optionalString(obj, 'sourceRepo') ? { sourceRepo: optionalString(obj, 'sourceRepo') } : {}),
        ...(optionalString(obj, 'sourceBranch') ? { sourceBranch: optionalString(obj, 'sourceBranch') } : {}),
        ...(optionalString(obj, 'tarballUrl') ? { tarballUrl: optionalString(obj, 'tarballUrl') } : {}),
        ...(optionalString(obj, 'tarballEtag') ? { tarballEtag: optionalString(obj, 'tarballEtag') } : {}),
        installedAt: obj.installedAt,
        artifacts: {
          skillScope: artObj.skillScope,
          skillDir: artObj.skillDir,
          skillFiles: { ...artObj.skillFiles },
          agentsBlockSha256: artObj.agentsBlockSha256,
          configMcpSha256: artObj.configMcpSha256,
        },
      };
    }
  } catch {
    // An absent or invalid manifest never authorizes runtime removal.
  }
  return undefined;
}

function readOwnerMarker(runtimeRoot: string): InstallManifestV1 | undefined {
  const manifest = readInstallManifest(path.join(runtimeRoot, OWNER_MARKER));
  if (!manifest) return undefined;
  return {
    runtimeRoot: manifest.runtimeRoot,
    codexHome: manifest.codexHome,
    managed: manifest.managed,
  };
}

function ownsRuntime(runtimeRoot: string, codexHome: string): boolean {
  const resolvedRuntime = path.resolve(runtimeRoot);
  const resolvedHome = path.resolve(codexHome);
  const owner = readOwnerMarker(resolvedRuntime);
  if (!owner?.managed) return false;
  if (owner.runtimeRoot !== resolvedRuntime || owner.codexHome !== resolvedHome) return false;
  try {
    return !fs.lstatSync(resolvedRuntime).isSymbolicLink();
  } catch {
    return false;
  }
}

function isLegacyManagedRuntime(runtimeRoot: string, codexHome: string): boolean {
  const resolvedRuntime = path.resolve(runtimeRoot);
  const resolvedHome = path.resolve(codexHome);
  if (resolvedRuntime !== path.join(resolvedHome, 'tools', 'codex-markup') || !fs.existsSync(resolvedRuntime)) {
    return false;
  }
  try {
    if (fs.lstatSync(resolvedRuntime).isSymbolicLink()) return false;
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(resolvedRuntime, 'package.json'), 'utf8'));
    const config = extractMcpServerConfig(fs.readFileSync(path.join(resolvedHome, 'config.toml'), 'utf8'));
    return Boolean(
      pkg &&
        typeof pkg === 'object' &&
        'name' in pkg &&
        pkg.name === 'codex-markup' &&
        config?.args.includes(path.join(resolvedRuntime, 'src', 'cli.ts'))
    );
  } catch {
    return false;
  }
}

/** Checks whether a Node.js version string meets the 22.18+ (22.x) or 24+ requirement. */
export function isSupportedNodeVersion(versionStr: string): boolean {
  const match = versionStr.trim().match(/^v?(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 24 || (major === 22 && minor >= 18);
}

/** Resolves the Codex configuration home directory from flag, env, or default ~/.codex. */
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

/** Returns the running Node executable when its version is supported. */
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
  return normCandidate === normParent || normCandidate.startsWith(normParent + path.sep);
}

/** Detects temporary, npx, pnpm dlx, or bun cache checkout directories that should relocate on install. */
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

function isValidSkillLeafDir(skillDir: string): boolean {
  const resolved = path.resolve(skillDir);
  return (
    path.basename(resolved) === 'inline-html-review' &&
    path.basename(path.dirname(resolved)) === 'skills'
  );
}

function deriveAgentsRootFromSkillDir(skillDir: string): string | undefined {
  const resolved = path.resolve(skillDir);
  if (!isValidSkillLeafDir(resolved)) return undefined;
  return path.dirname(path.dirname(resolved));
}

/** Resolves the target skill scope and directory while keeping --codex-home isolated from real ~/.agents. */
export function resolveTargetSkillLocation(
  codexHome: string,
  options?: {
    skillScope?: SkillScope;
    agentsDir?: string;
    env?: NodeJS.ProcessEnv;
    prevManifest?: InstallationManifest;
  }
): TargetSkillLocation {
  const env = options?.env ?? process.env;
  const resolvedHome = path.resolve(codexHome);
  const defaultCodexHome = path.resolve(os.homedir(), '.codex');
  const explicitAgentsDir = cleanEnvValue(options?.agentsDir) ?? cleanEnvValue(env.CODEX_MARKUP_AGENTS_DIR);
  const prevV2 = options?.prevManifest?.schemaVersion === 2 ? options.prevManifest : undefined;

  let skillScope: SkillScope;
  if (options?.skillScope !== undefined) {
    if (options.skillScope !== 'codex' && options.skillScope !== 'agents') {
      throw new Error(`Invalid skill scope "${String(options.skillScope)}". Expected "codex" or "agents".`);
    }
    skillScope = options.skillScope;
  } else if (explicitAgentsDir) {
    skillScope = 'agents';
  } else if (prevV2) {
    skillScope = prevV2.artifacts.skillScope;
  } else {
    skillScope = 'codex';
  }

  if (skillScope === 'agents') {
    const agentsRoot = explicitAgentsDir
      ? path.resolve(explicitAgentsDir)
      : (prevV2?.artifacts.skillScope === 'agents'
          ? deriveAgentsRootFromSkillDir(prevV2.artifacts.skillDir)
          : undefined) ?? path.join(os.homedir(), '.agents');
    return {
      skillScope,
      skillDir: path.join(agentsRoot, 'skills', 'inline-html-review'),
      agentsRoot,
      explicitAgentsDir: explicitAgentsDir ? path.resolve(explicitAgentsDir) : undefined,
      isolatedFromHomeAgents: false,
    };
  }

  return {
    skillScope: 'codex',
    skillDir: path.join(resolvedHome, 'skills', 'inline-html-review'),
    agentsRoot: explicitAgentsDir ? path.resolve(explicitAgentsDir) : undefined,
    explicitAgentsDir: explicitAgentsDir ? path.resolve(explicitAgentsDir) : undefined,
    isolatedFromHomeAgents: resolvedHome !== defaultCodexHome && !explicitAgentsDir,
  };
}

/** Inspects the installed manifest, config.toml, and active skill scope for a Codex home directory. */
export function resolveInstalledRuntimeState(
  codexHome: string,
  options?: { agentsDir?: string; env?: NodeJS.ProcessEnv }
): InstalledRuntimeState {
  const env = options?.env ?? process.env;
  const resolvedHome = path.resolve(codexHome);
  const defaultCodexHome = path.resolve(os.homedir(), '.codex');
  const manifest = readInstallManifest(path.join(resolvedHome, MANIFEST));
  const manifestV2 = manifest?.schemaVersion === 2 ? manifest : undefined;

  const configPath = path.join(resolvedHome, 'config.toml');
  let parsedMcp: { command: string; args: string[] } | null = null;
  if (fs.existsSync(configPath)) {
    try {
      parsedMcp = extractMcpServerConfig(fs.readFileSync(configPath, 'utf8'));
    } catch {
      parsedMcp = null;
    }
  }

  const cliArg = parsedMcp ? findCliScriptArg(parsedMcp.args) : undefined;
  const legacyDefaultRoot = path.join(resolvedHome, 'tools', 'codex-markup');
  let runtimeRoot: string | undefined;
  if (manifest) {
    runtimeRoot = path.resolve(manifest.runtimeRoot);
  } else if (cliArg) {
    runtimeRoot = path.dirname(path.dirname(path.resolve(cliArg)));
  } else if (isLegacyManagedRuntime(legacyDefaultRoot, resolvedHome)) {
    runtimeRoot = legacyDefaultRoot;
  }

  const owned = Boolean(
    runtimeRoot && (ownsRuntime(runtimeRoot, resolvedHome) || isLegacyManagedRuntime(runtimeRoot, resolvedHome))
  );
  const managed = manifest ? manifest.managed : owned;
  const installed = Boolean(manifest || parsedMcp || owned);

  const codexSkillDir = path.join(resolvedHome, 'skills', 'inline-html-review');
  const explicitAgentsDir = cleanEnvValue(options?.agentsDir) ?? cleanEnvValue(env.CODEX_MARKUP_AGENTS_DIR);

  let skillScope: SkillScope = 'codex';
  let skillDir = codexSkillDir;
  let agentsRoot: string | undefined = explicitAgentsDir ? path.resolve(explicitAgentsDir) : undefined;

  if (manifestV2) {
    skillScope = manifestV2.artifacts.skillScope;
    skillDir = path.resolve(manifestV2.artifacts.skillDir);
    if (skillScope === 'agents') {
      agentsRoot = deriveAgentsRootFromSkillDir(skillDir) ?? agentsRoot;
    }
  } else if (!fs.existsSync(path.join(codexSkillDir, 'SKILL.md'))) {
    const candidateAgentsRoot =
      agentsRoot ?? (resolvedHome === defaultCodexHome ? path.join(os.homedir(), '.agents') : undefined);
    if (candidateAgentsRoot) {
      const candidateSkillDir = path.join(candidateAgentsRoot, 'skills', 'inline-html-review');
      if (fs.existsSync(path.join(candidateSkillDir, 'SKILL.md'))) {
        skillScope = 'agents';
        skillDir = candidateSkillDir;
        agentsRoot = candidateAgentsRoot;
      }
    }
  }

  return {
    installed,
    codexHome: resolvedHome,
    runtimeRoot,
    cliEntry: runtimeRoot ? path.join(runtimeRoot, 'src', 'cli.ts') : undefined,
    managed,
    owned,
    manifest,
    manifestV2,
    skillScope,
    skillDir,
    agentsRoot,
    parsedMcp,
  };
}

function syncDirectoryTree(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) {
    if (fs.existsSync(dstDir)) {
      fs.rmSync(dstDir, { recursive: true, force: true });
    }
    return;
  }

  if (fs.existsSync(dstDir)) {
    const dstStat = fs.lstatSync(dstDir);
    if (dstStat.isSymbolicLink() || !dstStat.isDirectory()) {
      fs.rmSync(dstDir, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(dstDir, { recursive: true });

  const srcEntries = new Set(
    fs.readdirSync(srcDir).filter((name) => !shouldIgnoreTreeEntry(name))
  );

  for (const existing of fs.readdirSync(dstDir)) {
    if (!srcEntries.has(existing)) {
      fs.rmSync(path.join(dstDir, existing), { recursive: true, force: true });
    }
  }

  for (const name of Array.from(srcEntries).sort(compareAscii)) {
    const srcPath = path.join(srcDir, name);
    const dstPath = path.join(dstDir, name);
    const srcStat = fs.lstatSync(srcPath);
    if (srcStat.isSymbolicLink()) {
      continue;
    }
    if (srcStat.isDirectory()) {
      syncDirectoryTree(srcPath, dstPath);
    } else if (srcStat.isFile()) {
      if (fs.existsSync(dstPath)) {
        const dstStat = fs.lstatSync(dstPath);
        if (dstStat.isSymbolicLink() || dstStat.isDirectory()) {
          fs.rmSync(dstPath, { recursive: true, force: true });
        }
      }
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

/** Copies runtime files to targetDir, pruning stale files inside bin/, src/, and skills/. */
export function copyRuntimeToDir(sourceRoot: string, targetDir: string): void {
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedTarget = path.resolve(targetDir);
  if (
    resolvedSource !== resolvedTarget &&
    (isWithinDir(resolvedTarget, resolvedSource) || isWithinDir(resolvedSource, resolvedTarget))
  ) {
    throw new Error('Runtime source and destination must not contain one another');
  }
  if (fs.existsSync(resolvedTarget) && fs.lstatSync(resolvedTarget).isSymbolicLink()) {
    throw new Error(`Refusing to copy runtime into symlink directory: ${resolvedTarget}`);
  }
  if (
    resolvedSource === resolvedTarget ||
    (fs.existsSync(resolvedTarget) && safeRealpath(resolvedSource) === safeRealpath(resolvedTarget))
  ) {
    return;
  }

  fs.mkdirSync(resolvedTarget, { recursive: true });

  for (const dirEntry of SYNCED_RUNTIME_DIRS) {
    syncDirectoryTree(path.join(resolvedSource, dirEntry), path.join(resolvedTarget, dirEntry));
  }

  for (const fileEntry of SYNCED_RUNTIME_FILES) {
    const srcPath = path.join(resolvedSource, fileEntry);
    if (!fs.existsSync(srcPath)) continue;
    const dstPath = path.join(resolvedTarget, fileEntry);
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    if (fs.existsSync(dstPath) && fs.lstatSync(dstPath).isSymbolicLink()) {
      fs.unlinkSync(dstPath);
    }
    fs.copyFileSync(srcPath, dstPath);
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

/** Builds rendered skill files (substituting CLI path in SKILL.md) and their SHA-256 hashes. */
export function buildSkillArtifacts(
  installRoot: string,
  cliEntry: string
): { files: Map<string, Buffer>; hashes: Record<string, string> } {
  const sourceSkillDir = path.join(path.resolve(installRoot), 'skills', 'inline-html-review');
  const mainSkillFile = path.join(sourceSkillDir, 'SKILL.md');
  if (!fs.existsSync(mainSkillFile)) {
    throw new Error(`Missing source skill template: ${mainSkillFile}`);
  }

  const relFiles: string[] = [];
  collectFilesSorted(sourceSkillDir, '', relFiles);
  relFiles.sort(compareAscii);

  const files = new Map<string, Buffer>();
  const hashes: Record<string, string> = {};

  for (const relPosix of relFiles) {
    const absPath = path.join(sourceSkillDir, ...relPosix.split('/'));
    let content: Buffer;
    if (relPosix === 'SKILL.md') {
      const raw = fs.readFileSync(absPath, 'utf8');
      const rendered = raw
        .replaceAll('<path-to-codex-markup>/src/cli.ts', cliEntry)
        .replaceAll('<path-to-codex-inline-review>/src/cli.ts', cliEntry);
      content = Buffer.from(rendered, 'utf8');
    } else {
      content = fs.readFileSync(absPath);
    }
    files.set(relPosix, content);
    hashes[relPosix] = sha256Buffer(content);
  }

  return { files, hashes };
}

function pruneStaleSkillEntries(dir: string, currentRel: string, expectedFiles: Map<string, Buffer>): boolean {
  let changed = false;
  for (const entry of fs.readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const rel = currentRel ? `${currentRel}/${entry}` : entry;
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(abs);
      changed = true;
      continue;
    }
    if (stat.isDirectory()) {
      const keepPrefix = `${rel}/`;
      const hasDescendant = Array.from(expectedFiles.keys()).some((k) => k.startsWith(keepPrefix));
      if (!hasDescendant) {
        fs.rmSync(abs, { recursive: true, force: true });
        changed = true;
      } else if (pruneStaleSkillEntries(abs, rel, expectedFiles)) {
        changed = true;
      }
    } else if (!expectedFiles.has(rel)) {
      fs.unlinkSync(abs);
      changed = true;
    }
  }
  return changed;
}

/** Recursively installs skill files into targetSkillDir and prunes stale files/directories. */
export function syncSkillDirectory(targetSkillDir: string, artifacts: Map<string, Buffer>): string[] {
  const resolvedTarget = path.resolve(targetSkillDir);
  if (fs.existsSync(resolvedTarget) && fs.lstatSync(resolvedTarget).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlink skill directory: ${resolvedTarget}`);
  }
  fs.mkdirSync(resolvedTarget, { recursive: true });

  const changedFiles: string[] = [];
  if (pruneStaleSkillEntries(resolvedTarget, '', artifacts)) {
    changedFiles.push('skills/inline-html-review (pruned)');
  }

  for (const [relPosix, content] of artifacts.entries()) {
    const absPath = path.join(resolvedTarget, ...relPosix.split('/'));
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    let same = false;
    if (fs.existsSync(absPath)) {
      const stat = fs.lstatSync(absPath);
      if (stat.isFile()) {
        same = fs.readFileSync(absPath).equals(content);
      } else {
        fs.rmSync(absPath, { recursive: true, force: true });
      }
    }
    if (!same) {
      fs.writeFileSync(absPath, content);
      changedFiles.push(absPath);
    }
  }
  return changedFiles;
}

function isOwnedExternalSkillDir(
  skillDir: string,
  codexHome: string,
  expectedRuntimeRoot?: string,
  expectedSkillHash?: string
): boolean {
  const resolved = path.resolve(skillDir);
  if (!isValidSkillLeafDir(resolved) || !fs.existsSync(resolved)) return false;
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  if (isWithinDir(resolved, codexHome)) return true;
  const skillFile = path.join(resolved, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return false;
  try {
    const content = fs.readFileSync(skillFile);
    if (expectedSkillHash && sha256Buffer(content) === expectedSkillHash) return true;
    const text = content.toString('utf8');
    if (expectedRuntimeRoot && text.includes(path.join(expectedRuntimeRoot, 'src', 'cli.ts'))) {
      return true;
    }
    return text.includes('# Inline HTML Review Skill (`codex-markup`)');
  } catch {
    return false;
  }
}

/** Removes a previously owned skill directory when switching skill scopes without touching parent dirs. */
export function cleanupOwnedOldSkillDir(
  oldSkillDir: string | undefined,
  newSkillDir: string,
  codexHome: string,
  explicitAgentsDir?: string,
  expectedRuntimeRoot?: string,
  expectedSkillHash?: string
): boolean {
  if (!oldSkillDir) return false;
  const resolvedOld = path.resolve(oldSkillDir);
  const resolvedNew = path.resolve(newSkillDir);
  if (resolvedOld === resolvedNew) return false;
  if (!isValidSkillLeafDir(resolvedOld)) return false;
  if (!fs.existsSync(resolvedOld)) return false;

  const insideCodexOrExplicit =
    isWithinDir(resolvedOld, codexHome) ||
    Boolean(explicitAgentsDir && isWithinDir(resolvedOld, explicitAgentsDir));
  if (
    !insideCodexOrExplicit &&
    !isOwnedExternalSkillDir(resolvedOld, codexHome, expectedRuntimeRoot, expectedSkillHash)
  ) {
    return false;
  }

  try {
    if (fs.lstatSync(resolvedOld).isSymbolicLink()) return false;
  } catch {
    return false;
  }

  fs.rmSync(resolvedOld, { recursive: true, force: true });
  return true;
}

function buildMcpTomlBlock(nodeBin: string, cliEntry: string): string {
  return [
    `[mcp_servers.inline-review]`,
    `command = ${JSON.stringify(nodeBin)}`,
    `args = ["--no-warnings", ${JSON.stringify(cliEntry)}, "mcp"]`,
  ].join('\n');
}

function buildAgentsSnippet(): string {
  return [
    AGENTS_MARKER_START,
    `## Inline HTML Preview & Commenting (\`inline-review\` MCP)`,
    `Whenever you generate or update an HTML file/artifact for the user, or when the user asks to preview an HTML page or address inline comments:`,
    `1. Call the \`open_html_review\` MCP tool with \`file_path\` to open the live browser preview with inline text & DOM commenting.`,
    `2. Call \`wait_for_review\` (or pass \`wait_for_submission: true\` to \`open_html_review\`) to wait for the user to click **"🚀 Submit to Codex"** in the browser, or call \`get_inline_comments\` when asked to check comments.`,
    `3. Edit the HTML file to address each comment and reply using \`reply_to_comments\` (for multiple comments in one batch) or \`reply_to_comment\` (for a single thread) with \`comment_id\` (e.g. \`c-1\`), your explanation/answer, and \`status: "resolved"\` (or \`"answered"\` for questions).`,
    AGENTS_MARKER_END,
  ].join('\n');
}

function scanSkillDirHashes(skillDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(skillDir)) return result;
  const relFiles: string[] = [];
  collectFilesSorted(skillDir, '', relFiles);
  for (const relPosix of relFiles) {
    const abs = path.join(skillDir, ...relPosix.split('/'));
    result[relPosix] = sha256Buffer(fs.readFileSync(abs));
  }
  return result;
}

/** Compares installed Codex artifacts against manifest v2 baselines and expected runtime outputs. */
export function inspectArtifactDrift(options: {
  codexHome: string;
  runtimeRoot: string;
  cliEntry: string;
  nodeBin: string;
  skillDir: string;
  skillScope: SkillScope;
  prevManifest?: InstallationManifest;
  checkOldSkillDir?: boolean;
}): ArtifactDriftReport {
  const {
    codexHome,
    runtimeRoot,
    cliEntry,
    nodeBin,
    skillDir,
    skillScope,
    prevManifest,
    checkOldSkillDir,
  } = options;
  const prevV2 = prevManifest?.schemaVersion === 2 ? prevManifest : undefined;
  const hasManifestV2 = Boolean(prevV2);
  const isV1OrLegacy = !hasManifestV2;

  const expectedSkill = buildSkillArtifacts(runtimeRoot, cliEntry);
  const expectedSkillFiles = expectedSkill.hashes;
  const expectedAgentsHash = sha256Text(buildAgentsSnippet());
  const expectedConfigHash = sha256Text(buildMcpTomlBlock(nodeBin, cliEntry).trim());

  const behindFiles: string[] = [];
  const customizedFiles: string[] = [];

  // 1. Skill folder drift
  if (!fs.existsSync(skillDir)) {
    behindFiles.push(path.join(skillDir, 'SKILL.md'));
  } else if (fs.lstatSync(skillDir).isSymbolicLink()) {
    customizedFiles.push(skillDir);
  } else {
    const diskSkillFiles = scanSkillDirHashes(skillDir);
    const prevMatchesTargetDir = Boolean(
      prevV2 && path.resolve(prevV2.artifacts.skillDir) === path.resolve(skillDir)
    );

    for (const [relPosix, expectedHash] of Object.entries(expectedSkillFiles)) {
      const diskHash = diskSkillFiles[relPosix];
      const displayPath = path.join(skillDir, ...relPosix.split('/'));
      if (!diskHash) {
        behindFiles.push(displayPath);
      } else if (diskHash !== expectedHash) {
        if (prevV2) {
          const manifestHash = prevMatchesTargetDir ? prevV2.artifacts.skillFiles[relPosix] : undefined;
          if (manifestHash && diskHash === manifestHash) {
            behindFiles.push(displayPath);
          } else {
            customizedFiles.push(displayPath);
          }
        } else {
          behindFiles.push(displayPath);
        }
      }
    }

    for (const relPosix of Object.keys(diskSkillFiles)) {
      if (!(relPosix in expectedSkillFiles)) {
        const displayPath = path.join(skillDir, ...relPosix.split('/'));
        if (prevV2 && (!prevMatchesTargetDir || !(relPosix in prevV2.artifacts.skillFiles))) {
          customizedFiles.push(displayPath);
        } else {
          behindFiles.push(displayPath);
        }
      }
    }
  }

  // Protect user edits in an old owned skill directory before scope switching deletes it.
  if (
    checkOldSkillDir &&
    prevV2 &&
    path.resolve(prevV2.artifacts.skillDir) !== path.resolve(skillDir) &&
    fs.existsSync(prevV2.artifacts.skillDir) &&
    !fs.lstatSync(prevV2.artifacts.skillDir).isSymbolicLink()
  ) {
    const oldDisk = scanSkillDirHashes(prevV2.artifacts.skillDir);
    for (const [relPosix, diskHash] of Object.entries(oldDisk)) {
      const oldManifestHash = prevV2.artifacts.skillFiles[relPosix];
      if (!oldManifestHash || diskHash !== oldManifestHash) {
        customizedFiles.push(path.join(prevV2.artifacts.skillDir, ...relPosix.split('/')));
      }
    }
  }

  // 2. AGENTS.md marker block drift
  const agentsPath = path.join(codexHome, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    behindFiles.push(agentsPath);
  } else {
    const agentsRaw = fs.readFileSync(agentsPath, 'utf8');
    const match = AGENTS_MARKER_RE.exec(agentsRaw);
    if (!match) {
      behindFiles.push(agentsPath);
    } else {
      const diskAgentsHash = sha256Text(match[0]);
      if (diskAgentsHash !== expectedAgentsHash) {
        if (prevV2) {
          if (diskAgentsHash === prevV2.artifacts.agentsBlockSha256) {
            behindFiles.push(agentsPath);
          } else {
            customizedFiles.push(agentsPath);
          }
        } else {
          behindFiles.push(agentsPath);
        }
      }
    }
  }

  // 3. config.toml [mcp_servers.inline-review] drift
  const configPath = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(configPath)) {
    behindFiles.push(configPath);
  } else {
    const configRaw = fs.readFileSync(configPath, 'utf8');
    const sectionMatch = MCP_SECTION_RE.exec(configRaw);
    if (!sectionMatch || sha256Text(sectionMatch[0].trim()) !== expectedConfigHash) {
      behindFiles.push(configPath);
    }
  }

  const runtimeChanged = prevV2 ? computeRuntimeSha256(runtimeRoot) !== prevV2.runtimeSha256 : false;
  const needsSync =
    isV1OrLegacy || behindFiles.length > 0 || customizedFiles.length > 0 || runtimeChanged;

  return {
    hasManifestV2,
    isV1OrLegacy,
    needsSync,
    behindFiles,
    customizedFiles,
    skillScope,
    skillDir,
    expectedSkillFiles,
    expectedAgentsHash,
    expectedConfigHash,
  };
}

function snapshotSkillDir(dir: string): SkillDirSnapshot {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    return { dir: resolved, existed: false, files: new Map() };
  }
  const files = new Map<string, Buffer>();
  const rels: string[] = [];
  collectFilesSorted(resolved, '', rels);
  for (const rel of rels) {
    files.set(rel, fs.readFileSync(path.join(resolved, ...rel.split('/'))));
  }
  return { dir: resolved, existed: true, files };
}

/** Captures config.toml, AGENTS.md, manifest, and skill directories so failures roll back cleanly. */
export function snapshotCodexArtifacts(
  codexHome: string,
  skillDirs: string[]
): CodexArtifactsSnapshot {
  const resolvedHome = path.resolve(codexHome);
  const filePaths = [
    path.join(resolvedHome, 'config.toml'),
    path.join(resolvedHome, 'AGENTS.md'),
    path.join(resolvedHome, MANIFEST),
  ];
  const files = new Map<string, Buffer | null>();
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath) && !fs.lstatSync(filePath).isSymbolicLink()) {
      files.set(filePath, fs.readFileSync(filePath));
    } else {
      files.set(filePath, null);
    }
  }

  const uniqueDirs = Array.from(new Set(skillDirs.map((d) => path.resolve(d))));
  const skillSnapshots = uniqueDirs.map((dir) => snapshotSkillDir(dir));
  return { files, skillDirs: skillSnapshots };
}

/** Restores Codex configuration files and skill directories from a snapshot taken before mutation. */
export function restoreCodexArtifacts(snapshot: CodexArtifactsSnapshot): void {
  for (const [filePath, prevBuf] of snapshot.files.entries()) {
    if (prevBuf === null) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } else {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, prevBuf);
    }
  }

  for (const snap of snapshot.skillDirs) {
    if (fs.existsSync(snap.dir) && !fs.lstatSync(snap.dir).isSymbolicLink()) {
      fs.rmSync(snap.dir, { recursive: true, force: true });
    }
    if (snap.existed) {
      fs.mkdirSync(snap.dir, { recursive: true });
      for (const [relPosix, buf] of snap.files.entries()) {
        const dst = path.join(snap.dir, ...relPosix.split('/'));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, buf);
      }
    }
  }
}

function readGitMetadata(repoRoot: string): { commit?: string; repo?: string; branch?: string } {
  const resolved = path.resolve(repoRoot);
  if (!fs.existsSync(path.join(resolved, '.git'))) {
    return {};
  }
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const runGit = (args: string[]): string | undefined => {
    try {
      const out = execFileSync('git', ['-C', resolved, ...args], {
        encoding: 'utf8',
        env: gitEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }).trim();
      return out.length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  };

  const commit = runGit(['rev-parse', 'HEAD']);
  const repo = runGit(['remote', 'get-url', 'origin']);
  const rawBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : undefined;
  return { commit, repo, branch };
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

function writeCodexConfigSection(configPath: string, tomlBlock: string): boolean {
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
  if (updatedConfig === existingConfig && fs.existsSync(configPath)) {
    return false;
  }
  fs.writeFileSync(configPath, updatedConfig, 'utf8');
  return true;
}

function writeAgentsMarkerBlock(agentsPath: string, agentsSnippet: string): boolean {
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
  if (updatedAgents === existingAgents && fs.existsSync(agentsPath)) {
    return false;
  }
  fs.writeFileSync(agentsPath, updatedAgents, 'utf8');
  return true;
}

/** Verifies Node.js version, Codex configuration, skill files, drift state, duplicates, and MCP handshake. */
export async function runDoctor(options?: DoctorOptions): Promise<DoctorReport> {
  const codexHome = resolveCodexHome(options?.codexHome);
  const installedState = resolveInstalledRuntimeState(codexHome, { agentsDir: options?.agentsDir });
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
  const parsedMcp = installedState.parsedMcp;
  if (!fs.existsSync(configPath)) {
    checks.push({
      name: 'config-toml',
      status: 'fail',
      detail: `Missing ${configPath}`,
    });
  } else if (parsedMcp) {
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

  // 3. Runtime cli.ts presence and permanence
  const cliArg = parsedMcp ? findCliScriptArg(parsedMcp.args) : undefined;
  let runtimeExists = false;
  let activeRuntimeRoot = installedState.runtimeRoot;
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
    activeRuntimeRoot = path.dirname(path.dirname(path.resolve(cliArg)));
    if (isEphemeralCheckoutPath(activeRuntimeRoot)) {
      checks.push({
        name: 'runtime-files',
        status: 'warn',
        detail: `Runtime path is in a temporary/ephemeral directory (${activeRuntimeRoot}); re-run install with --copy`,
      });
    } else {
      checks.push({
        name: 'runtime-files',
        status: 'pass',
        detail: `Runtime verified at ${cliArg}`,
      });
    }
  }

  // 4. Skill file (pointing at active skillDir/SKILL.md)
  const skillPath = path.join(installedState.skillDir, 'SKILL.md');
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

  // 7. Sync & customization drift check
  let needsSync = false;
  let customizedFiles: string[] = [];
  if (runtimeExists && activeRuntimeRoot && cliArg && parsedMcp && fs.existsSync(path.join(activeRuntimeRoot, 'skills', 'inline-html-review', 'SKILL.md'))) {
    const drift = inspectArtifactDrift({
      codexHome,
      runtimeRoot: activeRuntimeRoot,
      cliEntry: path.resolve(cliArg),
      nodeBin: parsedMcp.command,
      skillDir: installedState.skillDir,
      skillScope: installedState.skillScope,
      prevManifest: installedState.manifest,
      checkOldSkillDir: false,
    });
    needsSync = drift.needsSync;
    customizedFiles = drift.customizedFiles;

    if (drift.isV1OrLegacy) {
      checks.push({
        name: 'sync-drift',
        status: 'warn',
        detail:
          'Installed with v1/legacy manifest (missing SHA-256 artifact hashes); run "codex-markup sync" to upgrade manifest to v2',
      });
    } else if (drift.customizedFiles.length > 0 && drift.behindFiles.length > 0) {
      checks.push({
        name: 'sync-drift',
        status: 'warn',
        detail: `Local user edits (${drift.customizedFiles.join(', ')}) and behind-runtime drift (${drift.behindFiles.join(', ')}) detected; run "codex-markup sync --force" to overwrite`,
      });
    } else if (drift.customizedFiles.length > 0) {
      checks.push({
        name: 'sync-drift',
        status: 'warn',
        detail: `Local user edit(s) detected in ${drift.customizedFiles.join(', ')} (pass --force to overwrite on sync/update)`,
      });
    } else if (drift.needsSync) {
      const reasonList =
        drift.behindFiles.length > 0 ? drift.behindFiles.join(', ') : 'runtime files';
      checks.push({
        name: 'sync-drift',
        status: 'warn',
        detail: `Installed Codex artifacts are behind runtime (${reasonList}); run "codex-markup sync" to refresh`,
      });
    } else {
      checks.push({
        name: 'sync-drift',
        status: 'pass',
        detail: `Codex configuration and skill (${installedState.skillScope}) are in sync with runtime`,
      });
    }
  }

  // 8. Conditional duplicate skill check (only when default ~/.codex or agents scope/agentsDir is active)
  const defaultCodexHome = path.resolve(os.homedir(), '.codex');
  const explicitAgentsDir = cleanEnvValue(options?.agentsDir) ?? cleanEnvValue(process.env.CODEX_MARKUP_AGENTS_DIR);
  const checkDuplicates =
    path.resolve(codexHome) === defaultCodexHome ||
    installedState.skillScope === 'agents' ||
    Boolean(explicitAgentsDir);

  if (checkDuplicates) {
    const codexSkillPath = path.join(codexHome, 'skills', 'inline-html-review', 'SKILL.md');
    const resolvedAgentsRoot = explicitAgentsDir
      ? path.resolve(explicitAgentsDir)
      : installedState.agentsRoot ?? path.join(os.homedir(), '.agents');
    const agentsSkillPath = path.join(resolvedAgentsRoot, 'skills', 'inline-html-review', 'SKILL.md');

    if (
      fs.existsSync(codexSkillPath) &&
      fs.existsSync(agentsSkillPath) &&
      path.resolve(codexSkillPath) !== path.resolve(agentsSkillPath)
    ) {
      checks.push({
        name: 'skill-duplicates',
        status: 'warn',
        detail: `Duplicate inline-html-review skill found in both ${codexSkillPath} and ${agentsSkillPath}; remove one or re-run install with --skill-scope`,
      });
    } else {
      checks.push({
        name: 'skill-duplicates',
        status: 'pass',
        detail: 'No duplicate inline-html-review skill directories detected',
      });
    }
  }

  const ok = checks.every((c) => c.status !== 'fail');
  const version = activeRuntimeRoot ? readPackageVersion(activeRuntimeRoot) : undefined;
  const report: DoctorReport = {
    ok,
    codexHome,
    checks,
    tools,
    managed: installedState.managed,
    needsSync,
    customizedFiles,
    skillScope: installedState.skillScope,
    skillDir: installedState.skillDir,
    ...(activeRuntimeRoot ? { runtimeRoot: activeRuntimeRoot } : {}),
    ...(version ? { version } : {}),
  };

  if (!options?.quiet && !options?.json) {
    for (const check of checks) {
      const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
      console.log(`${icon} [${check.name}] ${check.detail}`);
    }
    console.log(ok ? 'STATUS: OK' : 'STATUS: FAILED');
  }

  return report;
}

/** Installs or updates Codex MCP config, recursive skill folder, AGENTS.md block, and Manifest v2. */
export async function installForCodex(options?: InstallOptions): Promise<InstallResult> {
  const started = performance.now();
  let phaseStart = started;
  const phaseMs: Record<string, number> = {};
  const phase = (name: string) => {
    const now = performance.now();
    phaseMs[name] = Math.round((now - phaseStart) * 100) / 100;
    phaseStart = now;
  };
  const log = (message: string) => {
    if (!options?.json) console.log(message);
  };

  const codexHome = resolveCodexHome(options?.codexHome);
  const sourceRoot = path.resolve(
    options?.sourceRoot || path.resolve(import.meta.dirname || '.', '..')
  );
  const nodeBin = options?.nodeBin ?? resolveInstallNodeBin();
  const force = isForceEnabled(options?.force);

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
  if (
    shouldCopy &&
    installRoot !== sourceRoot &&
    fs.existsSync(installRoot) &&
    !ownsRuntime(installRoot, codexHome) &&
    !isLegacyManagedRuntime(installRoot, codexHome) &&
    fs.readdirSync(installRoot).length > 0
  ) {
    throw new Error(`Refusing to overwrite an unowned runtime directory: ${installRoot}`);
  }

  const prevManifest = readInstallManifest(path.join(codexHome, MANIFEST));
  const targetSkill = resolveTargetSkillLocation(codexHome, {
    skillScope: options?.skillScope,
    agentsDir: options?.agentsDir,
    prevManifest,
  });
  const cliEntry = path.join(installRoot, 'src', 'cli.ts');

  // Enforce user-edit protection BEFORE mutating runtime or Codex configuration files.
  const preflightDrift = inspectArtifactDrift({
    codexHome,
    runtimeRoot: sourceRoot,
    cliEntry,
    nodeBin,
    skillDir: targetSkill.skillDir,
    skillScope: targetSkill.skillScope,
    prevManifest,
    checkOldSkillDir: true,
  });
  if (!force && preflightDrift.customizedFiles.length > 0) {
    throw new UserCustomizationError(preflightDrift.customizedFiles);
  }

  if (shouldCopy) {
    copyRuntimeToDir(sourceRoot, installRoot);
    log(
      `✓ Installed runtime files to ${installRoot}${ephemeral ? ' (relocated from ephemeral path)' : ''}`
    );
  }

  phase('runtime');
  fs.mkdirSync(codexHome, { recursive: true });

  const prevSkillDir =
    prevManifest?.schemaVersion === 2 ? prevManifest.artifacts.skillDir : undefined;
  const snapshot = snapshotCodexArtifacts(codexHome, [
    path.join(codexHome, 'skills', 'inline-html-review'),
    targetSkill.skillDir,
    ...(prevSkillDir ? [prevSkillDir] : []),
  ]);

  let doctor: DoctorReport | undefined;
  let manifestV2: InstallManifestV2;
  const managed =
    (shouldCopy && installRoot !== sourceRoot) ||
    ownsRuntime(installRoot, codexHome) ||
    isLegacyManagedRuntime(installRoot, codexHome);

  try {
    // 1. Configure ~/.codex/config.toml
    const configPath = path.join(codexHome, 'config.toml');
    const tomlBlock = buildMcpTomlBlock(nodeBin, cliEntry);
    writeCodexConfigSection(configPath, tomlBlock);
    log(`✓ Configured MCP server [mcp_servers.inline-review] in ${configPath}`);

    // 2. Install Skill folder recursively & prune stale/old-scope files
    const skillArtifacts = buildSkillArtifacts(installRoot, cliEntry);
    syncSkillDirectory(targetSkill.skillDir, skillArtifacts.files);
    const removedOldScope = cleanupOwnedOldSkillDir(
      prevSkillDir,
      targetSkill.skillDir,
      codexHome,
      targetSkill.explicitAgentsDir,
      prevManifest?.runtimeRoot,
      prevManifest?.schemaVersion === 2 ? prevManifest.artifacts.skillFiles['SKILL.md'] : undefined
    );
    log(`✓ Installed Codex skill (${targetSkill.skillScope}) to ${path.join(targetSkill.skillDir, 'SKILL.md')}`);
    if (removedOldScope && prevSkillDir) {
      log(`✓ Cleaned up previous skill directory ${prevSkillDir}`);
    }

    // 3. Add global instruction block to ~/.codex/AGENTS.md
    const agentsPath = path.join(codexHome, 'AGENTS.md');
    const agentsSnippet = buildAgentsSnippet();
    writeAgentsMarkerBlock(agentsPath, agentsSnippet);
    log(`✓ Updated global instructions in ${agentsPath}`);

    phase('registration');

    // 4. Write Manifest v2 (reading fresh git metadata from sourceRoot unless overridden by env)
    const freshGit = readGitMetadata(sourceRoot);
    const sourceCommit = cleanEnvValue(process.env.CODEX_MARKUP_SOURCE_COMMIT) ?? freshGit.commit;
    const sourceRepo = cleanEnvValue(process.env.CODEX_MARKUP_SOURCE_REPO) ?? freshGit.repo;
    const sourceBranch = cleanEnvValue(process.env.CODEX_MARKUP_SOURCE_BRANCH) ?? freshGit.branch;
    const tarballUrl = cleanEnvValue(process.env.CODEX_MARKUP_TARBALL_URL);
    const tarballEtag = cleanEnvValue(process.env.CODEX_MARKUP_TARBALL_ETAG);
    const installedAt = cleanEnvValue(process.env.CODEX_MARKUP_INSTALLED_AT) ?? new Date().toISOString();

    const version = readPackageVersion(installRoot);
    const runtimeSha256 = computeRuntimeSha256(installRoot);
    manifestV2 = {
      schemaVersion: 2,
      runtimeRoot: installRoot,
      codexHome,
      managed,
      version,
      runtimeSha256,
      ...(sourceCommit ? { sourceCommit } : {}),
      ...(sourceRepo ? { sourceRepo } : {}),
      ...(sourceBranch ? { sourceBranch } : {}),
      ...(tarballUrl ? { tarballUrl } : {}),
      ...(tarballEtag ? { tarballEtag } : {}),
      installedAt,
      artifacts: {
        skillScope: targetSkill.skillScope,
        skillDir: targetSkill.skillDir,
        skillFiles: skillArtifacts.hashes,
        agentsBlockSha256: sha256Text(agentsSnippet),
        configMcpSha256: sha256Text(tomlBlock.trim()),
      },
    };
    fs.writeFileSync(path.join(codexHome, MANIFEST), JSON.stringify(manifestV2, null, 2) + '\n');

    if (!options?.skipVerify) {
      doctor = await runDoctor({
        codexHome,
        quiet: true,
        agentsDir: targetSkill.explicitAgentsDir ?? targetSkill.agentsRoot,
      });
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

    if (managed) {
      fs.writeFileSync(
        path.join(installRoot, OWNER_MARKER),
        JSON.stringify({ runtimeRoot: installRoot, codexHome, managed: true }, null, 2) + '\n'
      );
    }
  } catch (err) {
    restoreCodexArtifacts(snapshot);
    throw err;
  }

  phase('verification');
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const resultPayload = {
    status: doctor?.ok ? 'verified' : 'unverified',
    version: manifestV2.version,
    runtimeRoot: installRoot,
    codexHome,
    managed,
    skillScope: targetSkill.skillScope,
    skillDir: targetSkill.skillDir,
    runtimeSha256: manifestV2.runtimeSha256,
    elapsedMs,
    phaseMs,
    restartRequired: true,
  };

  if (options?.json) {
    console.log(JSON.stringify(resultPayload));
  } else {
    log(`Installed codex-markup ${manifestV2.version} at ${installRoot} (${elapsedMs} ms)`);
    log(
      `Timing: runtime ${phaseMs.runtime} ms; registration ${phaseMs.registration} ms; verification ${phaseMs.verification} ms`
    );
    log(
      doctor?.ok
        ? 'STATUS: OK — Restart Codex to load [mcp_servers.inline-review].'
        : 'STATUS: UNVERIFIED — run doctor before use.'
    );
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const cli = quote(cliEntry);
    const node = quote(nodeBin);
    const home = ` --codex-home ${quote(codexHome)}`;
    log(`Doctor: ${node} --no-warnings ${cli} doctor${home}`);
    log(
      `Demo: ${node} --no-warnings ${cli} serve ${quote(path.join(installRoot, 'examples', 'demo.html'))}`
    );
    log(`Review: ${node} --no-warnings ${cli} serve /path/to/page.html`);
    log(`Uninstall: ${node} --no-warnings ${cli} uninstall${home}`);
  }

  return {
    codexHome,
    installRoot,
    cliEntry,
    nodeBin,
    relocated: shouldCopy,
    skillScope: targetSkill.skillScope,
    skillDir: targetSkill.skillDir,
    manifest: manifestV2,
    doctor,
  };
}

/** Syncs Codex config, recursive skill folder, AGENTS.md block, and Manifest v2 from existing runtimeRoot. */
export async function syncCodexSetup(options?: SyncOptions): Promise<SyncResult> {
  const codexHome = resolveCodexHome(options?.codexHome);
  const force = isForceEnabled(options?.force);
  const nodeBin = options?.nodeBin ?? resolveInstallNodeBin();
  const log = (msg: string) => {
    if (!options?.json) console.log(msg);
  };

  const state = resolveInstalledRuntimeState(codexHome, { agentsDir: options?.agentsDir });
  if (!state.installed || !state.runtimeRoot) {
    throw new Error(
      `codex-markup is not installed in ${codexHome}. Run "codex-markup install" first.`
    );
  }
  const runtimeRoot = state.runtimeRoot;
  const cliEntry = path.join(runtimeRoot, 'src', 'cli.ts');
  if (!fs.existsSync(cliEntry) || !fs.existsSync(path.join(runtimeRoot, 'skills', 'inline-html-review', 'SKILL.md'))) {
    throw new Error(`Installed runtime files are missing at ${runtimeRoot}. Run "codex-markup install" first.`);
  }

  const targetSkill = resolveTargetSkillLocation(codexHome, {
    skillScope: options?.skillScope,
    agentsDir: options?.agentsDir,
    prevManifest: state.manifest,
  });

  const drift = inspectArtifactDrift({
    codexHome,
    runtimeRoot,
    cliEntry,
    nodeBin,
    skillDir: targetSkill.skillDir,
    skillScope: targetSkill.skillScope,
    prevManifest: state.manifest,
    checkOldSkillDir: true,
  });
  if (!force && drift.customizedFiles.length > 0) {
    throw new UserCustomizationError(drift.customizedFiles);
  }

  const prevSkillDir = state.manifestV2?.artifacts.skillDir;
  const snapshot = snapshotCodexArtifacts(codexHome, [
    path.join(codexHome, 'skills', 'inline-html-review'),
    targetSkill.skillDir,
    ...(prevSkillDir ? [prevSkillDir] : []),
  ]);

  const updatedFiles: string[] = [];
  let doctor: DoctorReport | undefined;
  const version = readPackageVersion(runtimeRoot);
  const runtimeSha256 = computeRuntimeSha256(runtimeRoot);

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    const configPath = path.join(codexHome, 'config.toml');
    const tomlBlock = buildMcpTomlBlock(nodeBin, cliEntry);
    if (writeCodexConfigSection(configPath, tomlBlock)) {
      updatedFiles.push(configPath);
      log(`✓ Synced MCP server [mcp_servers.inline-review] in ${configPath}`);
    }

    const skillArtifacts = buildSkillArtifacts(runtimeRoot, cliEntry);
    const skillChanges = syncSkillDirectory(targetSkill.skillDir, skillArtifacts.files);
    updatedFiles.push(...skillChanges);
    if (skillChanges.length > 0) {
      log(`✓ Synced Codex skill (${targetSkill.skillScope}) in ${targetSkill.skillDir}`);
    }

    if (
      cleanupOwnedOldSkillDir(
        prevSkillDir,
        targetSkill.skillDir,
        codexHome,
        targetSkill.explicitAgentsDir,
        state.runtimeRoot,
        state.manifestV2?.artifacts.skillFiles['SKILL.md']
      ) &&
      prevSkillDir
    ) {
      updatedFiles.push(prevSkillDir);
      log(`✓ Cleaned up previous skill directory ${prevSkillDir}`);
    }

    const agentsPath = path.join(codexHome, 'AGENTS.md');
    const agentsSnippet = buildAgentsSnippet();
    if (writeAgentsMarkerBlock(agentsPath, agentsSnippet)) {
      updatedFiles.push(agentsPath);
      log(`✓ Synced global instructions in ${agentsPath}`);
    }

    const freshGit = readGitMetadata(runtimeRoot);
    const sourceCommit =
      cleanEnvValue(process.env.CODEX_MARKUP_SOURCE_COMMIT) ??
      freshGit.commit ??
      (fs.existsSync(path.join(runtimeRoot, '.git')) ? undefined : state.manifestV2?.sourceCommit);
    const sourceRepo =
      cleanEnvValue(process.env.CODEX_MARKUP_SOURCE_REPO) ??
      freshGit.repo ??
      state.manifestV2?.sourceRepo;
    const sourceBranch =
      cleanEnvValue(process.env.CODEX_MARKUP_SOURCE_BRANCH) ??
      freshGit.branch ??
      state.manifestV2?.sourceBranch;
    const tarballUrl = cleanEnvValue(process.env.CODEX_MARKUP_TARBALL_URL) ?? state.manifestV2?.tarballUrl;
    const tarballEtag = cleanEnvValue(process.env.CODEX_MARKUP_TARBALL_ETAG) ?? state.manifestV2?.tarballEtag;
    const installedAt = cleanEnvValue(process.env.CODEX_MARKUP_INSTALLED_AT) ?? new Date().toISOString();

    const nextManifest: InstallManifestV2 = {
      schemaVersion: 2,
      runtimeRoot,
      codexHome,
      managed: state.managed,
      version,
      runtimeSha256,
      ...(sourceCommit ? { sourceCommit } : {}),
      ...(sourceRepo ? { sourceRepo } : {}),
      ...(sourceBranch ? { sourceBranch } : {}),
      ...(tarballUrl ? { tarballUrl } : {}),
      ...(tarballEtag ? { tarballEtag } : {}),
      installedAt,
      artifacts: {
        skillScope: targetSkill.skillScope,
        skillDir: targetSkill.skillDir,
        skillFiles: skillArtifacts.hashes,
        agentsBlockSha256: sha256Text(agentsSnippet),
        configMcpSha256: sha256Text(tomlBlock.trim()),
      },
    };

    const manifestPath = path.join(codexHome, MANIFEST);
    const nextManifestText = JSON.stringify(nextManifest, null, 2) + '\n';
    const prevManifestText = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
    if (nextManifestText !== prevManifestText) {
      fs.writeFileSync(manifestPath, nextManifestText, 'utf8');
      updatedFiles.push(manifestPath);
    }

    if (!options?.skipVerify) {
      doctor = await runDoctor({
        codexHome,
        quiet: true,
        agentsDir: targetSkill.explicitAgentsDir ?? targetSkill.agentsRoot,
      });
      if (!doctor.ok) {
        for (const check of doctor.checks) {
          if (check.status === 'fail') {
            console.error(`✗ [${check.name}] ${check.detail}`);
          }
        }
        throw new Error('Sync verification failed');
      }
      log(`✓ Verified synced installation (${doctor.tools.length} tools)`);
    }
  } catch (err) {
    restoreCodexArtifacts(snapshot);
    throw err;
  }

  const didChange = updatedFiles.length > 0 || drift.needsSync;
  const result: SyncResult = {
    status: didChange ? 'synced' : 'up-to-date',
    codexHome,
    runtimeRoot,
    managed: state.managed,
    version,
    runtimeSha256,
    skillScope: targetSkill.skillScope,
    skillDir: targetSkill.skillDir,
    updatedFiles,
    needsSync: false,
    customizedFiles: [],
    restartRequired: updatedFiles.length > 0,
    doctor,
  };

  if (!options?.json) {
    log(
      didChange
        ? `STATUS: SYNCED — Updated ${updatedFiles.length} file(s); restart Codex if config/MCP changed.`
        : 'STATUS: UP-TO-DATE — Codex configuration and skill already match runtime.'
    );
  }
  return result;
}

function isGitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function validateTarEntries(tgzPath: string): void {
  const listOut = execFileSync('tar', ['-tzf', tgzPath], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  for (const rawLine of listOut.split(/\r?\n/)) {
    if (!rawLine) continue;
    if (rawLine.includes('\0')) {
      throw new Error(`Refusing tarball entry containing NUL byte: ${JSON.stringify(rawLine)}`);
    }
    if (rawLine.includes('\\')) {
      throw new Error(`Refusing tarball entry containing backslash: ${rawLine}`);
    }
    if (rawLine.startsWith('/')) {
      throw new Error(`Refusing tarball entry with absolute path: ${rawLine}`);
    }
    if (/^[a-zA-Z]:/.test(rawLine)) {
      throw new Error(`Refusing tarball entry with drive prefix: ${rawLine}`);
    }
    if (rawLine.split('/').includes('..')) {
      throw new Error(`Refusing tarball entry with parent traversal: ${rawLine}`);
    }
  }

  const verboseOut = execFileSync('tar', ['-tvzf', tgzPath], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  for (const rawLine of verboseOut.split(/\r?\n/)) {
    if (!rawLine) continue;
    const typeChar = rawLine[0];
    if (typeChar !== '-' && typeChar !== 'd') {
      throw new Error(`Refusing tarball containing unsupported entry type "${typeChar}": ${rawLine}`);
    }
  }
}

function assertExtractedTreeSafe(rootDir: string): void {
  const rootReal = safeRealpath(rootDir);
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing tarball with extracted symbolic link: ${abs}`);
      }
      const real = safeRealpath(abs);
      if (!isWithinDir(real, rootReal)) {
        throw new Error(`Tarball extraction escaped staging directory: ${abs}`);
      }
      if (stat.isDirectory()) {
        walk(abs);
      }
    }
  };
  walk(rootDir);
}

function extractVerifiedTarball(tgzPath: string, targetRuntimeDir: string, stageDir: string): void {
  validateTarEntries(tgzPath);
  const rawExtractDir = path.join(stageDir, 'extract-raw');
  fs.mkdirSync(rawExtractDir, { recursive: true });
  execFileSync('tar', ['-xzf', tgzPath, '-C', rawExtractDir], { stdio: 'pipe' });
  assertExtractedTreeSafe(rawExtractDir);

  let packageRoot: string | undefined;
  if (fs.existsSync(path.join(rawExtractDir, 'package.json'))) {
    packageRoot = rawExtractDir;
  } else {
    const candidates = fs
      .readdirSync(rawExtractDir)
      .filter((name) => name !== '.DS_Store' && name !== 'pax_global_header')
      .map((name) => path.join(rawExtractDir, name))
      .filter((abs) => fs.statSync(abs).isDirectory() && fs.existsSync(path.join(abs, 'package.json')));
    if (candidates.length === 1) {
      packageRoot = candidates[0];
    }
  }

  if (!packageRoot) {
    throw new Error(`Invalid codex-markup tarball (${tgzPath}): missing package.json`);
  }
  validateCandidateRuntimeDir(packageRoot);
  copyRuntimeToDir(packageRoot, targetRuntimeDir);
}

function validateCandidateRuntimeDir(dir: string): void {
  const pkgPath = path.join(dir, 'package.json');
  const cliPath = path.join(dir, 'src', 'cli.ts');
  const skillPath = path.join(dir, 'skills', 'inline-html-review', 'SKILL.md');
  if (!fs.existsSync(pkgPath) || !fs.existsSync(cliPath) || !fs.existsSync(skillPath)) {
    throw new Error(`Invalid codex-markup runtime at ${dir}: missing required runtime files`);
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    throw new Error(`Invalid package.json in candidate runtime at ${dir}`);
  }
  if (!pkg || typeof pkg !== 'object' || !('name' in pkg) || pkg.name !== 'codex-markup') {
    throw new Error(`Candidate runtime at ${dir} is not codex-markup`);
  }
}

interface ResolvedUpdateSource {
  sourceType: 'dir' | 'tarball' | 'git' | 'tarball-http';
  sourceLocation: string;
  branch?: string;
}

function resolveUpdateSource(
  options: UpdateOptions | undefined,
  manifestV2: InstallManifestV2 | undefined
): ResolvedUpdateSource {
  if (options?.from) {
    const resolvedFrom = path.resolve(options.from);
    if (!fs.existsSync(resolvedFrom)) {
      throw new Error(`Update source does not exist: ${resolvedFrom}`);
    }
    const stat = fs.statSync(resolvedFrom);
    return {
      sourceType: stat.isDirectory() ? 'dir' : 'tarball',
      sourceLocation: resolvedFrom,
    };
  }

  const explicitTarballUrl =
    cleanEnvValue(options?.tarballUrl) ??
    cleanEnvValue(process.env.CODEX_MARKUP_TARBALL_URL) ??
    cleanEnvValue(process.env.CODEX_MARKUP_TARBALL);

  if (explicitTarballUrl) {
    return {
      sourceType: 'tarball-http',
      sourceLocation: explicitTarballUrl,
    };
  }

  const explicitRepo =
    cleanEnvValue(options?.repo) ??
    cleanEnvValue(process.env.CODEX_MARKUP_SOURCE_REPO) ??
    cleanEnvValue(process.env.CODEX_MARKUP_REPO);

  if (!explicitRepo && manifestV2?.tarballUrl) {
    return {
      sourceType: 'tarball-http',
      sourceLocation: manifestV2.tarballUrl,
    };
  }

  const repo = explicitRepo ?? manifestV2?.sourceRepo ?? DEFAULT_REPO_URL;
  const branch =
    cleanEnvValue(options?.branch) ??
    cleanEnvValue(process.env.CODEX_MARKUP_SOURCE_BRANCH) ??
    cleanEnvValue(process.env.CODEX_MARKUP_BRANCH) ??
    manifestV2?.sourceBranch ??
    DEFAULT_BRANCH;

  if (isGitAvailable()) {
    return { sourceType: 'git', sourceLocation: repo, branch };
  }
  if (repo === DEFAULT_REPO_URL && branch === DEFAULT_BRANCH) {
    return { sourceType: 'tarball-http', sourceLocation: DEFAULT_TARBALL_URL };
  }
  throw new Error('git is required to update from a git repository URL.');
}

async function resolveRemoteGitCommit(repo: string, branch: string): Promise<string> {
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const ref = branch === 'HEAD' ? 'HEAD' : `refs/heads/${branch}`;
  const { stdout } = await execFileAsync('git', ['ls-remote', repo, ref], { env: gitEnv });
  const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  const sha = firstLine?.trim().split(/\s+/)[0];
  if (sha && /^[0-9a-f]{7,64}$/i.test(sha)) {
    return sha;
  }
  // Fallback for tag or short branch ref resolution
  const fallback = await execFileAsync('git', ['ls-remote', repo, branch], { env: gitEnv });
  const fallbackLine = fallback.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  const fallbackSha = fallbackLine?.trim().split(/\s+/)[0];
  if (fallbackSha && /^[0-9a-f]{7,64}$/i.test(fallbackSha)) {
    return fallbackSha;
  }
  throw new Error(`Unable to resolve remote branch "${branch}" from ${repo}`);
}

function setOrDeleteEnv(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) {
    env[key] = value;
  } else {
    delete env[key];
  }
}

async function finishNoRuntimeChange(params: {
  codexHome: string;
  runtimeRoot: string;
  currentVersion: string;
  currentRuntimeSha256: string;
  currentCommit?: string;
  targetSkill: TargetSkillLocation;
  needsSync: boolean;
  options?: UpdateOptions;
  force: boolean;
  nodeBin: string;
  log: (msg: string) => void;
}): Promise<UpdateApplyResult> {
  const {
    codexHome,
    runtimeRoot,
    currentVersion,
    currentRuntimeSha256,
    currentCommit,
    targetSkill,
    needsSync,
    options,
    force,
    nodeBin,
    log,
  } = params;

  if (needsSync) {
    const synced = await syncCodexSetup({
      codexHome,
      skillScope: options?.skillScope,
      agentsDir: options?.agentsDir,
      force,
      skipVerify: options?.skipVerify,
      json: options?.json,
      nodeBin,
    });
    return {
      mode: 'apply',
      status: 'synced',
      codexHome,
      runtimeRoot,
      managed: true,
      previousVersion: currentVersion,
      version: synced.version,
      ...(currentCommit ? { previousCommit: currentCommit, sourceCommit: currentCommit } : {}),
      runtimeSha256: synced.runtimeSha256,
      skillScope: synced.skillScope,
      skillDir: synced.skillDir,
      needsSync: false,
      customizedFiles: [],
      restartRequired: synced.restartRequired,
      doctor: synced.doctor,
    };
  }

  log(`codex-markup ${currentVersion} is already up to date.`);
  return {
    mode: 'apply',
    status: 'up-to-date',
    codexHome,
    runtimeRoot,
    managed: true,
    previousVersion: currentVersion,
    version: currentVersion,
    ...(currentCommit ? { previousCommit: currentCommit, sourceCommit: currentCommit } : {}),
    runtimeSha256: currentRuntimeSha256,
    skillScope: targetSkill.skillScope,
    skillDir: targetSkill.skillDir,
    needsSync: false,
    customizedFiles: [],
    restartRequired: false,
  };
}

/** Checks for or applies self-updates to managed installations with atomic staging and full rollback. */
export async function updateInstallation(
  options?: UpdateOptions
): Promise<UpdateCheckResult | UpdateApplyResult> {
  const codexHome = resolveCodexHome(options?.codexHome);
  const state = resolveInstalledRuntimeState(codexHome, { agentsDir: options?.agentsDir });
  const log = (msg: string) => {
    if (!options?.json) console.log(msg);
  };

  if (!state.installed || !state.runtimeRoot) {
    throw new Error(
      `codex-markup is not installed in ${codexHome}. Run "codex-markup install" first.`
    );
  }
  const runtimeRoot = state.runtimeRoot;
  if (!fs.existsSync(runtimeRoot)) {
    throw new Error(`Installed runtime directory does not exist: ${runtimeRoot}`);
  }

  const nodeBin = options?.nodeBin ?? resolveInstallNodeBin();
  const force = isForceEnabled(options?.force);
  const targetSkill = resolveTargetSkillLocation(codexHome, {
    skillScope: options?.skillScope,
    agentsDir: options?.agentsDir,
    prevManifest: state.manifest,
  });

  const currentVersion = readPackageVersion(runtimeRoot);
  const currentRuntimeSha256 = computeRuntimeSha256(runtimeRoot);
  const currentCommit =
    state.manifestV2?.sourceCommit ?? readGitMetadata(runtimeRoot).commit;
  const source = resolveUpdateSource(options, state.manifestV2);

  const localDrift = fs.existsSync(path.join(runtimeRoot, 'skills', 'inline-html-review', 'SKILL.md'))
    ? inspectArtifactDrift({
        codexHome,
        runtimeRoot,
        cliEntry: path.join(runtimeRoot, 'src', 'cli.ts'),
        nodeBin,
        skillDir: targetSkill.skillDir,
        skillScope: targetSkill.skillScope,
        prevManifest: state.manifest,
        checkOldSkillDir: true,
      })
    : {
        hasManifestV2: false,
        isV1OrLegacy: true,
        needsSync: true,
        behindFiles: [],
        customizedFiles: [],
        skillScope: targetSkill.skillScope,
        skillDir: targetSkill.skillDir,
        expectedSkillFiles: {},
        expectedAgentsHash: '',
        expectedConfigHash: '',
      };

  // --- Check-only mode (strictly non-mutating) ---
  if (options?.check) {
    let remoteCommit: string | undefined;
    let remoteEtag: string | undefined;
    let remoteVersion: string | undefined;
    let updateAvailable = false;
    const reasons: string[] = [];

    if (source.sourceType === 'dir') {
      validateCandidateRuntimeDir(source.sourceLocation);
      remoteVersion = readPackageVersion(source.sourceLocation);
      remoteCommit = readGitMetadata(source.sourceLocation).commit;
      const remoteSha = computeRuntimeSha256(source.sourceLocation);
      updateAvailable = remoteSha !== currentRuntimeSha256;
      if (updateAvailable) {
        reasons.push(`Source directory differs from installed runtime (${remoteVersion})`);
      }
    } else if (source.sourceType === 'tarball') {
      const checkStage = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-markup-check-'));
      try {
        const candidateCheckDir = path.join(checkStage, 'candidate');
        extractVerifiedTarball(source.sourceLocation, candidateCheckDir, checkStage);
        remoteVersion = readPackageVersion(candidateCheckDir);
        const remoteSha = computeRuntimeSha256(candidateCheckDir);
        updateAvailable = remoteSha !== currentRuntimeSha256;
        if (updateAvailable) {
          reasons.push(`Tarball contents differ from installed runtime (${remoteVersion})`);
        }
      } finally {
        fs.rmSync(checkStage, { recursive: true, force: true });
      }
    } else if (source.sourceType === 'git') {
      remoteCommit = await resolveRemoteGitCommit(source.sourceLocation, source.branch || DEFAULT_BRANCH);
      updateAvailable = currentCommit ? remoteCommit !== currentCommit : true;
      if (updateAvailable) {
        reasons.push(
          currentCommit
            ? `Remote ${source.branch || DEFAULT_BRANCH} commit ${remoteCommit.slice(0, 8)} differs from installed ${currentCommit.slice(0, 8)}`
            : `Remote ${source.branch || DEFAULT_BRANCH} commit ${remoteCommit.slice(0, 8)} available`
        );
      }
    } else {
      const headers: Record<string, string> = {};
      if (state.manifestV2?.tarballEtag) {
        headers['If-None-Match'] = state.manifestV2.tarballEtag;
      }
      const headRes = await fetch(source.sourceLocation, { method: 'HEAD', headers });
      if (headRes.status === 304) {
        updateAvailable = false;
        remoteEtag = state.manifestV2?.tarballEtag;
      } else if (headRes.ok) {
        remoteEtag = headRes.headers.get('etag')?.trim() || undefined;
        if (state.manifestV2?.tarballEtag && remoteEtag) {
          updateAvailable = remoteEtag !== state.manifestV2.tarballEtag;
        } else {
          updateAvailable = true;
        }
        if (updateAvailable) {
          reasons.push(
            remoteEtag
              ? `Remote tarball ETag ${remoteEtag} differs from installed ${state.manifestV2?.tarballEtag || '(none)'}`
              : 'Remote tarball update available'
          );
        }
      } else {
        throw new Error(`HTTP HEAD ${source.sourceLocation} failed with status ${headRes.status}`);
      }
    }

    if (localDrift.needsSync) {
      reasons.push(
        localDrift.customizedFiles.length > 0
          ? `Local user edit(s) detected: ${localDrift.customizedFiles.join(', ')}`
          : 'Local Codex configuration or skill requires sync'
      );
    }

    const status: UpdateCheckResult['status'] = updateAvailable
      ? 'update-available'
      : localDrift.needsSync
        ? 'sync-needed'
        : 'up-to-date';

    const checkResult: UpdateCheckResult = {
      mode: 'check',
      status,
      codexHome,
      runtimeRoot,
      managed: state.managed,
      currentVersion,
      ...(currentCommit ? { currentCommit } : {}),
      currentRuntimeSha256,
      ...(remoteCommit ? { remoteCommit } : {}),
      ...(remoteEtag ? { remoteEtag } : {}),
      ...(remoteVersion ? { remoteVersion } : {}),
      sourceType: source.sourceType,
      sourceLocation: source.sourceLocation,
      updateAvailable,
      needsSync: localDrift.needsSync,
      customizedFiles: localDrift.customizedFiles,
      reasons,
    };

    if (!options?.json) {
      if (status === 'update-available') {
        log(`Update available (${reasons.join('; ')})`);
      } else if (status === 'sync-needed') {
        log(`Runtime is current, but sync is needed (${reasons.join('; ')})`);
      } else {
        log(`codex-markup ${currentVersion} is up to date.`);
      }
    }
    return checkResult;
  }

  // --- Apply mode ---
  if (!state.managed) {
    throw new Error(
      `Refusing to self-update an unmanaged checkout at ${runtimeRoot}. Pull changes with git and run "codex-markup sync" instead.`
    );
  }
  if (isWithinDir(codexHome, runtimeRoot)) {
    throw new Error('Runtime directory must not contain the Codex configuration directory');
  }
  if (fs.lstatSync(runtimeRoot).isSymbolicLink()) {
    throw new Error(`Refusing to update a symlink runtime directory: ${runtimeRoot}`);
  }
  if (!ownsRuntime(runtimeRoot, codexHome) && !isLegacyManagedRuntime(runtimeRoot, codexHome)) {
    throw new Error(`Refusing to update an unowned runtime directory: ${runtimeRoot}`);
  }

  // Reject local customizations BEFORE downloading, staging, or modifying anything.
  if (!force && localDrift.customizedFiles.length > 0) {
    throw new UserCustomizationError(localDrift.customizedFiles);
  }

  const parentDir = path.dirname(runtimeRoot);
  fs.mkdirSync(parentDir, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(parentDir, '.codex-markup-update-'));

  try {
    const candidateDir = path.join(stageDir, 'candidate');
    let newCommit: string | undefined;
    let newRepo: string | undefined;
    let newBranch: string | undefined;
    let newTarballUrl: string | undefined;
    let newTarballEtag: string | undefined;

    if (source.sourceType === 'dir') {
      validateCandidateRuntimeDir(source.sourceLocation);
      const gitMeta = readGitMetadata(source.sourceLocation);
      newCommit = gitMeta.commit;
      newRepo = gitMeta.repo;
      newBranch = gitMeta.branch;
      const candidateSha = computeRuntimeSha256(source.sourceLocation);
      if (!force && candidateSha === currentRuntimeSha256 && state.manifestV2?.runtimeSha256 === currentRuntimeSha256) {
        return finishNoRuntimeChange({
          codexHome,
          runtimeRoot,
          currentVersion,
          currentRuntimeSha256,
          currentCommit,
          targetSkill,
          needsSync: localDrift.needsSync,
          options,
          force,
          nodeBin,
          log,
        });
      }
      copyRuntimeToDir(source.sourceLocation, candidateDir);
    } else if (source.sourceType === 'tarball') {
      extractVerifiedTarball(source.sourceLocation, candidateDir, stageDir);
      const candidateSha = computeRuntimeSha256(candidateDir);
      if (!force && candidateSha === currentRuntimeSha256 && state.manifestV2?.runtimeSha256 === currentRuntimeSha256) {
        return finishNoRuntimeChange({
          codexHome,
          runtimeRoot,
          currentVersion,
          currentRuntimeSha256,
          targetSkill,
          needsSync: localDrift.needsSync,
          options,
          force,
          nodeBin,
          log,
        });
      }
    } else if (source.sourceType === 'git') {
      const branch = source.branch || DEFAULT_BRANCH;
      const remoteCommit = await resolveRemoteGitCommit(source.sourceLocation, branch);
      if (
        !force &&
        currentCommit &&
        remoteCommit === currentCommit &&
        state.manifestV2?.runtimeSha256 === currentRuntimeSha256
      ) {
        return finishNoRuntimeChange({
          codexHome,
          runtimeRoot,
          currentVersion,
          currentRuntimeSha256,
          currentCommit,
          targetSkill,
          needsSync: localDrift.needsSync,
          options,
          force,
          nodeBin,
          log,
        });
      }
      const rawCloneDir = path.join(stageDir, 'git-clone');
      await execFileAsync(
        'git',
        ['clone', '--depth', '1', '--branch', branch, '--quiet', source.sourceLocation, rawCloneDir],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      );
      validateCandidateRuntimeDir(rawCloneDir);
      newCommit = readGitMetadata(rawCloneDir).commit ?? remoteCommit;
      newRepo = source.sourceLocation;
      newBranch = branch;
      copyRuntimeToDir(rawCloneDir, candidateDir);
    } else {
      const headers: Record<string, string> = {};
      if (!force && state.manifestV2?.tarballEtag) {
        headers['If-None-Match'] = state.manifestV2.tarballEtag;
      }
      const res = await fetch(source.sourceLocation, { method: 'GET', headers });
      if (res.status === 304) {
        return finishNoRuntimeChange({
          codexHome,
          runtimeRoot,
          currentVersion,
          currentRuntimeSha256,
          targetSkill,
          needsSync: localDrift.needsSync,
          options,
          force,
          nodeBin,
          log,
        });
      }
      if (!res.ok) {
        throw new Error(`Failed to download tarball from ${source.sourceLocation}: HTTP ${res.status}`);
      }
      newTarballUrl = source.sourceLocation;
      newTarballEtag = res.headers.get('etag')?.trim() || undefined;
      const downloadPath = path.join(stageDir, 'download.tgz');
      const bytes = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(downloadPath, bytes);
      extractVerifiedTarball(downloadPath, candidateDir, stageDir);
    }

    validateCandidateRuntimeDir(candidateDir);

    // Check candidate artifact drift before swapping in case candidate introduces conflicts.
    const candidateDrift = inspectArtifactDrift({
      codexHome,
      runtimeRoot: candidateDir,
      cliEntry: path.join(runtimeRoot, 'src', 'cli.ts'),
      nodeBin,
      skillDir: targetSkill.skillDir,
      skillScope: targetSkill.skillScope,
      prevManifest: state.manifest,
      checkOldSkillDir: true,
    });
    if (!force && candidateDrift.customizedFiles.length > 0) {
      throw new UserCustomizationError(candidateDrift.customizedFiles);
    }

    // Isolated pre-activation verification in temporary verify-home / verify-runtime
    if (!options?.skipVerify) {
      const verifyHome = path.join(stageDir, 'verify-home');
      const verifyRuntime = path.join(stageDir, 'verify-runtime');
      await execFileAsync(
        nodeBin,
        [
          '--no-warnings',
          path.join(candidateDir, 'src', 'cli.ts'),
          'install',
          '--codex-home',
          verifyHome,
          '--copy',
          '--install-dir',
          verifyRuntime,
          '--json',
        ],
        {
          env: {
            ...process.env,
            CODEX_REVIEW_PORT: '99999',
          },
        }
      );
    }

    // Write ownership marker inside staged candidate before atomic swap
    fs.writeFileSync(
      path.join(candidateDir, OWNER_MARKER),
      JSON.stringify({ runtimeRoot, codexHome, managed: true }, null, 2) + '\n'
    );

    const prevSkillDir = state.manifestV2?.artifacts.skillDir;
    const codexSnapshot = snapshotCodexArtifacts(codexHome, [
      path.join(codexHome, 'skills', 'inline-html-review'),
      targetSkill.skillDir,
      ...(prevSkillDir ? [prevSkillDir] : []),
    ]);

    const previousRuntimeDir = path.join(stageDir, 'previous');
    let swapped = false;
    try {
      fs.renameSync(runtimeRoot, previousRuntimeDir);
      swapped = true;
      fs.renameSync(candidateDir, runtimeRoot);

      const childArgs = [
        '--no-warnings',
        path.join(runtimeRoot, 'src', 'cli.ts'),
        'install',
        '--codex-home',
        codexHome,
        '--copy',
        '--install-dir',
        runtimeRoot,
        '--skill-scope',
        targetSkill.skillScope,
        '--json',
      ];
      if (targetSkill.explicitAgentsDir) {
        childArgs.push('--agents-dir', targetSkill.explicitAgentsDir);
      } else if (targetSkill.skillScope === 'agents' && targetSkill.agentsRoot) {
        childArgs.push('--agents-dir', targetSkill.agentsRoot);
      }
      if (force) {
        childArgs.push('--force');
      }
      if (options?.skipVerify) {
        childArgs.push('--no-verify');
      }

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        CODEX_REVIEW_PORT: '99999',
      };
      setOrDeleteEnv(childEnv, 'CODEX_MARKUP_SOURCE_COMMIT', newCommit);
      setOrDeleteEnv(childEnv, 'CODEX_MARKUP_SOURCE_REPO', newRepo);
      setOrDeleteEnv(childEnv, 'CODEX_MARKUP_SOURCE_BRANCH', newBranch);
      setOrDeleteEnv(childEnv, 'CODEX_MARKUP_TARBALL_URL', newTarballUrl);
      setOrDeleteEnv(childEnv, 'CODEX_MARKUP_TARBALL_ETAG', newTarballEtag);
      setOrDeleteEnv(childEnv, 'CODEX_MARKUP_INSTALLED_AT', new Date().toISOString());

      await execFileAsync(nodeBin, childArgs, { env: childEnv });
    } catch (err) {
      if (swapped) {
        try {
          if (fs.existsSync(runtimeRoot)) {
            fs.rmSync(runtimeRoot, { recursive: true, force: true });
          }
          if (fs.existsSync(previousRuntimeDir)) {
            fs.renameSync(previousRuntimeDir, runtimeRoot);
          }
        } catch (rollbackErr) {
          restoreCodexArtifacts(codexSnapshot);
          throw new Error(
            `Update failed (${err instanceof Error ? err.message : String(err)}); runtime rollback also failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`
          );
        }
      }
      restoreCodexArtifacts(codexSnapshot);
      throw err;
    }

    const updatedManifest = readInstallManifest(path.join(codexHome, MANIFEST));
    const updatedV2 = updatedManifest?.schemaVersion === 2 ? updatedManifest : undefined;
    const finalVersion = updatedV2?.version ?? readPackageVersion(runtimeRoot);
    const finalSha = updatedV2?.runtimeSha256 ?? computeRuntimeSha256(runtimeRoot);
    const doctor = options?.skipVerify
      ? undefined
      : await runDoctor({
          codexHome,
          quiet: true,
          agentsDir: targetSkill.explicitAgentsDir ?? targetSkill.agentsRoot,
        });

    if (!options?.json) {
      log(
        `✓ Updated codex-markup (${currentVersion} -> ${finalVersion}) at ${runtimeRoot}`
      );
      log('STATUS: UPDATED — Restart Codex to load the updated MCP server and skill.');
    }

    return {
      mode: 'apply',
      status: 'updated',
      codexHome,
      runtimeRoot,
      managed: true,
      previousVersion: currentVersion,
      version: finalVersion,
      ...(currentCommit ? { previousCommit: currentCommit } : {}),
      ...(updatedV2?.sourceCommit ? { sourceCommit: updatedV2.sourceCommit } : {}),
      runtimeSha256: finalSha,
      skillScope: updatedV2?.artifacts.skillScope ?? targetSkill.skillScope,
      skillDir: updatedV2?.artifacts.skillDir ?? targetSkill.skillDir,
      needsSync: false,
      customizedFiles: [],
      restartRequired: true,
      doctor,
    };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

/** Removes Codex MCP config, active skill directories, AGENTS.md instructions, and owned runtime files. */
export function uninstallFromCodex(options?: UninstallOptions): UninstallResult {
  const codexHome = resolveCodexHome(options?.codexHome);
  const log = (message: string) => {
    if (!options?.json) console.log(message);
  };

  const manifestPath = path.join(codexHome, MANIFEST);
  const manifest = readInstallManifest(manifestPath);
  const legacyRoot = path.join(codexHome, 'tools', 'codex-markup');
  const legacyManaged = isLegacyManagedRuntime(legacyRoot, codexHome);
  const effectiveManifest =
    manifest ?? (legacyManaged ? { runtimeRoot: legacyRoot, codexHome, managed: true } : undefined);

  let removedConfigSection = false;
  let removedSkillDir = false;
  let removedAgentsBlock = false;
  let removedRuntimeDir = false;
  const removedSkillDirs: string[] = [];

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
      log(`✓ Removed [mcp_servers.inline-review] from ${configPath}`);
    }
  }

  const candidateSkillDirs = new Set<string>([
    path.join(codexHome, 'skills', 'inline-html-review'),
  ]);
  const explicitAgentsDir = cleanEnvValue(options?.agentsDir) ?? cleanEnvValue(process.env.CODEX_MARKUP_AGENTS_DIR);
  if (explicitAgentsDir) {
    candidateSkillDirs.add(path.join(path.resolve(explicitAgentsDir), 'skills', 'inline-html-review'));
  }
  if (
    manifest?.schemaVersion === 2 &&
    path.resolve(manifest.codexHome) === codexHome &&
    manifest.artifacts.skillDir &&
    isOwnedExternalSkillDir(
      manifest.artifacts.skillDir,
      codexHome,
      manifest.runtimeRoot,
      manifest.artifacts.skillFiles['SKILL.md']
    )
  ) {
    candidateSkillDirs.add(path.resolve(manifest.artifacts.skillDir));
  }

  for (const skillDir of candidateSkillDirs) {
    if (!isValidSkillLeafDir(skillDir) || !fs.existsSync(skillDir)) continue;
    try {
      if (fs.lstatSync(skillDir).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    fs.rmSync(skillDir, { recursive: true, force: true });
    removedSkillDir = true;
    removedSkillDirs.push(skillDir);
    log(`✓ Removed skill directory ${skillDir}`);
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
      log(`✓ Removed inline-review instructions from ${agentsPath}`);
    }
  }

  if (
    !options?.keepRuntime &&
    effectiveManifest?.managed &&
    path.resolve(effectiveManifest.codexHome) === codexHome &&
    (ownsRuntime(effectiveManifest.runtimeRoot, codexHome) ||
      (legacyManaged && path.resolve(effectiveManifest.runtimeRoot) === legacyRoot))
  ) {
    fs.rmSync(effectiveManifest.runtimeRoot, { recursive: true, force: true });
    removedRuntimeDir = true;
    log(`✓ Removed runtime directory ${effectiveManifest.runtimeRoot}`);
  }
  if (!options?.keepRuntime && fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
  }
  log('Restart Codex to unload the integration; existing preview servers must be closed separately.');
  log(`✓ Uninstalled codex-markup from ${codexHome}`);

  return {
    codexHome,
    removedConfigSection,
    removedSkillDir,
    removedAgentsBlock,
    removedRuntimeDir,
    removedSkillDirs,
  };
}
