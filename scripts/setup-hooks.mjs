#!/usr/bin/env node
// Safely add (or remove) Agent Matrix hooks to Claude Code / Cursor config.
//
//   npm run setup:claude                         # dry run: show the merge for ~/.claude/settings.json
//   npm run setup:claude -- --write              # back up, then merge
//   npm run setup:claude -- --project ~/code/app --write   # <app>/.claude/settings.local.json
//   npm run setup:cursor                         # dry run for ~/.cursor/hooks.json
//   npm run setup:cursor -- --project ~/code/app --write   # <app>/.cursor/hooks.json
//   npm run setup:claude -- --uninstall --write  # remove only our entries
//   npm run setup:claude -- --print              # just print the snippet to paste yourself
//
// Guarantees:
// - Never writes without --write.
// - Copies the existing file to <file>.agentviewer-backup-<timestamp> first.
// - Merges: existing hooks and all other settings are preserved; our entries
//   are recognised by "agentviewer-hook.mjs" in the command and never duplicated.
// - Refuses to touch a file that isn't valid JSON (prints the snippet instead).
// - Writes atomically (temp file + rename).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(root, 'hooks', 'agentviewer-hook.mjs');
const MARK = 'agentviewer-hook.mjs';

const args = process.argv.slice(2);
const provider = args[0];
const flag = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const write = flag('--write');
const uninstall = flag('--uninstall');
const printOnly = flag('--print');
const project = opt('--project');
const explicitFile = opt('--file');

if (provider !== 'claude' && provider !== 'cursor') {
  console.error('usage: setup-hooks.mjs <claude|cursor> [--project <dir>] [--file <path>] [--write] [--uninstall] [--print]');
  process.exit(2);
}

const q = (s) => (/[\s"'$`\\]/.test(s) ? JSON.stringify(s) : s);
// Absolute node path: GUI apps (Cursor) often don't inherit your shell PATH.
const command = (p) => `${q(process.execPath)} ${q(HOOK)} ${p}`;
const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// ── Claude Code ──────────────────────────────────────────────────────────
// Event names from https://code.claude.com/docs/en/hooks.
// async: true → the hook runs in the background and can never slow Claude down.
// SessionStart/SessionEnd run synchronously with a short timeout so they are
// delivered reliably at startup/shutdown.
const CLAUDE_EVENTS = {
  SessionStart: { async: false, timeout: 3 },
  UserPromptSubmit: { async: true },
  PreToolUse: { async: true },
  PostToolUse: { async: true },
  PostToolUseFailure: { async: true },
  PermissionRequest: { async: true },
  Notification: { async: true },
  SubagentStart: { async: true },
  SubagentStop: { async: true },
  Stop: { async: true },
  StopFailure: { async: true },
  PreCompact: { async: true },
  SessionEnd: { async: false, timeout: 2 },
};

function claudeSnippet() {
  const hooks = {};
  for (const [event, o] of Object.entries(CLAUDE_EVENTS)) {
    const h = { type: 'command', command: command('claude'), timeout: o.timeout ?? 5 };
    if (o.async) h.async = true;
    hooks[event] = [{ hooks: [h] }];
  }
  return { hooks };
}

function mergeClaude(config) {
  const out = structuredClone(config);
  out.hooks ??= {};
  const ours = claudeSnippet().hooks;
  for (const [event, groups] of Object.entries(out.hooks)) {
    // Strip our previous entries (so re-running updates paths), keep everything else.
    if (!Array.isArray(groups)) continue;
    out.hooks[event] = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? '').includes(MARK)) }))
      .filter((g) => g.hooks.length);
    if (!out.hooks[event].length) delete out.hooks[event];
  }
  if (!uninstall) for (const [event, groups] of Object.entries(ours)) out.hooks[event] = [...(out.hooks[event] ?? []), ...groups];
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

