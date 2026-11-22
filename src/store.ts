import type { ActivityKind, AgentEvent, AgentStatus } from '../shared/events';

/**
 * Client-side state for the matrix.
 *
 * Events are applied immediately to lane *state* (status, attention, counters)
 * but the visible *chunks* go through a per-lane queue that is drained at a
 * steady pace. When a burst arrives, queued chunks of the same kind are
 * coalesced ("reading 7 files") so the screen never floods.
 */

export type ChunkState = 'live' | 'ok' | 'fail' | 'info';

export interface Chunk {
  id: string;
  kind: ActivityKind;
  text: string;
  state: ChunkState;
  ts: number;
  toolUseId?: string;
  files?: string[];
  count: number;
  /** Highlight style for notable moments. */
  accent?: 'attention' | 'fail' | 'spawn' | 'done';
}

export interface Lane {
  id: string;
  sessionId: string;
  parentId?: string;
  name: string;
  provider: string;
  mock: boolean;
  status: AgentStatus;
  statusSince: number;
  lastEventAt: number;
  startedAt: number;
  activity: string;
  attention?: string;
  chunks: Chunk[];
  queue: Chunk[];
  dropped: number;
  tools: number;
  files: number;
  errors: number;
  cwd?: string;
}

export interface MatrixState {
  lanes: Record<string, Lane>;
  order: string[];
  paused: boolean;
  version: number;
}

const MAX_VISIBLE = 40;
const MAX_QUEUE = 60;
const IDLE_AFTER_MS = 90_000;

type Listener = () => void;

/** Lane ids come from events, so "__proto__" or "constructor" must not hit Object.prototype. */
export function laneById(lanes: Record<string, Lane>, id: string | undefined): Lane | undefined {
  return id !== undefined && Object.hasOwn(lanes, id) ? lanes[id] : undefined;
}

function kindFor(e: AgentEvent): ActivityKind {
  if (e.kind) return e.kind;
  switch (e.type) {
    case 'approval_needed':
      return 'approval';
    case 'file_changed':
      return 'edit';
    case 'subagent_started':
    case 'subagent_completed':
      return 'delegate';
    case 'tool_started':
    case 'tool_completed':
      return 'other';
    default:
      return 'status';
  }
}

const plural: Record<ActivityKind, (n: number) => string> = {
  read: (n) => `reading ${n} files`,
  search: (n) => `${n} searches`,
  edit: (n) => `editing ${n} files`,
  run: (n) => `ran ${n} commands`,
  web: (n) => `${n} web requests`,
  delegate: (n) => `${n} delegations`,
  approval: (n) => `${n} approvals`,
  status: (n) => `${n} status updates`,
  other: (n) => `${n} tool calls`,
};

export class MatrixStore {
  private state: MatrixState = { lanes: {}, order: [], paused: false, version: 0 };
  private listeners = new Set<Listener>();
  private lastRelease: Record<string, number> = Object.create(null);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** ms between chunk releases per lane. */
  releaseInterval = 420;
  /** Finished lanes are retired after this long (mock lanes sooner). */
  retireAfterMs = 15 * 60_000;
  retireMockAfterMs = 35_000;

