// Shared privacy filter used by the hook script (before anything leaves the
// agent process) and again by the collector (defence in depth).
//
// Strategy: allow-list. Only fields known to be useful for an activity
// summary survive; prompts, model output, file contents, diffs, tool output
// and transcripts are dropped. Strings that do survive are truncated and
// scrubbed of things that look like credentials.

// Order matters: specific forms run first, so the generic NAME=value rule can't
// consume "Authorization:" and leave the token behind.
const SECRET_RULES = [
  // Authorization and cookie headers
  [/((?:authorization|x-api-key)\s*:\s*)(?:bearer\s+|basic\s+)?(?:"[^"]*"|'[^']*'|\S+)/gi, '$1•••'],
  [/((?:set-)?cookie\s*:\s*)[^"'\n]+/gi, '$1•••'],
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1•••'],
  // user:pass@host in URLs
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1•••@'],
  // curl -u user:pass, --user=user:pass, --proxy-user user:pass
  [/((?:^|\s)(?:-u|-U|--user|--proxy-user)(?:=|\s+)?["']?[^\s:"']+:)[^\s"']+/g, '$1•••'],
  // curl -b / --cookie
  [/(\bcurl\b[^|;&]*?\s(?:-b|--cookie)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/g, '$1•••'],
  // Tool-specific -p flags (a generic rule would eat `mkdir -p dir`)
  [/(\bsshpass\b[^|;&]*?\s-p\s*)(?:"[^"]*"|'[^']*'|\S+)/g, '$1•••'],
  [/(\b(?:mysql\w*|mariadb\w*)\b[^|;&]*?\s-p)(?=\S)(?:"[^"]*"|'[^']*'|\S+)/g, '$1•••'],
  // echo secret | docker login --password-stdin
  [/(\b(?:echo|printf)\s+(?:-n\s+)?)(?:"[^"]*"|'[^']*'|\S+)(?=[^|]*\|[^|;&]*(?:--password-stdin|--passphrase-fd|chpasswd))/g, '$1•••'],
  // --password foo, --token=foo, --client-secret foo
  [/(--?(?:password|passwd|pass|token|api-key|apikey|secret|auth|key)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, '$1•••'],
  // aws configure set aws_secret_access_key foo
  [/\b(\w*_(?:secret|password|passwd|token|key)\w*|(?:secret|password|token)_\w+)\s+(?![=:&|;])(?:"[^"]*"|'[^']*'|\S+)/gi, '$1 •••'],
];
// key=value / key: value style assignments of sensitive names
const SECRET_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|COOKIE|CREDENTIALS?|(?<![A-Za-z])PASS(?![A-Za-z])|_KEY(?![A-Za-z]))[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi;
// Terminal escapes, other control characters, and invisible/bidi formatting.
const CONTROL_CHARS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩]/g;
const TOKEN_SHAPES = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, // OpenAI / Anthropic / Stripe style
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex blobs
];

export function scrub(input) {
  if (typeof input !== 'string') return input;
  // Strip first, so a control character can't split a secret past the rules.
  let s = input.replace(CONTROL_CHARS, '');
  for (const [re, to] of SECRET_RULES) s = s.replace(re, to);
  s = s.replace(SECRET_ASSIGNMENT, (m, k) => (m.includes('•••') ? m : `${k}=•••`));
  for (const re of TOKEN_SHAPES) s = s.replace(re, '•••');
  return s;
}

export function clip(s, n) {
  if (typeof s !== 'string') return undefined;
  const one = s.replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/** Only the first line, scrubbed and clipped — for shell commands. */
export function safeCommand(cmd, n = 160) {
  if (typeof cmd !== 'string') return undefined;
  const first = cmd.split('\n').find((l) => l.trim()) ?? '';
  const multi = cmd.trim().includes('\n');
  return clip(scrub(first), n) + (multi ? ' …' : '');
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

// Scrub before clipping, so truncation can't cut a secret out of a rule's reach.
const str = (v, n = 200) => (typeof v === 'string' ? clip(scrub(v), n) : undefined);
// Opaque ids are matched between events, so they are cleaned but never scrubbed.
const id = (v) => (typeof v === 'string' ? clip(v, 120) : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

/** tool_input allow-list (Claude Code + Cursor + MCP tools). */
function safeToolInput(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {
    file_path: str(input.file_path ?? input.filePath ?? input.target_file ?? input.path_to_file, 400),
    notebook_path: str(input.notebook_path, 400),
    path: str(input.path ?? input.directory, 400),
    pattern: input.pattern != null ? clip(scrub(String(input.pattern)), 60) : undefined,
    glob: str(input.glob, 80),
    command: safeCommand(input.command),
    description: input.description != null ? clip(scrub(String(input.description)), 90) : undefined,
    subagent_type: str(input.subagent_type, 60),
    url_host: hostOf(input.url) ?? str(input.url_host, 120),
    has_query: input.query != null || input.has_query === true ? true : undefined,
  };
  return prune(out);
}

function prune(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Reduce a raw hook payload to the minimum the visualizer needs.
 * Works for both providers; unknown fields are dropped.
 */
export function redactPayload(raw) {
  if (!raw || typeof raw !== 'object') return {};
  // Accept already-redacted payloads too (the collector re-runs this filter).
  const errorLine = typeof raw.error === 'string' ? raw.error.split('\n')[0] : typeof raw.error_exit === 'string' ? raw.error_exit : undefined;
  const out = {
    // shared / Claude Code
    hook_event_name: str(raw.hook_event_name, 60),
    session_id: id(raw.session_id),
    cwd: str(raw.cwd, 400),
    permission_mode: str(raw.permission_mode, 30),
    agent_id: id(raw.agent_id),
    agent_type: str(raw.agent_type, 80),
    tool_name: str(raw.tool_name, 120),
    tool_use_id: id(raw.tool_use_id),
    tool_input: safeToolInput(raw.tool_input),
    notification_type: str(raw.notification_type, 60),
    // Notification messages are short system strings like "Claude needs your permission to use Bash".
    message: raw.message != null ? clip(scrub(String(raw.message)), 120) : undefined,
    source: str(raw.source, 40),
    reason: str(raw.reason, 60),
    trigger: str(raw.trigger, 30),
    duration_ms: num(raw.duration_ms) ?? num(raw.duration),
    is_interrupt: bool(raw.is_interrupt),
    // Only "Exit code N" style first lines survive; anything else becomes a flag.
    error_exit: errorLine && /^exit code \d+/i.test(errorLine) ? clip(errorLine, 30) : undefined,
    has_error: raw.error != null || raw.has_error === true ? true : undefined,
    session_title: raw.session_title != null ? clip(scrub(String(raw.session_title)), 60) : undefined,
    // Cursor
    conversation_id: id(raw.conversation_id),
    generation_id: id(raw.generation_id),
    workspace_roots: Array.isArray(raw.workspace_roots) ? raw.workspace_roots.slice(0, 3).map((r) => str(String(r), 400)) : undefined,
    command: safeCommand(raw.command),
    file_path: str(raw.file_path, 400),
    edit_count: Array.isArray(raw.edits) ? raw.edits.length : num(raw.edit_count),
    status: str(raw.status, 30),
    loop_count: num(raw.loop_count),
    exit_code: num(raw.exit_code) ?? num(raw.exitCode),
    attachment_count: Array.isArray(raw.attachments) ? raw.attachments.length : num(raw.attachment_count),
    subagent_id: id(raw.subagent_id),
    subagent_type: str(raw.subagent_type, 80),
    parent_conversation_id: id(raw.parent_conversation_id),
  };
  return prune(out) ?? {};
}
