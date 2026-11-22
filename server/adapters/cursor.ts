/**
 * Cursor hook adapter.
 *
 * ⚠ UNVERIFIED SCHEMA. The official Cursor hooks page (cursor.com/docs/agent/hooks)
 * could not be fetched from the environment this adapter was written in, so
 * the event and field names below come from Cursor's published hooks
 * design as of late 2025 (hooks.json "version": 1; events such as
 * beforeSubmitPrompt, beforeShellExecution, afterShellExecution,
 * beforeMCPExecution, afterMCPExecution, beforeReadFile, afterFileEdit, stop;
 * common fields conversation_id, generation_id, hook_event_name,
 * workspace_roots). It is deliberately tolerant: unknown events are ignored,
 * and alternative field spellings are accepted. Check it against the current
 * docs before relying on it — see README "Cursor limitations".
 */
import { makeId, type AgentEvent } from '../../shared/events.ts';
import { displayPath, base, shortId, summarizeTool, workspaceName } from './common.ts';

type P = Record<string, any>;

export class CursorAdapter {
  /** Cursor's before/after shell hooks share no id, so pair them by command. */
  private pendingShell = new Map<string, string[]>();
  private pendingMcp = new Map<string, string[]>();

  private push(map: Map<string, string[]>, key: string, id: string) {
    const list = map.get(key) ?? [];
    list.push(id);
    map.set(key, list.slice(-20));
    if (map.size > 500) map.delete(map.keys().next().value as string);
  }
  private pop(map: Map<string, string[]>, key: string) {
    const list = map.get(key);
    const id = list?.shift();
    if (list && !list.length) map.delete(key);
    return id;
  }

  toEvents(p: P, receivedAt = Date.now()): AgentEvent[] {
    const name: string = p.hook_event_name ?? '';
    const conv: string = p.conversation_id ?? p.session_id ?? 'unknown';
    const cwd: string | undefined = p.workspace_roots?.[0] ?? p.cwd;
    const mainId = `cursor:${conv}`;
    const subId = p.subagent_id ?? (p.parent_conversation_id ? conv : undefined);
    const sessionId = p.parent_conversation_id ?? conv;
    const rootId = `cursor:${sessionId}`;
    const agentId = subId ? `${rootId}:${subId}` : mainId;
    const label = subId ? p.subagent_type || 'subagent' : `${workspaceName(cwd)} · ${shortId(conv)}`;

    const ev = (type: AgentEvent['type'], summary: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({
      v: 1,
      id: makeId('cur'),
      ts: receivedAt,
      provider: 'cursor',
      type,
      sessionId,
      agentId,
      parentAgentId: subId ? rootId : undefined,
      label,
      summary,
      cwd,
      ...extra,
    });

    switch (name) {
      case 'sessionStart':
        return [ev('session_started', 'conversation started', { status: 'idle', kind: 'status' })];

      case 'beforeSubmitPrompt':
        return [ev('agent_status_changed', 'new prompt received', { status: 'working', kind: 'status' })];

      case 'beforeShellExecution': {
        const id = makeId('sh');
        if (p.command) this.push(this.pendingShell, p.command, id);
        const s = summarizeTool('Shell', { command: p.command }, cwd);
        return [ev('tool_started', s.active, { tool: 'Shell', toolUseId: id, kind: 'run' })];
      }

      case 'afterShellExecution': {
        const id = p.command ? this.pop(this.pendingShell, p.command) : undefined;
        const s = summarizeTool('Shell', { command: p.command }, cwd);
        const failed = typeof p.exit_code === 'number' && p.exit_code !== 0;
        return [
          ev('tool_completed', failed ? `${s.past.replace(/^ran /, '')} · exit ${p.exit_code}` : s.past, {
            tool: 'Shell',
            toolUseId: id,
            kind: 'run',
            ok: !failed,
            durationMs: p.duration_ms,
          }),
        ];
      }

      case 'beforeMCPExecution': {
        const id = makeId('mcp');
        const key = p.tool_name ?? 'mcp';
        this.push(this.pendingMcp, key, id);
        return [ev('tool_started', `mcp › ${key}`, { tool: key, toolUseId: id, kind: 'other' })];
      }

      case 'afterMCPExecution': {
        const key = p.tool_name ?? 'mcp';
        return [ev('tool_completed', `mcp › ${key}`, { tool: key, toolUseId: this.pop(this.pendingMcp, key), kind: 'other', ok: !p.has_error })];
      }

      case 'beforeReadFile': {
        const fp = displayPath(p.file_path, cwd);
        return [ev('tool_completed', `read ${fp ? base(fp) : 'file'}`, { tool: 'read_file', kind: 'read', files: fp ? [fp] : undefined, ok: true })];
      }

      case 'afterFileEdit': {
        const fp = displayPath(p.file_path, cwd);
        const n = p.edit_count;
        return [
          ev('file_changed', `edited ${fp ? base(fp) : 'file'}${n && n > 1 ? ` (${n} edits)` : ''}`, {
            tool: 'edit_file',
            kind: 'edit',
            files: fp ? [fp] : undefined,
          }),
        ];
      }

      // Generic tool hooks (newer Cursor versions).
      case 'preToolUse': {
        const s = summarizeTool(p.tool_name, p.tool_input, cwd);
        return [ev('tool_started', s.active, { tool: p.tool_name, toolUseId: p.tool_use_id, kind: s.kind, files: s.files })];
      }
      case 'postToolUse': {
        const s = summarizeTool(p.tool_name, p.tool_input, cwd);
        if (s.isFileWrite) return [ev('file_changed', s.past, { tool: p.tool_name, toolUseId: p.tool_use_id, kind: s.kind, files: s.files })];
        return [ev('tool_completed', s.past, { tool: p.tool_name, toolUseId: p.tool_use_id, kind: s.kind, files: s.files, ok: true })];
      }
      case 'postToolUseFailure': {
        const s = summarizeTool(p.tool_name, p.tool_input, cwd);
        return [ev('tool_completed', `${p.tool_name ?? 'tool'} failed`, { tool: p.tool_name, toolUseId: p.tool_use_id, kind: s.kind, files: s.files, ok: false })];
      }

      case 'subagentStart':
        return [ev('subagent_started', `${label} started`, { status: 'working', kind: 'delegate' })];
      case 'subagentStop':
        return [ev('subagent_completed', `${label} finished`, { ok: p.status !== 'error' })];

      case 'stop': {
        const status = p.status;
        if (status === 'error') return [ev('session_failed', 'stopped · error', { status: 'failed' })];
        if (status === 'aborted') return [ev('agent_status_changed', 'stopped · aborted', { status: 'idle', kind: 'status' })];
        return [ev('agent_status_changed', 'turn complete · awaiting next prompt', { status: 'completed', kind: 'status' })];
      }

      case 'sessionEnd':
        return [ev('session_completed', 'conversation ended', { status: 'completed' })];

      // afterAgentResponse / afterAgentThought carry model text: intentionally ignored.
      default:
        return [];
    }
  }
}
