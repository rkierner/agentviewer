/**
 * Agent Matrix local event collector.
 *
 *   POST /api/ingest/claude   raw (redacted) Claude Code hook payload
 *   POST /api/ingest/cursor   raw (redacted) Cursor hook payload
 *   POST /api/events          canonical AgentEvent or AgentEvent[] (any provider)
 *   GET  /api/events          buffered events as JSON (?since=<ms>)
 *   DELETE /api/events        clear the buffer
 *   GET  /api/stream          Server-Sent Events: "snapshot" then "events" batches
 *   GET  /api/health          liveness
 *   GET  /*                   built UI from dist/ (after `npm run build`)
 *
 * Local-first: binds to 127.0.0.1, keeps a bounded in-memory ring buffer,
 * no persistence, no outbound network. Every /api route except a bare health
 * check requires `Authorization: Bearer <token>`; Host and Origin are checked
 * so a website can't reach it through DNS rebinding.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAgentEvent, normalizeEvent, type AgentEvent } from '../shared/events.ts';
import { ClaudeAdapter } from './adapters/claude.ts';
import { CursorAdapter } from './adapters/cursor.ts';
import { clip, redactPayload, scrub } from '../hooks/redact.mjs';
import { ensureToken } from '../hooks/token.mjs';

export interface CollectorOptions {
  port?: number;
  host?: string;
  /** Required on /api routes. A random one is generated when omitted. */
  token?: string;
  /** Extra Host names to accept, for non-loopback binds. */
  allowedHosts?: string[];
  bufferSize?: number;
  /** Hold events briefly so async hooks that race arrive in order. */
  reorderMs?: number;
  staticDir?: string;
  log?: boolean;
}

