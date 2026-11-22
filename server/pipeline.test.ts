import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clip, redactPayload, safeCommand, scrub } from '../hooks/redact.mjs';
import { ensureToken } from '../hooks/token.mjs';
import { MatrixStore, store as uiStore } from '../src/store.ts';
import type { AgentEvent } from '../shared/events.ts';
import { ClaudeAdapter } from './adapters/claude.ts';
import { CursorAdapter } from './adapters/cursor.ts';
import { createCollector, sanitizeEvent } from './collector.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
uiStore.dispose(); // its interval would keep the test process alive

test('scrub removes common secret shapes', () => {
  const s = scrub('API_KEY=abc123 curl -H "Authorization: Bearer abcdefghijkl" https://u:p@x.io --token zzz sk-ant-aaaaaaaaaaaa ghp_aaaaaaaaaaaaaaaaaaaaaaaa');
  for (const bad of ['abc123', 'abcdefghijkl', 'u:p@', 'zzz', 'sk-ant-aaaa', 'ghp_aaaa']) assert.ok(!s.includes(bad), `${bad} leaked: ${s}`);
});

test('redactPayload drops prompts, contents and outputs, and is idempotent', () => {
  const raw = {
    hook_event_name: 'PostToolUseFailure',
    session_id: 's1',
    prompt: 'PRIVATE',
    last_assistant_message: 'PRIVATE',
    tool_name: 'Bash',
    tool_input: { command: 'npm test\nsecond line', content: 'PRIVATE', url: 'https://example.com/a?b' },
    tool_response: { stdout: 'PRIVATE' },
    error: 'Exit code 2\nPRIVATE stack',
    edits: [{}, {}],
  };
  const once = redactPayload(raw);
  assert.ok(!JSON.stringify(once).includes('PRIVATE'));
  assert.equal(once.error_exit, 'Exit code 2');
  assert.equal(once.tool_input.command, 'npm test …');
  assert.equal(once.tool_input.url_host, 'example.com');
  assert.equal(once.edit_count, 2);
  assert.deepEqual(redactPayload(once), once);
});

