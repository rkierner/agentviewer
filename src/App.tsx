import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { groupLanes, laneById, store, type Lane as LaneT } from './store';
import { MockFeed } from './mock';
import { clearCollector, useCollector } from './collector';
import { Lane, type Mode } from './components/Lane';
import { RainCanvas, type LaneRect } from './components/RainCanvas';
import type { AgentStatus } from '../shared/events';

const pref = {
  get<T extends string>(key: string, fallback: T): T {
    try {
      return (localStorage.getItem(`agentmatrix.${key}`) as T) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`agentmatrix.${key}`, value);
    } catch {
      /* storage unavailable */
    }
  },
};

const prefersReducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const AUTO_COLLAPSE_MS = 8000;

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const collector = useCollector(store);
  const [mode, setMode] = useState<Mode>(() => pref.get<Mode>('mode', prefersReducedMotion ? 'readable' : 'atmos'));
  const [mock, setMock] = useState<boolean>(() => pref.get('mock', 'on') === 'on');
  const [fullscreen, setFullscreen] = useState(false);
  const [help, setHelp] = useState(false);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [flashId, setFlashId] = useState<string | null>(null);
  const now = useNow(1000);
  const matrixRef = useRef<HTMLDivElement>(null);

  // Mock feed lifecycle.
  useEffect(() => {
    pref.set('mock', mock ? 'on' : 'off');
    if (!mock) {
      store.clear((l) => l.mock);
      return;
    }
    const feed = new MockFeed((evs) => store.ingest(evs));
    feed.start();
    return () => feed.stop();
  }, [mock]);

  useEffect(() => pref.set('mode', mode), [mode]);
  useEffect(() => {
    store.releaseInterval = mode === 'readable' ? 650 : 420;
  }, [mode]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);

  const clearAll = useCallback(() => {
    store.clear();
    setToggled({});
    void clearCollector();
  }, []);

  const togglePause = useCallback(() => store.setPaused(!store.getSnapshot().paused), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement)?.closest?.('input,textarea')) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePause();
          break;
        case 'c':
          clearAll();
          break;
        case 'm':
          setMock((m) => !m);
          break;
        case 'r':
          setMode((m) => (m === 'atmos' ? 'readable' : 'atmos'));
          break;
        case 'f':
          toggleFullscreen();
          break;
        case '?':
          setHelp((h) => !h);
          break;
        case 'Escape':
          setHelp(false);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePause, clearAll, toggleFullscreen]);

  const groups = useMemo(() => groupLanes(state), [state]);
  const lanes = state.order.map((id) => state.lanes[id]);
  const counts = useMemo(() => {
    const c: Record<AgentStatus, number> = { working: 0, waiting: 0, completed: 0, failed: 0, idle: 0 };
    for (const l of lanes) c[l.status]++;
    return c;
  }, [lanes]);
  const waiting = lanes.filter((l) => l.status === 'waiting');
  const queued = lanes.reduce((n, l) => n + l.queue.length, 0);

  // Attention in the tab title so it shows even when the window is in the background.
  useEffect(() => {
    document.title = waiting.length ? `(${waiting.length}) needs you · Agent Matrix` : 'Agent Matrix';
  }, [waiting.length]);

  const isCollapsed = (lane: LaneT, depth: number) => {
    if (Object.hasOwn(toggled, lane.id)) return toggled[lane.id];
    const done = lane.status === 'completed' || lane.status === 'failed';
    return depth > 0 && done && now - lane.statusSince > AUTO_COLLAPSE_MS;
  };

  const onToggle = useCallback(
    (id: string) => {
      setToggled((t) => {
        const lane = laneById(store.getSnapshot().lanes, id);
        const current = Object.hasOwn(t, id) ? t[id] : !!lane && !!lane.parentId && (lane.status === 'completed' || lane.status === 'failed') && Date.now() - lane.statusSince > AUTO_COLLAPSE_MS;
        return { ...t, [id]: !current };
      });
    },
    [],
  );

  const jumpTo = (id: string) => {
    const el = matrixRef.current?.querySelector(`[data-lane="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    setFlashId(id);
    setTimeout(() => setFlashId(null), 1600);
  };

  // The activity rain falls inside each expanded lane's stream area.
  const getLaneRects = useCallback((): LaneRect[] => {
    const root = matrixRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('[data-lane]:not(.collapsed)')).flatMap((el) => {
      const stream = el.querySelector('.stream');
      if (!stream) return [];
      const r = stream.getBoundingClientRect();
      return [{ id: el.dataset.lane!, left: r.left, right: r.right, top: r.top, bottom: r.bottom }];
    });
  }, []);

  return (
    <div className={`app mode-${mode} ${state.paused ? 'is-paused' : ''} ${fullscreen ? 'is-fullscreen' : ''}`}>
      {mode === 'atmos' && <RainCanvas store={store} getLaneRects={getLaneRects} />}
      <div className="vignette" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <span className="logo">AGENT</span>
          <span className="slash">//</span>
          <span className="logo dim">MATRIX</span>
        </div>
        <div className="tally" aria-label="Agent counts">
          <Tally n={counts.working} label="working" st="working" />
          <Tally n={counts.waiting} label="need you" st="waiting" />
          <Tally n={counts.failed} label="failed" st="failed" />
          <Tally n={counts.completed} label="done" st="completed" />
          <Tally n={counts.idle} label="idle" st="idle" />
        </div>
        <div className="controls">
          <span className={`collector c-${collector}`} title="Local event collector (npm run collector)">
            <span className="dot" /> collector {collector}
          </span>
          <button onClick={togglePause} aria-pressed={state.paused} title="Pause / resume the stream (Space)">
            {state.paused ? '▶ resume' : '❚❚ pause'}
            {state.paused && queued > 0 && <span className="badge">{queued}</span>}
          </button>
          <button onClick={clearAll} title="Clear all lanes and the collector buffer (C)">
            ⌫ clear
          </button>
          <button onClick={() => setMock((m) => !m)} aria-pressed={mock} className={mock ? 'on' : ''} title="Toggle mock agents (M)">
            {mock ? '◉' : '○'} mock
          </button>
          <button onClick={() => setMode((m) => (m === 'atmos' ? 'readable' : 'atmos'))} title="Atmospheric / readable mode (R)">
            {mode === 'atmos' ? '☰ readable' : '≋ atmos'}
          </button>
          <button onClick={toggleFullscreen} title="Full screen (F)">
            {fullscreen ? '⤡ exit' : '⤢ full'}
          </button>
          <button onClick={() => setHelp((h) => !h)} aria-label="Help" title="Shortcuts & help (?)">
            ?
          </button>
        </div>
      </header>

      {waiting.length > 0 && (
        <div className="attention" role="status" aria-live="polite">
          <span className="attn-icon">!</span>
          <span className="attn-label">
            {waiting.length === 1 ? '1 agent needs you' : `${waiting.length} agents need you`}
          </span>
          {waiting.map((l) => (
            <button key={l.id} className="attn-item" onClick={() => jumpTo(l.id)}>
              <b>{l.name}</b> <span>{l.attention ?? 'waiting'}</span>
            </button>
          ))}
        </div>
      )}

      {collector === 'locked' && (
        <div className="locked" role="status">
          Live agents are locked. Open the <code>#token=…</code> link printed by <code>npm run dev</code> or <code>npm start</code>.
        </div>
      )}

      <main className="matrix" ref={matrixRef}>
        {groups.length === 0 && (
          <div className="empty">
            <div className="empty-title">no agents on the wire</div>
            <p>
              Press <kbd>M</kbd> for mock agents, or connect Claude Code / Cursor hooks to the local collector
              <br />
              (<code>npm run setup:claude</code>, <code>npm run setup:cursor</code> — see README).
            </p>
            <p className="muted">collector: {collector}</p>
          </div>
        )}
        {groups.map((g) => {
          const root = g.lanes[0]?.lane;
          const children = g.lanes.filter((x) => x.depth > 0);
          return (
            <div className={`session ${children.length ? 'has-children' : ''}`} key={g.sessionId}>
              {g.lanes.map(({ lane, depth }) => {
                const parent = laneById(state.lanes, lane.parentId);
                const idx = children.findIndex((c) => c.lane.id === lane.id);
                return (
                  <Lane
                    key={lane.id}
                    lane={lane}
                    depth={depth}
                    parentName={parent?.name ?? (depth > 0 ? root?.name : undefined)}
                    mode={mode}
                    now={now}
                    collapsed={isCollapsed(lane, depth)}
                    flash={flashId === lane.id}
                    isFirstChild={idx === 0}
                    isLastChild={idx === children.length - 1 && idx >= 0}
                    onToggle={onToggle}
                  />
                );
              })}
            </div>
          );
        })}
      </main>

      <footer className="footline">
        <span>{state.paused ? `paused · ${queued} queued` : 'live'}</span>
        <span className="sep">/</span>
        <span>observable tool &amp; session events only — no prompts, reasoning, file contents or shell output</span>
        <span className="grow" />
        <span className="keys">
          <kbd>Space</kbd> pause <kbd>C</kbd> clear <kbd>M</kbd> mock <kbd>R</kbd> mode <kbd>F</kbd> full <kbd>?</kbd> help
        </span>
      </footer>

      {help && (
        <div className="help" role="dialog" aria-label="Help" onClick={() => setHelp(false)}>
          <div className="help-card" onClick={(e) => e.stopPropagation()}>
            <h3>Agent Matrix</h3>
            <p>Each vertical lane is one agent. Subagents sit beside their parent, joined by the bracket above them. New activity enters at the top and flows down; in atmos mode each activity also falls as a vertical column of its command or file ($ run, + edit, /search/, &gt;&gt; spawn, ? approval, x failure).</p>
            <ul className="legend">
              <li><span className="dot st-working" /> working</li>
              <li><span className="dot st-waiting" /> needs you — approval or input</li>
              <li><span className="dot st-failed" /> failed</li>
              <li><span className="dot st-completed" /> completed</li>
              <li><span className="dot st-idle" /> idle (no events for 90s)</li>
            </ul>
            <table>
              <tbody>
                <tr><td><kbd>Space</kbd></td><td>pause / resume the flow (status keeps updating)</td></tr>
                <tr><td><kbd>C</kbd></td><td>clear lanes and the collector buffer</td></tr>
                <tr><td><kbd>M</kbd></td><td>toggle mock agents</td></tr>
                <tr><td><kbd>R</kbd></td><td>atmospheric ↔ readable mode</td></tr>
                <tr><td><kbd>F</kbd></td><td>full screen</td></tr>
                <tr><td>double-click header</td><td>collapse / expand a lane</td></tr>
              </tbody>
            </table>
            <p className="muted">Collector: {collector}. Live events arrive from Claude Code and Cursor hooks via the local collector on 127.0.0.1.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Tally({ n, label, st }: { n: number; label: string; st: AgentStatus }) {
  return (
    <span className={`tally-item st-${st} ${n ? '' : 'zero'}`}>
      <b>{n}</b> {label}
    </span>
  );
}