export class EventBuffer {
  private items: AgentEvent[] = [];
  constructor(private size: number) {}
  push(events: AgentEvent[]) {
    this.items.push(...events);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
  }
  since(ts = 0) {
    return ts ? this.items.filter((e) => e.ts > ts) : this.items.slice();
  }
  clear() {
    this.items = [];
  }
  get length() {
    return this.items.length;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.png': 'image/png',
};

const MAX_BODY = 256 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Reject unknown Host headers, which is what a DNS-rebinding request carries. */
function hostAllowed(req: http.IncomingMessage, allowed: Set<string>) {
  try {
    return allowed.has(new URL(`http://${req.headers.host ?? ''}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Browsers attach Origin on cross-origin calls; only the page's own origin passes. */
function originAllowed(req: http.IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function tokenMatches(req: http.IncomingMessage, token: string) {
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/** Rebuild an event from known fields, with every display string scrubbed. */
export function sanitizeEvent(e: AgentEvent): AgentEvent {
  const text = (v: unknown, n: number) => (typeof v === 'string' ? clip(scrub(v), n) : undefined);
  const id = (v: unknown) => (typeof v === 'string' ? clip(v, 200) : undefined);
  const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
  return normalizeEvent({
    v: 1,
    id: id(e.id) ?? '',
    ts: finite(e.ts) ?? Date.now(),
    provider: text(e.provider, 64) ?? '',
    type: e.type,
    sessionId: id(e.sessionId) ?? '',
    agentId: id(e.agentId) ?? '',
    parentAgentId: id(e.parentAgentId),
    label: text(e.label, 120),
    status: e.status,
    summary: text(e.summary, 400) ?? '',
    kind: e.kind,
    tool: text(e.tool, 120),
    toolUseId: id(e.toolUseId),
    files: Array.isArray(e.files) ? e.files.filter((f) => typeof f === 'string').slice(0, 12).map((f) => text(f, 600)!) : undefined,
    ok: bool(e.ok),
    durationMs: finite(e.durationMs),
    cwd: text(e.cwd, 400),
    mock: bool(e.mock),
  });
}

export function createCollector(opts: CollectorOptions = {}) {
  const token = opts.token ?? crypto.randomBytes(32).toString('hex');
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...(opts.allowedHosts ?? []).map((h) => h.toLowerCase())]);
  const bufferSize = opts.bufferSize ?? 2000;
  const reorderMs = opts.reorderMs ?? 200;
  const log = opts.log ?? true;
  const buffer = new EventBuffer(bufferSize);
  const clients = new Set<http.ServerResponse>();
  const claude = new ClaudeAdapter();
  const cursor = new CursorAdapter();
  let pending: AgentEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const stats = { received: 0, emitted: 0, rejected: 0, startedAt: Date.now() };

  const send = (res: http.ServerResponse, event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const flush = () => {
    flushTimer = null;
    if (!pending.length) return;
    const batch = pending.sort((a, b) => a.ts - b.ts);
    pending = [];
    buffer.push(batch);
    stats.emitted += batch.length;
    for (const c of clients) send(c, 'events', batch);
  };

  const enqueue = (events: AgentEvent[]) => {
    if (!events.length) return;
    pending.push(...events);
    if (!flushTimer) flushTimer = setTimeout(flush, reorderMs);
  };

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const staticDir = opts.staticDir;
  const serveStatic = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!staticDir || !fs.existsSync(path.join(staticDir, 'index.html'))) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Agent Matrix collector is running.\nUI: run `npm run dev` and open the link it prints (or `npm start` to serve the built UI here).\n');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = path.join(staticDir, rel);
    if (!file.startsWith(staticDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(staticDir, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (!hostAllowed(req, allowedHosts)) return json(res, 403, { error: 'host not allowed' });
      if (url.pathname.startsWith('/api/')) {
        if (!originAllowed(req)) return json(res, 403, { error: 'cross-origin requests are not allowed' });
        const authed = tokenMatches(req, token);
        if (route === 'GET /api/health') return json(res, 200, authed ? { ok: true, buffered: buffer.length, clients: clients.size, ...stats } : { ok: true });
        if (!authed) return json(res, 401, { error: 'missing or invalid token' });
      }

      if (route === 'GET /api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        send(res, 'snapshot', buffer.since());
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }

      if (route === 'GET /api/events') return json(res, 200, buffer.since(Number(url.searchParams.get('since') ?? 0)));

      if (route === 'DELETE /api/events') {
        buffer.clear();
        pending = [];
        for (const c of clients) send(c, 'cleared', {});
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/ingest/')) {
        const provider = url.pathname.slice('/api/ingest/'.length);
        const body = JSON.parse((await readBody(req)) || '{}');
        stats.received++;
        // Re-redact server-side in case someone posts a raw payload directly.
        const payload = redactPayload(body.payload ?? body);
        const at = typeof body.receivedAt === 'number' ? body.receivedAt : Date.now();
        let raw: AgentEvent[] = [];
        if (provider === 'claude') raw = claude.toEvents(payload, at);
        else if (provider === 'cursor') raw = cursor.toEvents(payload, at);
        else return json(res, 404, { error: 'unknown provider' });
        const events = raw.map(sanitizeEvent);
        if (log && events.length) for (const e of events) console.log(`  ${provider.padEnd(6)} ${e.type.padEnd(20)} ${e.summary}`);
        enqueue(events);
        return json(res, 202, { accepted: events.length });
      }

      if (route === 'POST /api/events') {
        const body = JSON.parse((await readBody(req)) || '[]');
        const list = (Array.isArray(body) ? body : [body]).filter(isAgentEvent);
        stats.received += list.length;
        enqueue(list.map(sanitizeEvent));
        return json(res, 202, { accepted: list.length });
      }

      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(req, res);
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      stats.rejected++;
      return json(res, 400, { error: (err as Error).message });
    }
  });

  return {
    server,
    buffer,
    token,
    listen(port = opts.port ?? 4317, host = opts.host ?? '127.0.0.1') {
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve((server.address() as { port: number }).port));
      });
    },
    close() {
      for (const c of clients) c.end();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.AGENTVIEWER_PORT ?? 4317);
  const host = process.env.AGENTVIEWER_HOST ?? '127.0.0.1';
  const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
  const token = ensureToken();
  const extraHosts = (process.env.AGENTVIEWER_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const c = createCollector({ staticDir, token, allowedHosts: [host, ...extraHosts], log: process.env.AGENTVIEWER_QUIET !== '1' });
  c.listen(port, host)
    .then((p) => {
      console.log(`\n  ▌Agent Matrix collector listening on http://${host}:${p}`);
      if (host !== '127.0.0.1' && host !== 'localhost') console.log('  ⚠  bound to a non-loopback address; the token is sent over unencrypted HTTP on your network.');
      if (fs.existsSync(path.join(staticDir, 'index.html'))) console.log(`  ▌UI: http://${host}:${p}/#token=${token}`);
      console.log('  ▌hooks POST to /api/ingest/{claude,cursor}; UI streams from /api/stream\n');
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') console.error(`Port ${port} is in use. Is another collector running? Set AGENTVIEWER_PORT to change it.`);
      else console.error(err);
      process.exit(1);
    });
}