  constructor() {
    this.timer = setInterval(() => this.tick(), 90);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.state;

  private emit() {
    this.state = { ...this.state, version: this.state.version + 1 };
    for (const l of this.listeners) l();
  }

  setPaused(paused: boolean) {
    this.state.paused = paused;
    this.emit();
  }

  /** Remove every lane (optionally only mock lanes or only live lanes). */
  clear(filter?: (lane: Lane) => boolean) {
    const lanes = { ...this.state.lanes };
    for (const [id, lane] of Object.entries(lanes)) if (!filter || filter(lane)) delete lanes[id];
    this.state.lanes = lanes;
    this.state.order = this.state.order.filter((id) => lanes[id]);
    this.emit();
  }

  /** Apply a batch. `replay` skips the flow queue (used for snapshot on reconnect). */
  ingest(events: AgentEvent[], opts: { replay?: boolean } = {}) {
    if (!events.length) return;
    for (const e of events) {
      try {
        this.apply(e, !!opts.replay);
      } catch {
        /* one bad event must not drop the rest of the batch */
      }
    }
    this.emit();
  }

  private ensureLane(e: AgentEvent): Lane {
    let lane = laneById(this.state.lanes, e.agentId);
    if (!lane) {
      lane = {
        id: e.agentId,
        sessionId: e.sessionId,
        parentId: e.parentAgentId,
        name: e.label || e.agentId.slice(0, 12),
        provider: e.provider,
        mock: !!e.mock,
        status: 'idle',
        statusSince: e.ts,
        lastEventAt: e.ts,
        startedAt: e.ts,
        activity: '',
        chunks: [],
        queue: [],
        dropped: 0,
        tools: 0,
        files: 0,
        errors: 0,
        cwd: e.cwd,
      };
      this.state.lanes = { ...this.state.lanes, [lane.id]: lane };
      this.state.order = [...this.state.order, lane.id];
    } else {
      // Lanes are mutated in place, then replaced so React sees a new identity.
      lane = { ...lane };
      this.state.lanes = { ...this.state.lanes, [lane.id]: lane };
    }
    if (e.label && (lane.name === lane.id.slice(0, 12) || e.type === 'session_started' || e.type === 'subagent_started'))
      lane.name = e.label;
    if (e.parentAgentId && !lane.parentId && e.parentAgentId !== lane.id) lane.parentId = e.parentAgentId;
    if (e.cwd) lane.cwd = e.cwd;
    return lane;
  }

  private setStatus(lane: Lane, status: AgentStatus, ts: number) {
    if (lane.status !== status) {
      lane.status = status;
      lane.statusSince = ts;
    }
    if (status !== 'waiting') lane.attention = undefined;
  }

  private push(lane: Lane, chunk: Chunk, replay: boolean) {
    if (replay) {
      lane.chunks = [chunk, ...lane.chunks].slice(0, MAX_VISIBLE);
      return;
    }
    lane.queue = [...lane.queue, chunk];
    if (lane.queue.length > MAX_QUEUE) {
      // Hard cap: drop the oldest non-attention chunks, count them.
      const over = lane.queue.length - MAX_QUEUE;
      lane.queue = lane.queue.slice(over);
      lane.dropped += over;
    }
  }

  /** If a live chunk for this tool use exists (visible or queued), mark it done. */
  private resolveTool(lane: Lane, toolUseId: string, ok: boolean, text?: string): boolean {
    const fix = (list: Chunk[]) => {
      const i = list.findIndex((c) => c.toolUseId === toolUseId);
      if (i < 0) return null;
      const c = { ...list[i], state: (ok ? 'ok' : 'fail') as ChunkState };
      if (!ok) {
        c.accent = 'fail';
        if (text) c.text = text;
      }
      const copy = list.slice();
      copy[i] = c;
      return copy;
    };
    const q = fix(lane.queue);
    if (q) {
      lane.queue = q;
      return true;
    }
    const v = fix(lane.chunks);
    if (v) {
      lane.chunks = v;
      return true;
    }
    return false;
  }

  private apply(e: AgentEvent, replay: boolean) {
    const lane = this.ensureLane(e);
    lane.lastEventAt = Math.max(lane.lastEventAt, e.ts);
    const kind = kindFor(e);
    const chunk = (text: string, state: ChunkState, accent?: Chunk['accent']): Chunk => ({
      id: e.id,
      kind,
      text,
      state,
      ts: e.ts,
      toolUseId: e.toolUseId,
      files: e.files,
      count: 1,
      accent,
    });

    switch (e.type) {
      case 'session_started':
      case 'agent_started':
        this.setStatus(lane, e.status ?? 'idle', e.ts);
        lane.activity = e.summary;
        this.push(lane, chunk(e.summary, 'info'), replay);
        break;

      case 'agent_status_changed': {
        const status = e.status ?? 'working';
        this.setStatus(lane, status, e.ts);
        if (status === 'waiting') lane.attention = e.summary;
        lane.activity = e.summary;
        const accent = status === 'waiting' ? 'attention' : status === 'failed' ? 'fail' : status === 'completed' ? 'done' : undefined;
        this.push(lane, chunk(e.summary, status === 'failed' ? 'fail' : 'info', accent), replay);
        break;
      }

      case 'tool_started':
        this.setStatus(lane, 'working', e.ts);
        lane.tools++;
        lane.activity = e.summary;
        this.push(lane, chunk(e.summary, e.toolUseId ? 'live' : 'ok'), replay);
        break;

      case 'tool_completed': {
        if (lane.status === 'waiting' || lane.status === 'idle') this.setStatus(lane, 'working', e.ts);
        const ok = e.ok !== false;
        if (!ok) lane.errors++;
        const resolved = e.toolUseId ? this.resolveTool(lane, e.toolUseId, ok, e.summary) : false;
        // Successful completions update the start chunk in place; only show a new
        // chunk for failures or when we never saw the start.
        if (!resolved) {
          if (!ok) this.push(lane, chunk(e.summary, 'fail', 'fail'), replay);
          else {
            lane.tools++;
            this.push(lane, chunk(e.summary, 'ok'), replay);
          }
        }
        if (!ok) lane.activity = e.summary;
        break;
      }

      case 'file_changed': {
        this.setStatus(lane, 'working', e.ts);
        lane.files += e.files?.length || 1;
        lane.activity = e.summary;
        const resolved = e.toolUseId ? this.resolveTool(lane, e.toolUseId, true) : false;
        if (!resolved) this.push(lane, chunk(e.summary, 'ok'), replay);
        break;
      }

      case 'approval_needed': {
        // Claude Code fires both PermissionRequest and a permission_prompt
        // notification for the same prompt; collapse near-duplicates.
        const dupe = lane.status === 'waiting' && e.ts - lane.statusSince < 4000;
        this.setStatus(lane, 'waiting', e.ts);
        lane.attention = e.summary;
        lane.activity = e.summary;
        if (!dupe) this.push(lane, chunk(e.summary, 'info', 'attention'), replay);
        break;
      }

      case 'subagent_started': {
        // e.agentId is the child; show a "spawned" chunk on the parent too.
        this.setStatus(lane, 'working', e.ts);
        lane.activity = 'starting up';
        this.push(lane, chunk(e.summary, 'info', 'spawn'), replay);
        const parent = laneById(this.state.lanes, e.parentAgentId);
        if (parent && parent.id !== lane.id) {
          const p = { ...parent };
          this.state.lanes = { ...this.state.lanes, [p.id]: p };
          this.push(p, { ...chunk(`spawned ${lane.name}`, 'info', 'spawn'), id: e.id + ':p' }, replay);
        }
        break;
      }

      case 'subagent_completed': {
        const ok = e.ok !== false;
        this.setStatus(lane, ok ? 'completed' : 'failed', e.ts);
        lane.activity = e.summary;
        this.push(lane, chunk(e.summary, ok ? 'ok' : 'fail', ok ? 'done' : 'fail'), replay);
        const parent = laneById(this.state.lanes, e.parentAgentId);
        if (parent && parent.id !== lane.id) {
          const p = { ...parent };
          this.state.lanes = { ...this.state.lanes, [p.id]: p };
          this.push(p, { ...chunk(`${lane.name} ${ok ? 'returned' : 'failed'}`, ok ? 'ok' : 'fail'), id: e.id + ':p' }, replay);
        }
        break;
      }

      case 'session_completed':
      case 'session_failed': {
        const status: AgentStatus = e.type === 'session_completed' ? 'completed' : 'failed';
        this.setStatus(lane, status, e.ts);
        lane.activity = e.summary;
        this.push(lane, chunk(e.summary, status === 'failed' ? 'fail' : 'ok', status === 'failed' ? 'fail' : 'done'), replay);
        // Close out children that never reported back.
        for (const id of this.state.order) {
          const l = this.state.lanes[id];
          if (l.sessionId === e.sessionId && l.id !== lane.id && (l.status === 'working' || l.status === 'waiting')) {
            const c = { ...l };
            this.setStatus(c, status, e.ts);
            this.state.lanes = { ...this.state.lanes, [c.id]: c };
          }
        }
        break;
      }
    }
  }

  /** Merge runs of same-kind chunks at the head of the queue when it's backed up. */
  private coalesce(queue: Chunk[]): Chunk[] {
    if (queue.length <= 3) return queue;
    const [first, ...rest] = queue;
    if (first.accent || first.state === 'live' || first.state === 'fail') return queue;
    const merged = { ...first, files: [...(first.files ?? [])] };
    let i = 0;
    while (i < rest.length && rest.length - i > 1) {
      const n = rest[i];
      if (n.kind !== first.kind || n.accent || n.state === 'fail' || n.state === 'live') break;
      merged.count += n.count;
      if (n.files) merged.files!.push(...n.files);
      i++;
    }
    if (i === 0) return queue;
    merged.text = plural[first.kind](merged.count);
    merged.id = `${first.id}+${i}`;
    return [merged, ...rest.slice(i)];
  }

  private tick() {
    const now = Date.now();
    let changed = false;

    // Idle detection runs even while paused so status stays truthful.
    for (const id of this.state.order) {
      const lane = this.state.lanes[id];
      if (lane.status === 'working' && now - lane.lastEventAt > IDLE_AFTER_MS) {
        const l = { ...lane };
        this.setStatus(l, 'idle', now);
        l.activity = 'no activity for a while';
        this.state.lanes = { ...this.state.lanes, [id]: l };
        changed = true;
      }
    }

    // Retire finished lanes: children individually, top-level lanes only once
    // the whole session is finished.
    const terminal = (l: Lane) => l.status === 'completed' || l.status === 'failed';
    const expired = (l: Lane) => terminal(l) && now - l.statusSince > (l.mock ? this.retireMockAfterMs : this.retireAfterMs);
    const retire = this.state.order.filter((id) => {
      const l = this.state.lanes[id];
      if (!expired(l)) return false;
      if (laneById(this.state.lanes, l.parentId)) return true;
      return this.state.order.every((o) => this.state.lanes[o].sessionId !== l.sessionId || expired(this.state.lanes[o]));
    });
    if (retire.length && !this.state.paused) {
      const lanes = { ...this.state.lanes };
      for (const id of retire) delete lanes[id];
      this.state.lanes = lanes;
      this.state.order = this.state.order.filter((id) => lanes[id]);
      changed = true;
    }

    if (!this.state.paused) {
      for (const id of this.state.order) {
        const lane = this.state.lanes[id];
        if (!lane.queue.length) continue;
        // Speed up release when the queue is long, but stay readable.
        const backlog = lane.queue.length;
        const interval = backlog > 8 ? this.releaseInterval * 0.45 : backlog > 3 ? this.releaseInterval * 0.7 : this.releaseInterval;
        if (now - (this.lastRelease[id] ?? 0) < interval) continue;
        const l = { ...lane };
        const q = this.coalesce(l.queue);
        const [next, ...rest] = q;
        l.queue = rest;
        l.chunks = [{ ...next, ts: Math.max(next.ts, now - 50) }, ...l.chunks].slice(0, MAX_VISIBLE);
        this.state.lanes = { ...this.state.lanes, [id]: l };
        this.lastRelease[id] = now;
        changed = true;
      }
    }
    if (changed) this.emit();
  }
}

export const store = new MatrixStore();

/** Lanes grouped by session, parents first, children right after their parent. */
export function groupLanes(state: MatrixState): { sessionId: string; lanes: { lane: Lane; depth: number }[] }[] {
  const bySession = new Map<string, Lane[]>();
  for (const id of state.order) {
    const lane = state.lanes[id];
    if (!bySession.has(lane.sessionId)) bySession.set(lane.sessionId, []);
    bySession.get(lane.sessionId)!.push(lane);
  }
  const groups: { sessionId: string; lanes: { lane: Lane; depth: number }[] }[] = [];
  for (const [sessionId, lanes] of bySession) {
    const ids = new Set(lanes.map((l) => l.id));
    const out: { lane: Lane; depth: number }[] = [];
    const visit = (l: Lane, depth: number, seen: Set<string>) => {
      if (seen.has(l.id)) return;
      seen.add(l.id);
      out.push({ lane: l, depth });
      for (const c of lanes) if (c.parentId === l.id) visit(c, depth + 1, seen);
    };
    const seen = new Set<string>();
    for (const l of lanes) if (!l.parentId || !ids.has(l.parentId)) visit(l, 0, seen);
    for (const l of lanes) if (!seen.has(l.id)) visit(l, 0, seen);
    groups.push({ sessionId, lanes: out });
  }
  return groups;
}
