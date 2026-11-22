import { makeId, type ActivityKind, type AgentEvent, type AgentStatus, type EventType } from '../shared/events';

/**
 * Synthetic multi-agent activity so the matrix is alive before any real agent
 * is connected. Emits the same canonical AgentEvents the collector produces.
 */

type Emit = (events: AgentEvent[]) => void;

const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Ctx {
  provider: string;
  sessionId: string;
  agentId: string;
  parentAgentId?: string;
  label: string;
  cwd: string;
}

const REPOS = {
  api: {
    cwd: '~/code/orders-api',
    files: ['src/routes.ts', 'src/auth.ts', 'src/middleware/session.ts', 'src/db/orders.ts', 'test/auth.test.ts', 'src/config.ts', 'package.json'],
    cmds: ['npm test', 'npm run lint', 'npx tsc --noEmit', 'git diff --stat', 'npm test -- auth'],
    searches: ['verifyToken', 'SESSION_TTL', 'TODO', 'orderId'],
  },
  web: {
    cwd: '~/code/dashboard-web',
    files: ['app/page.tsx', 'components/Chart.tsx', 'components/Sidebar.tsx', 'lib/fetcher.ts', 'styles/globals.css', 'app/layout.tsx'],
    cmds: ['pnpm dev', 'pnpm build', 'pnpm test --run', 'pnpm exec eslint .'],
    searches: ['useSWR', 'className=', 'ChartProps'],
  },
  docs: {
    cwd: '~/code/handbook',
    files: ['docs/getting-started.md', 'docs/api/auth.md', 'mkdocs.yml', 'docs/index.md', 'docs/deploy.md'],
    cmds: ['mkdocs build --strict', 'npx markdownlint docs', 'git status'],
    searches: ['deprecated', 'v1/', 'TODO'],
  },
  billing: {
    cwd: '~/code/billing-service',
    files: ['migrations/0042_invoices.sql', 'billing/models.py', 'billing/tasks.py', 'tests/test_invoices.py', 'settings.py'],
    cmds: ['pytest -q', 'python manage.py migrate --plan', 'ruff check .', 'alembic upgrade head'],
    searches: ['Invoice(', 'currency', 'stripe_id'],
  },
} as const;

type Repo = (typeof REPOS)[keyof typeof REPOS];

export class MockFeed {
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private running = false;
  private emit: Emit;

  constructor(emit: Emit) {
    this.emit = emit;
  }

  private ev(ctx: Ctx, type: EventType, summary: string, extra: Partial<AgentEvent> = {}): AgentEvent {
    return {
      v: 1,
      id: makeId('mock'),
      ts: Date.now(),
      provider: ctx.provider,
      type,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      parentAgentId: ctx.parentAgentId,
      label: ctx.label,
      summary,
      cwd: ctx.cwd,
      mock: true,
      ...extra,
    };
  }

