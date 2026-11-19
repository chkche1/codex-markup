import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  DEFAULT_PORT,
  InlineReviewServer,
  ensureReviewServer,
  openInBrowser,
  resolveDefaultSandboxMode,
  type SandboxCapabilities,
} from './server.ts';
import { startMcpServer } from './mcp.ts';
import { installForCodex, runDoctor, uninstallFromCodex } from './install.ts';
import {
  formatReviewForCodex,
  createThread,
  addReply,
  updateThreadStatus,
  waitForFileSubmission,
  type CommentStatus,
  type CommentTarget,
} from './store.ts';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg === '-h') {
      flags.help = true;
    } else if (arg === '-p' && argv[i + 1]) {
      flags.port = argv[++i];
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function printHelp() {
  const cliPath = path.resolve(import.meta.dirname || '.', '../bin/codex-markup.js');
  console.log(`
codex-markup — Claude Artifacts-style HTML preview & inline commenting for Codex

USAGE:
  codex-markup <command> [options]

COMMANDS:
  serve [file.html]               Start local review server & open HTML file with inline commenting
  mcp                             Start Model Context Protocol (MCP) stdio server for Codex
  wait <file.html>                Block until user clicks "Submit Review to Codex" in browser
  comments <file.html>            Print inline comments for an HTML file (--status open|all|resolved)
  add-comment <file.html> <text>  Add an inline comment (--selector "body" --tag "body")
  reply <file.html> <id> <text>   Reply to a comment thread from Codex (--resolve to mark resolved)
  resolve <file.html> <id>        Mark a comment thread as resolved (--reopen to reopen)
  restart [file.html]             Restart the local review server (and trigger review if file given)
  install                         Configure ~/.codex/config.toml, skill, and AGENTS.md for Codex Desktop & CLI
  doctor                          Verify Node.js version, Codex config, skill, and MCP server handshake
  uninstall                       Remove Codex MCP config, skill, global instructions, and copied runtime
  setup                           Print Codex MCP & Skill configuration instructions

OPTIONS:
  -p, --port <number>             Port for local review server (default: ${DEFAULT_PORT})
  --sandbox <mode>                Background codex exec mode: full-access (default when unsandboxed) | workspace-write
  --codex-home <dir>              Custom Codex configuration directory (default: ~/.codex)
  --copy                          Copy runtime to <codex-home>/tools/codex-markup on install
  --install-dir <dir>             Explicit runtime destination directory on install (implies --copy)
  --no-verify                     Skip post-install MCP verification in 'install'
  --no-open                       Do not automatically open the browser on 'serve'
  -h, --help                      Show this help message

QUICK START:
  node --no-warnings ${cliPath} serve examples/demo.html
`);
}

function printSandboxStatus(caps?: SandboxCapabilities) {
  if (!caps) return;
  if (caps.controlSource === 'externally-sandboxed') {
    console.log(
      `🔒 Outer sandbox detected (${caps.externalSandboxSignal}): Full Access unavailable. Start from an unsandboxed terminal if unrestricted access is needed.`
    );
  } else if (caps.controlSource === 'policy-restricted') {
    console.log('🔒 System Codex policy restricts Full Access (running in workspace-write).');
  } else if (caps.controlSource === 'connected-session') {
    console.log('🔗 Connected Codex session controls sandbox permissions while listening.');
  } else if (caps.effectiveMode === 'full-access') {
    console.log(
      '🔓 Background Codex mode: full-access (local machine access; pass --sandbox workspace-write to restrict)'
    );
  } else {
    console.log(
      `🔒 Background Codex mode: workspace-write (root: ${caps.workspaceRoot}; pass --sandbox full-access for unrestricted access)`
    );
  }
}

function printSetup() {
  const repoRoot = path.resolve(import.meta.dirname || '.', '..');
  const cliEntry = path.join(repoRoot, 'src', 'cli.ts');
  const skillPath = path.join(repoRoot, 'skills', 'inline-html-review', 'SKILL.md');

  console.log(`# Codex Setup for codex-markup

## 1. Add MCP Server to \`~/.codex/config.toml\`

Add the following block to your \`~/.codex/config.toml\`:

\`\`\`toml
[mcp_servers.inline-review]
command = "node"
args = ["--no-warnings", "${cliEntry}", "mcp"]
\`\`\`

## 2. Or Run Codex with One-Line Config Override

\`\`\`bash
codex -c 'mcp_servers.inline-review.command="node"' \\
      -c 'mcp_servers.inline-review.args=["--no-warnings", "${cliEntry}", "mcp"]'
\`\`\`

## 3. Codex Skill / AGENTS.md Integration

- Skill path: \`${skillPath}\`
- Or copy \`AGENTS.md\` into your workspace so Codex automatically knows how to open HTML previews, wait for your inline comments, edit the HTML, and reply to each comment thread!
`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] || 'help';
  const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
  const sandboxMode =
    typeof flags.sandbox === 'string' ? resolveDefaultSandboxMode(flags.sandbox) : undefined;
  if (sandboxMode) {
    process.env.CODEX_MARKUP_SANDBOX = sandboxMode;
  }

  if (flags.help || cmd === 'help') {
    printHelp();
    return;
  }

  if (cmd === 'setup') {
    printSetup();
    return;
  }

  if (cmd === 'install') {
    const customDir = typeof flags['codex-home'] === 'string' ? flags['codex-home'] : undefined;
    const installDir = typeof flags['install-dir'] === 'string' ? flags['install-dir'] : undefined;
    await installForCodex({
      codexHome: customDir,
      copy: Boolean(flags.copy),
      installDir,
      skipVerify: Boolean(flags['no-verify']),
    });
    return;
  }

  if (cmd === 'doctor') {
    const customDir = typeof flags['codex-home'] === 'string' ? flags['codex-home'] : undefined;
    const report = await runDoctor({ codexHome: customDir });
    if (!report.ok) {
      process.exit(1);
    }
    return;
  }

  if (cmd === 'uninstall') {
    const customDir = typeof flags['codex-home'] === 'string' ? flags['codex-home'] : undefined;
    uninstallFromCodex({
      codexHome: customDir,
      keepRuntime: Boolean(flags['keep-runtime']),
    });
    return;
  }

  if (cmd === 'restart') {
    const targetFile = positional[1] ? path.resolve(positional[1]) : undefined;
    let stoppedGracefully = false;
    try {
      const shutdownRes = await fetch(`http://127.0.0.1:${port}/__inline_review__/api/shutdown`, {
        method: 'POST',
      });
      if (shutdownRes.ok) {
        stoppedGracefully = true;
        console.log(`✓ Gracefully stopped old server on port ${port}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch {
      // Server not running or unreachable; fallback to lsof check below
    }

    if (!stoppedGracefully) {
      try {
        const lsofBin = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
        const pids = execFileSync(lsofBin, ['-ti', `tcp:${port}`], { encoding: 'utf8' })
          .split('\n')
          .map((s) => Number(s.trim()))
          .filter((n) => n > 0 && n !== process.pid);
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGTERM');
            console.log(`✓ Stopped old server process (PID ${pid}) on port ${port}`);
          } catch {
            // Ignore if already exited
          }
        }
        if (pids.length > 0) {
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch {
        // No process listening on port
      }
    }

    const cliScript = path.resolve(import.meta.dirname || '.', 'cli.ts');
    const args = ['--no-warnings', cliScript, 'serve'];
    if (targetFile) args.push(targetFile);
    args.push('--port', String(port), '--no-open');
    if (sandboxMode) args.push('--sandbox', sandboxMode);

    const logFile = path.join(os.tmpdir(), `codex-inline-review-${port}.log`);
    fs.writeFileSync(logFile, `=== Server Restarted at ${new Date().toISOString()} ===\n`, 'utf8');
    const outFd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', outFd, outFd],
    });
    child.unref();

    const baseUrl = `http://127.0.0.1:${port}`;
    let healthData: { sandbox?: SandboxCapabilities } | undefined;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const res = await fetch(`${baseUrl}/__inline_review__/api/health`);
        if (res.ok) {
          healthData = (await res.json()) as { sandbox?: SandboxCapabilities };
          break;
        }
      } catch {
        // Keep waiting
      }
    }
    console.log(`✨ Restarted Codex Inline Review Server on ${baseUrl} (PID ${child.pid}, logs: ${logFile})`);
    printSandboxStatus(healthData?.sandbox);

    if (targetFile) {
      const submitRes = await fetch(`${baseUrl}/__inline_review__/api/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: targetFile }),
      });
      const submitData = (await submitRes.json()) as {
        spawnedCodex?: boolean;
        state?: { threads?: Array<{ id: string; status: string }> };
      };
      const openCount = (submitData.state?.threads || []).filter((t) => t.status === 'open').length;
      console.log(
        `🚀 Triggered review for ${targetFile} (${openCount} open comment(s), spawnedCodex=${Boolean(
          submitData.spawnedCodex
        )})`
      );
    }
    return;
  }

  if (cmd === 'mcp') {
    await startMcpServer(port);
    return;
  }

  if (cmd === 'serve') {
    const targetFile = positional[1] ? path.resolve(positional[1]) : undefined;
    const shouldOpen = !flags['no-open'];

    try {
      const srv = new InlineReviewServer(port, targetFile, sandboxMode);
      const actualPort = await srv.start();
      const reviewUrl = srv.getReviewUrl(targetFile);
      console.log(`✨ Codex Inline Review Server running at: http://127.0.0.1:${actualPort}`);
      printSandboxStatus(srv.getSandboxCapabilities(targetFile));
      if (targetFile) {
        console.log(`📄 Reviewing HTML file: ${targetFile}`);
        console.log(`🔗 Review URL: ${reviewUrl}`);
        if (shouldOpen) {
          openInBrowser(reviewUrl);
        }
      }
      console.log(`\nPress Ctrl+C to stop.`);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE' && targetFile) {
        const { baseUrl } = await ensureReviewServer(port, targetFile);
        const res = await fetch(`${baseUrl}/__inline_review__/api/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: targetFile, openBrowser: shouldOpen }),
        });
        const data = (await res.json()) as { reviewUrl: string };
        console.log(`✨ Connected to existing Review Server at ${baseUrl}`);
        console.log(`🔗 Opened: ${data.reviewUrl}`);
        if (sandboxMode) {
          const sandboxRes = await fetch(`${baseUrl}/__inline_review__/api/sandbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: targetFile, sandboxMode }),
          });
          const sandboxData = (await sandboxRes.json()) as {
            applied?: boolean;
            error?: string;
            sandbox?: SandboxCapabilities;
          };
          if (sandboxData.applied === false) {
            console.warn(`⚠️ Could not change sandbox mode on existing server: ${sandboxData.error}`);
          } else {
            printSandboxStatus(sandboxData.sandbox);
          }
        } else {
          try {
            const healthRes = await fetch(`${baseUrl}/__inline_review__/api/health`);
            if (healthRes.ok) {
              const healthData = (await healthRes.json()) as { sandbox?: SandboxCapabilities };
              printSandboxStatus(healthData.sandbox);
            }
          } catch {
            // Ignore health check failure
          }
        }
      } else {
        throw err;
      }
    }
    return;
  }

  if (cmd === 'wait') {
    const targetFile = positional[1];
    if (!targetFile) {
      console.error('Error: Missing <file.html>. Usage: codex-markup wait <file.html>');
      process.exit(1);
    }
    const resolvedFile = path.resolve(targetFile);
    try {
      const { baseUrl, server } = await ensureReviewServer(port, resolvedFile);
      const reviewUrl = `${baseUrl}/review?file=${encodeURIComponent(resolvedFile)}`;
      console.error(`⏳ Waiting for user to submit inline comments at ${reviewUrl} ...`);
      if (server) {
        const res = await server.waitForSubmission(resolvedFile, 600_000);
        console.log(res.prompt);
        await server.stop();
        return;
      }
      const res = await fetch(`${baseUrl}/__inline_review__/api/wait`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: resolvedFile, timeoutMs: 600_000 }),
      });
      const data = (await res.json()) as { prompt: string };
      console.log(data.prompt);
      return;
    } catch {
      console.error(`⏳ Waiting for submission on ${resolvedFile} ...`);
      const res = await waitForFileSubmission(resolvedFile, 600_000);
      console.log(res.prompt);
      return;
    }
  }

  if (cmd === 'comments' || cmd === 'list') {
    const targetFile = positional[1];
    if (!targetFile) {
      console.error('Error: Missing <file.html>. Usage: codex-markup comments <file.html>');
      process.exit(1);
    }
    const status = (flags.status as 'open' | 'answered' | 'resolved' | 'all') || 'open';
    console.log(formatReviewForCodex(path.resolve(targetFile), status));
    return;
  }

  if (cmd === 'add-comment') {
    const targetFile = positional[1];
    const commentText = positional.slice(2).join(' ');
    if (!targetFile || !commentText) {
      console.error('Usage: codex-markup add-comment <file.html> "<comment text>" [--selector "body"] [--tag "body"]');
      process.exit(1);
    }
    const resolvedFile = path.resolve(targetFile);
    const selector = typeof flags.selector === 'string' ? flags.selector : 'body';
    const tagName = typeof flags.tag === 'string' ? flags.tag : selector === 'body' ? 'body' : 'div';
    const target: CommentTarget = {
      mode: 'element',
      selector,
      tagName,
      offsetXRatio: 0.5,
      offsetYRatio: 0.1,
    };

    try {
      const res = await fetch(`http://127.0.0.1:${port}/__inline_review__/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: resolvedFile, target, text: commentText, author: 'user' }),
      });
      if (res.ok) {
        const data = (await res.json()) as { thread?: { id: string; number: number } };
        console.log(`✓ Added comment ${data.thread?.id} (#${data.thread?.number}) via live review server.`);
        return;
      }
    } catch {
      // Fallback to direct store write if server isn't running
    }

    const thread = createThread(resolvedFile, target, commentText, 'user');
    console.log(`✓ Added comment ${thread.id} (#${thread.number}) to ${resolvedFile}.comments.json.`);
    return;
  }

  if (cmd === 'reply') {
    const targetFile = positional[1];
    const commentId = positional[2];
    const replyText = positional.slice(3).join(' ');
    if (!targetFile || !commentId || !replyText) {
      console.error('Usage: codex-markup reply <file.html> <comment-id> "<reply text>" [--resolve]');
      process.exit(1);
    }
    const resolvedFile = path.resolve(targetFile);
    const status: CommentStatus = flags.resolve ? 'resolved' : (flags.status as CommentStatus) || 'answered';

    try {
      const res = await fetch(`http://127.0.0.1:${port}/__inline_review__/api/reply`, {
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
      if (res.ok) {
        const data = (await res.json()) as { thread?: { id: string; status: string } };
        console.log(`✓ Replied to ${data.thread?.id} (status: ${data.thread?.status}) and updated live browser view.`);
        return;
      }
    } catch {
      // Fallback to direct file write if server isn't running
    }

    const thread = addReply(resolvedFile, commentId, replyText, 'codex', status);
    if (!thread) {
      console.error(`Error: Comment ${commentId} not found.`);
      process.exit(1);
    }
    console.log(`✓ Replied to ${thread.id} (status: ${thread.status}).`);
    return;
  }

  if (cmd === 'resolve') {
    const targetFile = positional[1];
    const commentId = positional[2];
    if (!targetFile || !commentId) {
      console.error('Usage: codex-markup resolve <file.html> <comment-id> [--reopen]');
      process.exit(1);
    }
    const resolvedFile = path.resolve(targetFile);
    const status: CommentStatus = flags.reopen ? 'open' : 'resolved';

    try {
      const res = await fetch(`http://127.0.0.1:${port}/__inline_review__/api/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: resolvedFile, commentId, status }),
      });
      if (res.ok) {
        console.log(`✓ Updated ${commentId} status to ${status} (live synced).`);
        return;
      }
    } catch {
      // Fallback to direct file write
    }

    const thread = updateThreadStatus(resolvedFile, commentId, status);
    if (!thread) {
      console.error(`Error: Comment ${commentId} not found.`);
      process.exit(1);
    }
    console.log(`✓ Updated ${thread.id} status to ${thread.status}.`);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
