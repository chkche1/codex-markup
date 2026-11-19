#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [major, minor] = process.versions.node.split('.').map(Number);
if (!(major >= 24 || (major === 22 && minor >= 18))) {
  console.error(`Error: codex-markup requires Node.js 22.18+ (22.x) or 24+; found ${process.versions.node}.`);
  process.exit(1);
}

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (sourceRoot.split(path.sep).includes('node_modules')) {
  const args = process.argv.slice(2);
  if (args[0] !== 'install' && !args.includes('--help') && args[0] !== 'help') {
    console.error('Run npx codex-markup install first, then use the installed CLI printed by the installer.');
    process.exit(1);
  }
  // Node cannot execute TypeScript under node_modules. Relocate before importing it.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-markup-bootstrap-'));
  try {
    fs.cpSync(sourceRoot, staging, {
      recursive: true,
      filter: (entry) => !['node_modules', '.git'].includes(path.basename(entry)),
    });
    const result = spawnSync(process.execPath, ['--no-warnings', path.join(staging, 'src', 'cli.ts'), ...args], {
      stdio: 'inherit',
    });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
} else {
  await import('../src/cli.ts');
}
