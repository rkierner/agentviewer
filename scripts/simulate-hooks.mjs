// End-to-end check of the live pipeline without a real agent:
//   hook JSON on stdin → hooks/agentviewer-hook.mjs → collector → UI
//
//   npm run simulate            # Claude Code + Cursor sessions
//   npm run simulate -- claude  # only Claude Code
//   npm run simulate -- cursor  # only Cursor
//
// Payload shapes follow the Claude Code hooks reference
// (https://code.claude.com/docs/en/hooks). Cursor payloads follow the
// assumed schema documented in server/adapters/cursor.ts.
// Some payloads deliberately contain prompts, file contents and secrets so you
// can confirm none of it reaches the UI.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(root, 'hooks', 'agentviewer-hook.mjs');
const only = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runHook(provider, payload) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [hook, provider], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', (code) => resolve({ code, out: out.trim(), ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify(payload));
  });
}

async function send(provider, payload, gap = 350) {
  const r = await runHook(provider, payload);
  const ev = payload.hook_event_name;
  console.log(`${provider.padEnd(6)} ${ev.padEnd(22)} exit=${r.code} ${String(r.ms).padStart(4)}ms${r.out ? ` stdout=${r.out}` : ''}`);
  await sleep(gap);
}

async function claude() {
  const cwd = path.join(process.env.HOME ?? '/home/me', 'code', 'shop-api');
  const base = {
    session_id: `sim-${Date.now().toString(36)}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd,
    permission_mode: 'default',
  };
  const tool = (hook_event_name, tool_name, tool_input, extra = {}) => ({ ...base, hook_event_name, tool_name, tool_input, ...extra });
  const id = () => `toolu_${Math.random().toString(36).slice(2, 12)}`;

  await send('claude', { ...base, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-model' });
  await send('claude', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'SECRET PROMPT: my api key is sk-ant-abcdefghijklmnop, refactor auth' });

  let t = id();
  await send('claude', tool('PreToolUse', 'Read', { file_path: `${cwd}/src/routes.ts` }, { tool_use_id: t }));
  await send('claude', tool('PostToolUse', 'Read', { file_path: `${cwd}/src/routes.ts` }, { tool_use_id: t, tool_response: { content: 'FILE CONTENTS SHOULD NOT LEAK' } }));

  t = id();
  await send('claude', tool('PreToolUse', 'Grep', { pattern: 'verifyToken', path: cwd }, { tool_use_id: t }));
  await send('claude', tool('PostToolUse', 'Grep', { pattern: 'verifyToken', path: cwd }, { tool_use_id: t }));

  // Subagent
  const agent_id = `agent-${Math.random().toString(36).slice(2, 8)}`;
  t = id();
  await send('claude', tool('PreToolUse', 'Agent', { description: 'Map session handling', subagent_type: 'Explore', prompt: 'PRIVATE SUBAGENT PROMPT' }, { tool_use_id: t }));
  await send('claude', { ...base, hook_event_name: 'SubagentStart', agent_id, agent_type: 'Explore' });
  for (const f of ['src/auth.ts', 'src/middleware/session.ts', 'src/config.ts']) {
    const st = id();
    await send('claude', tool('PreToolUse', 'Read', { file_path: `${cwd}/${f}` }, { tool_use_id: st, agent_id, agent_type: 'Explore' }), 150);
    await send('claude', tool('PostToolUse', 'Read', { file_path: `${cwd}/${f}` }, { tool_use_id: st, agent_id, agent_type: 'Explore' }), 150);
  }
  await send('claude', { ...base, hook_event_name: 'SubagentStop', agent_id, agent_type: 'Explore', stop_hook_active: false, last_assistant_message: 'PRIVATE SUBAGENT OUTPUT' });
  await send('claude', tool('PostToolUse', 'Agent', { description: 'Map session handling', subagent_type: 'Explore' }, { tool_use_id: t }));

  t = id();
  await send('claude', tool('PreToolUse', 'Edit', { file_path: `${cwd}/src/auth.ts`, old_string: 'const SECRET = 1', new_string: 'const SECRET = 2' }, { tool_use_id: t }));
  await send('claude', tool('PostToolUse', 'Edit', { file_path: `${cwd}/src/auth.ts` }, { tool_use_id: t, tool_response: { filePath: `${cwd}/src/auth.ts` } }));

  // Permission flow
  const cmd = { command: 'API_TOKEN=supersecretvalue123 npm test -- --password hunter2', description: 'Run test suite' };
  await send('claude', tool('PermissionRequest', 'Bash', cmd));
  await send('claude', { ...base, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }, 2500);
  t = id();
  await send('claude', tool('PreToolUse', 'Bash', cmd, { tool_use_id: t }), 1200);
  await send('claude', tool('PostToolUseFailure', 'Bash', cmd, { tool_use_id: t, error: 'Exit code 1\nError: Cannot find module express\n    at secret stack', is_interrupt: false, duration_ms: 4187 }));

  await send('claude', { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'PRIVATE ASSISTANT MESSAGE' });
}

async function cursor() {
  const root = path.join(process.env.HOME ?? '/home/me', 'code', 'landing-site');
  const base = { conversation_id: `sim-cur-${Date.now().toString(36)}`, generation_id: 'gen-1', workspace_roots: [root] };
  await send('cursor', { ...base, hook_event_name: 'beforeSubmitPrompt', prompt: 'PRIVATE CURSOR PROMPT', attachments: [] });
  await send('cursor', { ...base, hook_event_name: 'beforeReadFile', file_path: `${root}/app/page.tsx`, content: 'FILE CONTENTS SHOULD NOT LEAK' });
  await send('cursor', { ...base, hook_event_name: 'afterFileEdit', file_path: `${root}/app/page.tsx`, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] });
  await send('cursor', { ...base, hook_event_name: 'beforeShellExecution', command: 'pnpm test', cwd: root }, 1200);
  await send('cursor', { ...base, hook_event_name: 'afterShellExecution', command: 'pnpm test', output: 'SHELL OUTPUT SHOULD NOT LEAK', duration: 1100 });
  await send('cursor', { ...base, hook_event_name: 'beforeMCPExecution', tool_name: 'github.get_issue', tool_input: '{"number": 42}' });
  await send('cursor', { ...base, hook_event_name: 'afterMCPExecution', tool_name: 'github.get_issue', result_json: '{"title":"private"}' });
  await send('cursor', { ...base, hook_event_name: 'stop', status: 'completed', loop_count: 0 });
}

const tasks = [];
if (!only || only === 'claude') tasks.push(claude());
if (!only || only === 'cursor') tasks.push(sleep(800).then(cursor));
await Promise.all(tasks);

// Verify nothing sensitive made it into the collector buffer.
try {
  const port = process.env.AGENTVIEWER_PORT || 4317;
  const res = await fetch(`http://127.0.0.1:${port}/api/events`);
  const text = await res.text();
  const leaks = ['SECRET PROMPT', 'sk-ant-', 'FILE CONTENTS', 'PRIVATE', 'supersecretvalue', 'hunter2', 'SHELL OUTPUT', 'Cannot find module'].filter((s) => text.includes(s));
  const n = JSON.parse(text).length;
  console.log(`\ncollector buffer: ${n} events; privacy check: ${leaks.length ? `LEAKED ${leaks.join(', ')}` : 'ok (no prompts, contents, outputs or secrets)'}`);
  if (leaks.length) process.exitCode = 1;
} catch {
  console.log('\n(collector not reachable — start it with `npm run collector` or `npm run dev`; the hooks still exited 0, which is the fail-open path)');
}