  private wait(ms: number) {
    return new Promise<void>((resolve, reject) => {
      if (!this.running) return reject(new Error('stopped'));
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.running ? resolve() : reject(new Error('stopped'));
      }, ms);
      this.timers.add(t);
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    const run = (fn: () => Promise<void>) => fn().catch(() => {});
    // Deferred so a start/stop/start (React StrictMode) doesn't double-emit.
    this.wait(60)
      .then(() => {
        run(() => this.claudeRefactor());
        run(() => this.cursorWeb());
        run(() => this.claudeDocs());
        run(() => this.cursorBilling());
      })
      .catch(() => {});
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** One tool call: start, pause, complete (sometimes fail). */
  private async tool(ctx: Ctx, repo: Repo, kind?: ActivityKind, failRate = 0.05) {
    const k = kind ?? pick<ActivityKind>(['read', 'read', 'read', 'search', 'edit', 'edit', 'run']);
    const toolUseId = makeId('tu');
    let tool = 'Read';
    let summary = '';
    let files: string[] | undefined;
    const file = pick(repo.files);
    const base = file.split('/').pop()!;
    switch (k) {
      case 'read':
        tool = ctx.provider === 'cursor' ? 'read_file' : 'Read';
        summary = `reading ${base}`;
        files = [file];
        break;
      case 'search':
        tool = 'Grep';
        summary = `searching "${pick(repo.searches)}"`;
        break;
      case 'edit':
        tool = ctx.provider === 'cursor' ? 'edit_file' : 'Edit';
        summary = `editing ${base}`;
        files = [file];
        break;
      case 'run':
        tool = ctx.provider === 'cursor' ? 'Shell' : 'Bash';
        summary = `running ${pick(repo.cmds)}`;
        break;
      case 'web':
        tool = 'WebFetch';
        summary = 'fetching developer.mozilla.org';
        break;
      default:
        summary = 'tool call';
    }
    this.emit([this.ev(ctx, 'tool_started', summary, { tool, toolUseId, kind: k, files })]);
    await this.wait(k === 'run' ? rand(1600, 4200) : rand(250, 1100));
    const ok = Math.random() > failRate;
    if (k === 'edit' && ok) {
      this.emit([this.ev(ctx, 'file_changed', `edited ${base}`, { tool, toolUseId, kind: 'edit', files })]);
    } else {
      const done = ok ? summary : k === 'run' ? `${summary.replace('running ', '')} failed (exit 1)` : `${tool} failed`;
      this.emit([this.ev(ctx, 'tool_completed', done, { tool, toolUseId, kind: k, ok, files })]);
    }
    return ok;
  }

  private async burst(ctx: Ctx, repo: Repo, n: number) {
    // Rapid-fire reads to exercise coalescing.
    for (let i = 0; i < n; i++) {
      const file = repo.files[i % repo.files.length];
      this.emit([
        this.ev(ctx, 'tool_completed', `read ${file.split('/').pop()}`, { tool: 'Read', kind: 'read', files: [file], ok: true }),
      ]);
      await this.wait(rand(30, 90));
    }
  }

  private status(ctx: Ctx, status: AgentStatus, summary: string) {
    this.emit([this.ev(ctx, 'agent_status_changed', summary, { status, kind: 'status' })]);
  }

  // ── Scenario 1: Claude Code refactor with two subagents ────────────────────
  private async claudeRefactor() {
    const sessionId = 'mock-cc-refactor';
    const main: Ctx = { provider: 'claude-code', sessionId, agentId: `${sessionId}:main`, label: 'orders-api · auth refactor', cwd: REPOS.api.cwd };
    const repo = REPOS.api;
    this.emit([this.ev(main, 'session_started', 'session started', { status: 'idle' })]);
    await this.wait(900);
    for (;;) {
      this.status(main, 'working', 'new prompt received');
      await this.wait(600);
      for (let i = 0; i < 3; i++) await this.tool(main, repo, 'read');
      await this.tool(main, repo, 'search');

      // Fan out to subagents.
      const explore: Ctx = { ...main, agentId: `${sessionId}:explore-${makeId('a')}`, parentAgentId: main.agentId, label: 'Explore' };
      const tester: Ctx = { ...main, agentId: `${sessionId}:tests-${makeId('a')}`, parentAgentId: main.agentId, label: 'test-runner' };
      this.emit([
        this.ev(main, 'tool_started', 'delegating: map session handling', { tool: 'Agent', kind: 'delegate' }),
        this.ev(explore, 'subagent_started', 'Explore subagent started', { kind: 'delegate', status: 'working' }),
      ]);
      await this.wait(700);
      this.emit([this.ev(tester, 'subagent_started', 'test-runner subagent started', { kind: 'delegate', status: 'working' })]);

      const exploreWork = (async () => {
        await this.burst(explore, repo, 9);
        for (let i = 0; i < 4; i++) await this.tool(explore, repo, pick<ActivityKind>(['read', 'search']));
        this.emit([this.ev(explore, 'subagent_completed', 'finished · 3 findings', { ok: true })]);
      })();
      const testWork = (async () => {
        await this.tool(tester, repo, 'run', 0.35);
        await this.tool(tester, repo, 'read');
        await this.tool(tester, repo, 'run', 0.1);
        this.emit([this.ev(tester, 'subagent_completed', 'finished · 41 passed', { ok: true })]);
      })();
      await Promise.all([exploreWork, testWork]);

      for (let i = 0; i < 3; i++) await this.tool(main, repo, 'edit');
      await this.tool(main, repo, 'run', 0.15);
      this.status(main, 'completed', 'turn complete · awaiting next prompt');
      await this.wait(rand(7000, 11000));
    }
  }

  // ── Scenario 2: Cursor agent on a frontend, steady work ────────────────────
  private async cursorWeb() {
    const sessionId = 'mock-cursor-web';
    const ctx: Ctx = { provider: 'cursor', sessionId, agentId: `${sessionId}:main`, label: 'dashboard-web · chart polish', cwd: REPOS.web.cwd };
    await this.wait(1500);
    this.emit([this.ev(ctx, 'session_started', 'conversation started', { status: 'idle' })]);
    await this.wait(500);
    for (;;) {
      this.status(ctx, 'working', 'new prompt received');
      const n = Math.floor(rand(6, 12));
      for (let i = 0; i < n; i++) {
        await this.tool(ctx, REPOS.web);
        await this.wait(rand(200, 900));
      }
      this.status(ctx, 'completed', 'stopped · completed');
      await this.wait(rand(5000, 9000));
    }
  }

  // ── Scenario 3: Claude Code docs agent that keeps needing approval ─────────
  private async claudeDocs() {
    const sessionId = 'mock-cc-docs';
    const ctx: Ctx = { provider: 'claude-code', sessionId, agentId: `${sessionId}:main`, label: 'handbook · docs sweep', cwd: REPOS.docs.cwd };
    await this.wait(2600);
    this.emit([this.ev(ctx, 'session_started', 'session started', { status: 'idle' })]);
    for (;;) {
      this.status(ctx, 'working', 'new prompt received');
      for (let i = 0; i < 4; i++) await this.tool(ctx, REPOS.docs, pick<ActivityKind>(['read', 'edit', 'search']));
      this.emit([
        this.ev(ctx, 'approval_needed', 'approval needed: Bash git push origin docs-sweep', { tool: 'Bash', kind: 'approval' }),
      ]);
      // Simulate the human taking a while to approve.
      await this.wait(rand(9000, 15000));
      this.status(ctx, 'working', 'approved · continuing');
      await this.tool(ctx, REPOS.docs, 'run', 0);
      await this.tool(ctx, REPOS.docs, 'web', 0);
      await this.wait(rand(1500, 3000));
    }
  }

  // ── Scenario 4: Cursor migration that fails, then gets retried ────────────
  private async cursorBilling() {
    for (let attempt = 1; ; attempt++) {
      const sessionId = `mock-cursor-billing-${attempt}`;
      const ctx: Ctx = { provider: 'cursor', sessionId, agentId: `${sessionId}:main`, label: `billing · migration #${attempt}`, cwd: REPOS.billing.cwd };
      await this.wait(attempt === 1 ? 3800 : 4000);
      this.emit([this.ev(ctx, 'session_started', 'conversation started', { status: 'working' })]);
      for (let i = 0; i < 6; i++) await this.tool(ctx, REPOS.billing, pick<ActivityKind>(['read', 'edit', 'search']), 0);
      const migrated = await this.tool(ctx, REPOS.billing, 'run', 0.6);
      if (!migrated) {
        await this.wait(800);
        this.emit([this.ev(ctx, 'session_failed', 'stopped · error', { status: 'failed' })]);
        await this.wait(14000);
        continue;
      }
      await this.tool(ctx, REPOS.billing, 'run', 0);
      this.emit([this.ev(ctx, 'session_completed', 'stopped · completed', { status: 'completed' })]);
      await this.wait(20000);
    }
  }
}
