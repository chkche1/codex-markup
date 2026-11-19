#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `Error: codex-markup requires Node.js >= 22.6.0 for native TypeScript execution (found v${process.versions.node}).`
  );
  console.error('Switch to Node 22.6+ (e.g. `nvm use 22`, `fnm use 22`, or `brew install node`) and retry.');
  process.exit(1);
}
await import('../src/cli.ts');
