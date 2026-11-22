/**
 * Claude Code hook adapter.
 *
 * Input: the (already redacted) JSON a Claude Code command hook receives on
 * stdin. Event and field names follow https://code.claude.com/docs/en/hooks:
 * common fields session_id, cwd, hook_event_name, plus agent_id / agent_type
 * when the hook fires inside a subagent.
 */
import { makeId, type AgentEvent } from '../../shared/events.ts';
import { shortId, summarizeTool, workspaceName } from './common.ts';

type P = Record<string, any>;

export class ClaudeAdapter {
  /** tool_use_ids whose completion we have already seen (async hooks can race). */
  private completed = new Set<string>();
  private labels = new Map<string, string>();

  private remember(id: string) {
    this.completed.add(id);
    if (this.completed.size > 5000) this.completed.delete(this.completed.values().next().value as string);
  }

  toEvents(p: P, receivedAt = Date.now()): AgentEvent[] {
    const name: string = p.hook_event_name ?? '';
    const sessionId: string = p.session_id ?? 'unknown';
    const mainId = `cc:${sessionId}`;
    const inSubagent = typeof p.agent_id === 'string' && p.agent_id.length > 0;
    const agentId = inSubagent ? `${mainId}:${p.agent_id}` : mainId;
    const cwd: string | undefined = p.cwd;

    if (!this.labels.has(mainId)) this.labels.set(mainId, `${workspaceName(cwd)} · ${shortId(sessionId)}`);
    if (p.session_title) this.labels.set(mainId, `${workspaceName(cwd)} · ${p.session_title}`);
    const subLabel = p.agent_type || 'subagent';

    const ev = (type: AgentEvent['type'], summary: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({
      v: 1,
      id: makeId('cc'),
      ts: receivedAt,
      provider: 'claude-code',
      type,
      sessionId,
      agentId,
      parentAgentId: inSubagent ? mainId : undefined,
      label: inSubagent ? subLabel : this.labels.get(mainId),
      summary,
      cwd,
      ...extra,
    });

    switch (name) {
      case 'SessionStart':
        return [ev('session_started', p.source && p.source !== 'startup' ? `session started (${p.source})` : 'session started', { status: 'idle', kind: 'status' })];

      case 'UserPromptSubmit':
        // Never forward the prompt text; just note that work started.
        return [ev('agent_status_changed', 'new prompt received', { status: 'working', kind: 'status' })];

      case 'PreToolUse': {
        if (p.tool_use_id && this.completed.has(p.tool_use_id)) return [];
        const s = summarizeTool(p.tool_name, p.tool_input, cwd);
        return [ev('tool_started', s.active, { tool: p.tool_name, toolUseId: p.tool_use_id, kind: s.kind, files: s.files })];
      }

      case 'PostToolUse': {
        if (p.tool_use_id) this.remember(p.tool_use_id);
        const s = summarizeTool(p.tool_name, p.tool_input, cwd);
        const common = { tool: p.tool_name, toolUseId: p.tool_use_id, kind: s.kind, files: s.files, durationMs: p.duration_ms };
        if (s.isFileWrite) return [ev('file_changed', s.past, common)];
        return [ev('tool_completed', s.past, { ...common, ok: true })];
      }

      case 'PostToolUseFailure': {
        if (p.tool_use_id) this.remember(p.tool_use_id);
        const s = summarizeTool(p.tool_name, p.tool_input, cwd);
        const why = p.is_interrupt ? 'interrupted' : p.error_exit ? p.error_exit.toLowerCase() : 'failed';
        return [
          ev('tool_completed', `${s.past.replace(/^(ran|read|edited|wrote|searched|found|fetched) /, '')} · ${why}`, {
            tool: p.tool_name,
            toolUseId: p.tool_use_id,
            kind: s.kind,
            files: s.files,
            ok: false,
            durationMs: p.duration_ms,
          }),
        ];
      }

      case 'PermissionRequest': {
        const s = summarizeTool(p.tool_name, p.tool_input, cwd);
        return [ev('approval_needed', `needs approval · ${s.active}`, { tool: p.tool_name, kind: 'approval', files: s.files })];
      }

      case 'Notification':
        switch (p.notification_type) {
          case 'permission_prompt':
            return [ev('approval_needed', p.message ?? 'needs your permission', { kind: 'approval' })];
          case 'idle_prompt':
            return [ev('agent_status_changed', 'waiting for your input', { status: 'waiting', kind: 'status' })];
          case 'elicitation_dialog':
          case 'elicitation_url_dialog':
          case 'agent_needs_input':
            return [ev('approval_needed', p.message ?? 'needs your input', { kind: 'approval' })];
          default:
            return [];
        }

      case 'SubagentStart':
        return [
          ev('subagent_started', `${subLabel} started`, {
            agentId: `${mainId}:${p.agent_id}`,
            parentAgentId: mainId,
            label: subLabel,
            status: 'working',
            kind: 'delegate',
          }),
        ];

      case 'SubagentStop':
        return [
          ev('subagent_completed', `${subLabel} finished`, {
            agentId: `${mainId}:${p.agent_id}`,
            parentAgentId: mainId,
            label: subLabel,
            ok: true,
          }),
        ];

      case 'Stop':
        return [ev('agent_status_changed', 'turn complete · awaiting next prompt', { status: 'completed', kind: 'status' })];

      case 'StopFailure':
        return [ev('session_failed', 'turn failed (API error)', { status: 'failed', kind: 'status' })];

      case 'PreCompact':
        return [ev('agent_status_changed', `compacting context (${p.trigger ?? 'auto'})`, { status: 'working', kind: 'status' })];

      case 'SessionEnd':
        return [ev('session_completed', `session ended${p.reason ? ` (${p.reason})` : ''}`, { status: 'completed' })];

      default:
        return [];
    }
  }
}
