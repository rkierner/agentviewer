// Per-install access token shared by the collector, the hook and the UI link.
// Stored owner-only at ~/.agentviewer/token (override: AGENTVIEWER_TOKEN_FILE).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VALID = /^[a-f0-9]{64}$/;

export function tokenPath() {
  return process.env.AGENTVIEWER_TOKEN_FILE || path.join(os.homedir(), '.agentviewer', 'token');
}

export function readToken(file = tokenPath()) {
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    return VALID.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export function ensureToken(file = tokenPath()) {
  const existing = readToken(file);
  if (existing) {
    fs.chmodSync(file, 0o600);
    return existing;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return token;
  } catch (err) {
    // Another process (collector or Vite) may have created it first.
    const raced = readToken(file);
    if (raced) return raced;
    throw err;
  }
}