test('Claude Code adapter maps the documented hook events', () => {
  const a = new ClaudeAdapter();
  const base = { session_id: 'abc123', cwd: '/home/me/proj' };
  const ev = (p: object) => a.toEvents(redactPayload({ ...base, ...p }));

  assert.equal(ev({ hook_event_name: 'SessionStart', source: 'startup' })[0].type, 'session_started');
  const [start] = ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/home/me/proj/src/routes.ts' }, tool_use_id: 't1' });
  assert.equal(start.type, 'tool_started');
  assert.equal(start.summary, 'reading routes.ts');
  assert.deepEqual(start.files, ['src/routes.ts']);

  const [edit] = ev({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/home/me/proj/src/auth.ts' }, tool_use_id: 't2' });
  assert.equal(edit.type, 'file_changed');
  assert.equal(edit.summary, 'edited auth.ts');

  // A late PreToolUse after its PostToolUse (async hook race) is dropped.
  assert.equal(ev({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {}, tool_use_id: 't2' }).length, 0);

  const [fail] = ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't3', error: 'Exit code 1\nboom' });
  assert.equal(fail.ok, false);
  assert.match(fail.summary, /npm test · exit code 1/);

  const [sub] = ev({ hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'Explore' });
  assert.equal(sub.type, 'subagent_started');
  assert.equal(sub.agentId, 'cc:abc123:agent-1');
  assert.equal(sub.parentAgentId, 'cc:abc123');

  const [inner] = ev({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_use_id: 't4', agent_id: 'agent-1', agent_type: 'Explore' });
  assert.equal(inner.agentId, 'cc:abc123:agent-1');

  assert.equal(ev({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })[0].type, 'approval_needed');
  assert.equal(ev({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })[0].status, 'waiting');
  assert.equal(ev({ hook_event_name: 'Notification', notification_type: 'auth_success' }).length, 0);
  assert.equal(ev({ hook_event_name: 'Stop' })[0].status, 'completed');
  assert.equal(ev({ hook_event_name: 'SessionEnd', reason: 'other' })[0].type, 'session_completed');
  assert.equal(ev({ hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE' })[0].summary, 'new prompt received');
});

test('Cursor adapter pairs before/after shell hooks and ignores model text', () => {
  const a = new CursorAdapter();
  const base = { conversation_id: 'c1', workspace_roots: ['/w/site'] };
  const ev = (p: object) => a.toEvents(redactPayload({ ...base, ...p }));
  const [before] = ev({ hook_event_name: 'beforeShellExecution', command: 'pnpm test' });
  const [after] = ev({ hook_event_name: 'afterShellExecution', command: 'pnpm test', output: 'PRIVATE' });
  assert.equal(before.toolUseId, after.toolUseId);
  assert.equal(ev({ hook_event_name: 'afterFileEdit', file_path: '/w/site/app/page.tsx', edits: [{}, {}] })[0].summary, 'edited page.tsx (2 edits)');
  assert.equal(ev({ hook_event_name: 'stop', status: 'error' })[0].type, 'session_failed');
  assert.equal(ev({ hook_event_name: 'afterAgentResponse', text: 'PRIVATE' }).length, 0);
});

test('collector ingests, streams, rejects cross-origin writes, and clears', async () => {
  const c = createCollector({ log: false, reorderMs: 10 });
  const port = await c.listen(0);
  const url = `http://127.0.0.1:${port}`;
  const authorization = `Bearer ${c.token}`;
  try {
    const r = await fetch(`${url}/api/ingest/claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ payload: { hook_event_name: 'SessionStart', session_id: 's', cwd: '/p' } }),
    });
    assert.equal(r.status, 202);
    const evil = await fetch(`${url}/api/events`, { method: 'DELETE', headers: { origin: 'https://evil.example', authorization } });
    assert.equal(evil.status, 403);
    await new Promise((res) => setTimeout(res, 40));
    const events = await (await fetch(`${url}/api/events`, { headers: { authorization } })).json();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'session_started');
    const bad = await fetch(`${url}/api/events`, { method: 'POST', headers: { authorization }, body: JSON.stringify([{ nope: 1 }]) });
    assert.deepEqual(await bad.json(), { accepted: 0 });
    await fetch(`${url}/api/events`, { method: 'DELETE', headers: { authorization } });
    assert.equal((await (await fetch(`${url}/api/events`, { headers: { authorization } })).json()).length, 0);
  } finally {
    await c.close();
  }
});

test('collector requires the token, a known Host, and a same-origin browser', async () => {
  const c = createCollector({ log: false, reorderMs: 1 });
  const port = await c.listen(0);
  const request = (p: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      }).on('error', reject).end();
    });
  const authorization = `Bearer ${c.token}`;
  try {
    assert.equal(await request('/api/events', {}), 401);
    assert.equal(await request('/api/stream', {}), 401);
    assert.equal(await request('/api/events', { authorization: 'Bearer wrong' }), 401);
    assert.equal(await request('/api/events', { authorization }), 200);
    assert.equal(await request('/api/events', { authorization, host: 'attacker.example:4317' }), 403);
    assert.equal(await request('/api/events', { authorization, origin: 'http://localhost:9999' }), 403);
    assert.equal(await request('/api/events', { authorization, origin: `http://127.0.0.1:${port}` }), 200);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.deepEqual(health, { ok: true });
  } finally {
    await c.close();
  }
});

test('scrub catches passwords in common command forms', () => {
  for (const cmd of [
    'export DB_PASS=hunter2secret',
    'mysql -u root -phunter2secret',
    'sshpass -p hunter2secret ssh host',
    'curl -u admin:hunter2secret https://x.test',
    'curl -H "Cookie: session=hunter2secret" https://x.test',
    'curl -b session=hunter2secret https://x.test',
    'aws configure set aws_secret_access_key hunter2secret',
    'tool --client-secret hunter2secret',
    'echo hunter2secret | docker login --password-stdin',
    'STRIPE_KEY=hunter2secret node app.js',
  ]) assert.ok(!safeCommand(cmd)!.includes('hunter2secret'), `leaked: ${safeCommand(cmd)}`);
  for (const cmd of ['mkdir -p src/app', 'git checkout -b feature', 'npm test', 'git push origin main']) assert.equal(safeCommand(cmd), cmd);
  assert.equal(scrub(scrub('export DB_PASS=x')), scrub('export DB_PASS=x'));
  const paths = JSON.stringify(redactPayload({ tool_input: { file_path: '/w/sk-ant-abcdefghijklmnop.txt', glob: 'ghp_abcdefghijklmnopqrstuvwxyz' } }));
  assert.ok(!paths.includes('sk-ant') && !paths.includes('ghp_'), paths);
});

test('terminal escape sequences are stripped', () => {
  assert.ok(!safeCommand('printf \u001b]52;c;ZXZpbA==\u0007done')!.includes('\u001b'));
  assert.equal(clip('a\u001b[31mb‮c', 20), 'a[31mbc');
});

test('canonical events are rebuilt and scrubbed', () => {
  const e = sanitizeEvent({
    v: 1, id: 'x', ts: 1, provider: 'p', type: 'tool_started', sessionId: 's', agentId: 'a',
    summary: 'ran \u001b[2J sk-ant-abcdefghijklmnop', files: ['/w/ghp_abcdefghijklmnopqrstuvwxyz'], extra: 'dropped',
  } as AgentEvent);
  assert.ok(!JSON.stringify(e).includes('sk-ant') && !JSON.stringify(e).includes('ghp_') && !JSON.stringify(e).includes('\\u001b'));
  assert.equal('extra' in e, false);
});

test('UI store survives reserved lane ids', () => {
  const m = new MatrixStore();
  const ev = (id: string, agentId: string) => ({ v: 1, id, ts: Date.now(), provider: 'p', type: 'tool_started', sessionId: 's', agentId, summary: 'x' }) as AgentEvent;
  try {
    m.ingest([ev('1', 'good-1'), ev('2', '__proto__'), ev('3', 'constructor'), ev('4', 'good-2')], { replay: true });
    assert.deepEqual(m.getSnapshot().order, ['good-1', '__proto__', 'constructor', 'good-2']);
    assert.equal(({} as Record<string, unknown>).id, undefined);
  } finally {
    m.dispose();
  }
});

test('setup keeps settings permissions and the token file is owner-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentviewer-test-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o600);
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'setup-hooks.mjs'), 'claude', '--file', file, '--write']);
    assert.equal(r.status, 0);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const tokenFile = path.join(dir, 'nested', 'token');
    const token = ensureToken(tokenFile);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    assert.equal(ensureToken(tokenFile), token);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook script fails open when the collector is unreachable', () => {
  const hook = path.join(root, 'hooks', 'agentviewer-hook.mjs');
  const env = { ...process.env, AGENTVIEWER_URL: 'http://127.0.0.1:9' };
  const t0 = Date.now();
  const claude = spawnSync(process.execPath, [hook, 'claude'], { input: '{"hook_event_name":"PreToolUse"}', env });
  assert.equal(claude.status, 0);
  assert.equal(claude.stdout.toString(), '', 'Claude hook must print nothing');
  const cursor = spawnSync(process.execPath, [hook, 'cursor'], { input: '{"hook_event_name":"beforeSubmitPrompt"}', env });
  assert.equal(cursor.status, 0);
  assert.equal(cursor.stdout.toString().trim(), '{"continue":true}');
  const garbage = spawnSync(process.execPath, [hook, 'claude'], { input: 'not json', env });
  assert.equal(garbage.status, 0);
  assert.ok(Date.now() - t0 < 4000, 'hooks must return quickly');
});