// ── Cursor ───────────────────────────────────────────────────────────────
// ⚠ Unverified against current Cursor docs (see README). Only observational
// hooks are registered by default; none of them return permission decisions.
// beforeShellExecution/beforeMCPExecution/beforeReadFile expect a permission
// reply; we never send one, so they are opt-in (--cursor-extended) until the
// behaviour of an empty reply is confirmed against Cursor's docs.
const CURSOR_EVENTS = ['beforeSubmitPrompt', 'afterShellExecution', 'afterMCPExecution', 'afterFileEdit', 'stop'];
const CURSOR_OPTIONAL = ['beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'sessionStart', 'sessionEnd', 'subagentStart', 'subagentStop', 'postToolUse', 'postToolUseFailure'];

function cursorSnippet() {
  const events = flag('--cursor-extended') ? [...CURSOR_EVENTS, ...CURSOR_OPTIONAL] : CURSOR_EVENTS;
  const hooks = {};
  for (const e of events) hooks[e] = [{ command: command('cursor') }];
  return { version: 1, hooks };
}

function mergeCursor(config) {
  const out = structuredClone(config);
  out.version ??= 1;
  out.hooks ??= {};
  for (const [event, list] of Object.entries(out.hooks)) {
    if (!Array.isArray(list)) continue;
    out.hooks[event] = list.filter((h) => !String(h.command ?? '').includes(MARK));
    if (!out.hooks[event].length) delete out.hooks[event];
  }
  if (!uninstall) for (const [event, list] of Object.entries(cursorSnippet().hooks)) out.hooks[event] = [...(out.hooks[event] ?? []), ...list];
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────
const target = explicitFile
  ? expand(explicitFile)
  : provider === 'claude'
    ? project
      ? path.join(expand(project), '.claude', 'settings.local.json')
      : path.join(os.homedir(), '.claude', 'settings.json')
    : project
      ? path.join(expand(project), '.cursor', 'hooks.json')
      : path.join(os.homedir(), '.cursor', 'hooks.json');

const snippet = provider === 'claude' ? claudeSnippet() : cursorSnippet();

if (printOnly) {
  console.log(`# Add this to ${target} (merge with any existing "hooks"):\n`);
  console.log(JSON.stringify(snippet, null, 2));
  process.exit(0);
}

let existing = {};
let existed = false;
if (fs.existsSync(target)) {
  existed = true;
  const text = fs.readFileSync(target, 'utf8');
  try {
    existing = text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    console.error(`✗ ${target} is not valid JSON (${err.message}).`);
    console.error('  Not touching it. Fix the file, or paste this snippet in by hand:\n');
    console.log(JSON.stringify(snippet, null, 2));
    process.exit(1);
  }
}

const merged = provider === 'claude' ? mergeClaude(existing) : mergeCursor(existing);
const before = JSON.stringify(existing, null, 2);
const after = JSON.stringify(merged, null, 2);

console.log(`${provider === 'claude' ? 'Claude Code' : 'Cursor'} config: ${target}${existed ? '' : ' (will be created)'}`);
if (before === after) {
  console.log('✓ Already up to date — nothing to change.');
  process.exit(0);
}

const addedEvents = Object.keys(merged.hooks ?? {}).filter((e) => JSON.stringify(merged.hooks[e]).includes(MARK));
console.log(uninstall ? '− Removing Agent Matrix hook entries.' : `+ Agent Matrix hooks on: ${addedEvents.join(', ')}`);
console.log(`  hook command: ${command(provider)}`);

if (!write) {
  console.log('\n--- resulting file (dry run) ---');
  console.log(after);
  console.log('\nDry run only. Re-run with --write to apply (a backup is made first).');
  process.exit(0);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
// Settings can hold secrets: keep the file's mode, and create new files owner-only.
const mode = existed ? fs.statSync(target).mode & 0o777 : 0o600;
if (existed) {
  const backup = `${target}.agentviewer-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(target, backup);
  fs.chmodSync(backup, mode);
  console.log(`  backup: ${backup}`);
}
const tmp = `${target}.agentviewer-tmp-${process.pid}`;
fs.writeFileSync(tmp, after + '\n', { mode, flag: 'wx' });
fs.chmodSync(tmp, mode);
fs.renameSync(tmp, target);
console.log(`✓ ${uninstall ? 'Removed' : 'Installed'}. ${provider === 'claude' ? 'Start a new Claude Code session (or run /hooks to review).' : 'Restart Cursor so it reloads hooks.json.'}`);
