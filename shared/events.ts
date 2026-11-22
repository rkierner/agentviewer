/**
 * Provider-neutral event format for Agent Matrix.
 *
 * Every provider adapter (Claude Code, Cursor, mock, anything else) converts
 * its native hook payloads into `AgentEvent`s. The UI only understands this
 * format, so adding a new provider means writing one adapter.
 *
 * Privacy contract: an AgentEvent carries *observable activity only* — a short
 * human-readable summary, tool names, touched file paths and status changes.
 * It must never contain raw prompts, model reasoning, full file contents,
 * secrets or complete shell output. Adapters are responsible for enforcing it.
 */

export const EVENT_TYPES = [
  'session_started',
  'agent_started',
  'agent_status_changed',
  'tool_started',
  'tool_completed',
  'file_changed',
  'approval_needed',
  'subagent_started',
  'subagent_completed',
  'session_completed',
  'session_failed',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** "waiting" means waiting for the human (approval, input, next prompt). */
export const AGENT_STATUSES = ['working', 'waiting', 'completed', 'failed', 'idle'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Coarse activity category, used for icons, colour and coalescing. */
export const ACTIVITY_KINDS = [
  'read',
  'search',
  'edit',
  'run',
  'web',
  'delegate',
  'approval',
  'status',
  'other',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface AgentEvent {
  /** Schema version. */
  v: 1;
  /** Unique id (adapters generate one if the provider has none). */
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  /** e.g. "claude-code", "cursor", "mock". Free-form so new providers need no schema change. */
  provider: string;
  type: EventType;
  /** Groups lanes: one session = one top-level agent plus its subagents. */
  sessionId: string;
  /** The lane this event belongs to. */
  agentId: string;
  /** Set for subagents (and on subagent_started / subagent_completed). */
  parentAgentId?: string;
  /** Display name for the agent / lane. */
  label?: string;
  /** For agent_status_changed (and optionally others). */
  status?: AgentStatus;
  /** Short, already-sanitised, human readable text: "reading routes.ts". */
  summary: string;
  kind?: ActivityKind;
  /** Native tool name, e.g. "Read", "Bash", "Shell", "mcp__github__get_issue". */
  tool?: string;
  /** Lets tool_completed update the matching tool_started chunk. */
  toolUseId?: string;
  /** Touched file paths (paths only, never contents). */
  files?: string[];
  /** For tool_completed: success or failure. */
  ok?: boolean;
  durationMs?: number;
  /** Working directory / workspace root, used for naming. */
  cwd?: string;
  /** True for synthetic demo events. */
  mock?: boolean;
}

let counter = 0;
export function makeId(prefix = 'ev'): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Light runtime validation for events posted directly to the collector. */
export function isAgentEvent(x: unknown): x is AgentEvent {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.type === 'string' &&
    (EVENT_TYPES as readonly string[]).includes(e.type) &&
    typeof e.sessionId === 'string' &&
    typeof e.agentId === 'string' &&
    typeof e.summary === 'string'
  );
}

/** Fill defaults and clamp sizes so a misbehaving client can't flood the UI. */
export function normalizeEvent(e: AgentEvent): AgentEvent {
  const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
  return {
    ...e,
    v: 1,
    id: e.id || makeId(),
    ts: typeof e.ts === 'number' ? e.ts : Date.now(),
    provider: clip(e.provider || 'unknown', 32)!,
    summary: clip(e.summary, 140)!,
    label: clip(e.label, 48),
    tool: clip(e.tool, 64),
    files: e.files?.slice(0, 12).map((f) => clip(f, 260)!),
    status: e.status && (AGENT_STATUSES as readonly string[]).includes(e.status) ? e.status : undefined,
    kind: e.kind && (ACTIVITY_KINDS as readonly string[]).includes(e.kind) ? e.kind : undefined,
  };
}
