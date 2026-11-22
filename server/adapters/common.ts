import path from 'node:path';
import type { ActivityKind } from '../../shared/events.ts';
import { clip, safeCommand } from '../../hooks/redact.mjs';

/** Show paths relative to the workspace when possible (shorter, less personal). */
export function displayPath(file: string | undefined, cwd?: string): string | undefined {
  if (!file) return undefined;
  if (cwd && path.isAbsolute(file)) {
    const rel = path.relative(cwd, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  const home = process.env.HOME;
  if (home && file.startsWith(home + path.sep)) return '~' + file.slice(home.length);
  return file;
}

export const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function workspaceName(cwd?: string) {
  return cwd ? base(cwd) : 'session';
}

export interface ToolSummary {
  kind: ActivityKind;
  /** "reading routes.ts" */
  active: string;
  /** "read routes.ts" (used when we only see the completion) */
  past: string;
  files?: string[];
  isFileWrite?: boolean;
}

/** Turn a (redacted) tool call into a short readable phrase. */
export function summarizeTool(tool: string, input: Record<string, any> | undefined, cwd?: string): ToolSummary {
  const t = tool || 'tool';
  const fp = displayPath(input?.file_path ?? input?.notebook_path, cwd);
  const file = fp ? base(fp) : undefined;
  const files = fp ? [fp] : undefined;
  const lower = t.toLowerCase();

  if (t.startsWith('mcp__')) {
    const [, server, ...rest] = t.split('__');
    const name = rest.join('__') || 'tool';
    return { kind: 'other', active: `mcp ${server} › ${name}`, past: `mcp ${server} › ${name}` };
  }
  switch (lower) {
    case 'read':
    case 'read_file':
    case 'notebookread':
      return { kind: 'read', active: `reading ${file ?? 'file'}`, past: `read ${file ?? 'file'}`, files };
    case 'edit':
    case 'multiedit':
    case 'edit_file':
    case 'search_replace':
    case 'notebookedit':
      return { kind: 'edit', active: `editing ${file ?? 'file'}`, past: `edited ${file ?? 'file'}`, files, isFileWrite: true };
    case 'write':
    case 'write_file':
    case 'create_file':
      return { kind: 'edit', active: `writing ${file ?? 'file'}`, past: `wrote ${file ?? 'file'}`, files, isFileWrite: true };
    case 'bash':
    case 'powershell':
    case 'shell':
    case 'run_terminal_cmd': {
      const cmd = input?.command ? clip(safeCommand(input.command, 70), 70) : undefined;
      return { kind: 'run', active: cmd ? `running ${cmd}` : 'running a command', past: cmd ? `ran ${cmd}` : 'ran a command' };
    }
    case 'grep':
    case 'search':
    case 'codebase_search':
    case 'grep_search': {
      const p = input?.pattern ? `"${input.pattern}"` : 'code';
      return { kind: 'search', active: `searching ${p}`, past: `searched ${p}` };
    }
    case 'glob':
    case 'ls':
    case 'list_dir':
    case 'file_search': {
      const p = input?.pattern ?? (input?.path ? base(String(input.path)) : 'files');
      return { kind: 'search', active: `finding ${p}`, past: `found ${p}` };
    }
    case 'webfetch':
      return { kind: 'web', active: `fetching ${input?.url_host ?? 'a page'}`, past: `fetched ${input?.url_host ?? 'a page'}` };
    case 'websearch':
    case 'web_search':
      return { kind: 'web', active: 'searching the web', past: 'searched the web' };
    case 'agent':
    case 'task': {
      const d = input?.description ?? input?.subagent_type ?? 'subtask';
      return { kind: 'delegate', active: `delegating: ${d}`, past: `delegated: ${d}` };
    }
    case 'todowrite':
      return { kind: 'status', active: 'updating plan', past: 'updated plan' };
    case 'askuserquestion':
      return { kind: 'approval', active: 'asking you a question', past: 'asked a question' };
    case 'exitplanmode':
      return { kind: 'approval', active: 'presenting plan', past: 'presented plan' };
    default:
      return { kind: 'other', active: `${lower}`, past: `${lower}` };
  }
}

export function shortId(id: string) {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4);
}
