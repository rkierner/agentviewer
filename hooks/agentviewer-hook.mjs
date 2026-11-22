#!/usr/bin/env node
// Agent Matrix hook forwarder.
//
//   node agentviewer-hook.mjs claude   (Claude Code command hook)
//   node agentviewer-hook.mjs cursor   (Cursor hook)
//
// Reads the hook JSON from stdin, strips it down to an activity summary
// (see redact.mjs), and POSTs it to the local collector.
//
// FAIL-OPEN GUARANTEES
// - Always exits 0, whatever happens (no collector, bad JSON, crash).
// - Never blocks for long: the POST has a short timeout and a hard
//   watchdog kills the process after ~1s.
// - For Claude Code it writes nothing to stdout (stdout from some hooks is
//   added to Claude's context; we never want that).
// - For Cursor it only writes a neutral response where the hook protocol
//   expects one ({"continue": true} for beforeSubmitPrompt, {} otherwise).
//   It never writes a permission decision.

import http from 'node:http';
import { redactPayload } from './redact.mjs';
import { readToken } from './token.mjs';

const provider = process.argv[2] === 'cursor' ? 'cursor' : 'claude';
const base = process.env.AGENTVIEWER_URL || `http://127.0.0.1:${process.env.AGENTVIEWER_PORT || 4317}`;
const TIMEOUT_MS = Number(process.env.AGENTVIEWER_HOOK_TIMEOUT_MS || 400);
const receivedAt = Date.now();

let done = false;
let eventName = '';

function finish() {
  if (done) return;
  done = true;
  if (provider === 'cursor') {
    try {
      process.stdout.write(eventName === 'beforeSubmitPrompt' ? '{"continue":true}\n' : '{}\n');
    } catch {}
  }
  process.exit(0);
}

// Hard watchdog: whatever else happens, leave quickly and successfully.
setTimeout(finish, TIMEOUT_MS + 700);
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);

if (process.env.AGENTVIEWER_DISABLE === '1') finish();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  // Hook payloads are small; refuse to buffer anything absurd.
  if (input.length < 2_000_000) input += c;
});
process.stdin.on('error', finish);
process.stdin.on('end', () => {
  let raw;
  try {
    raw = JSON.parse(input);
  } catch {
    return finish();
  }
  eventName = typeof raw?.hook_event_name === 'string' ? raw.hook_event_name : '';
  const body = JSON.stringify({ provider, receivedAt, payload: redactPayload(raw) });
  try {
    const url = new URL(`/api/ingest/${provider}`, base);
    const token = readToken();
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const req = http.request(
      url,
      { method: 'POST', headers, timeout: TIMEOUT_MS },
      (res) => {
        res.resume();
        res.on('end', finish);
        res.on('error', finish);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish();
    });
    req.on('error', finish);
    req.end(body);
  } catch {
    finish();
  }
});
