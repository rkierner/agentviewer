import { memo, useEffect, useRef, useState } from 'react';
import type { Chunk, Lane as LaneT } from '../store';
import type { ActivityKind, AgentStatus } from '../../shared/events';

export type Mode = 'atmos' | 'readable';

const TAG: Record<ActivityKind, string> = {
  read: 'READ',
  search: 'FIND',
  edit: 'EDIT',
  run: 'RUN',
  web: 'WEB',
  delegate: 'SPAWN',
  approval: 'ASK',
  status: '—',
  other: 'TOOL',
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'working',
  waiting: 'needs you',
  completed: 'completed',
  failed: 'failed',
  idle: 'idle',
};

const PROVIDER: Record<string, string> = { 'claude-code': 'CLAUDE', cursor: 'CURSOR', mock: 'MOCK' };

const ATMOS_INK = 0.34;
const ATMOS_INK_URGENT = 0.7;

/** Matrix "decode": text resolves left to right out of glyph noise. */
function useDecode(text: string, active: boolean) {
  const [out, setOut] = useState(active ? '' : text);
  useEffect(() => {
    if (!active) {
      setOut(text);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const DURATION = Math.min(520, 160 + text.length * 14);
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / DURATION);
      const reveal = Math.floor(p * text.length);
      let s = text.slice(0, reveal);
      // Scramble with characters from the text itself — no decorative glyphs.
      for (let i = reveal; i < Math.min(text.length, reveal + 6); i++)
        s += text[i] === ' ' ? ' ' : text[(Math.random() * text.length) | 0];
      setOut(s);
      if (p < 1) raf = requestAnimationFrame(step);
      else setOut(text);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, active]);
  return out;
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

function dirOf(files?: string[]) {
  if (!files?.length) return '';
  if (files.length > 1) return `${files.length} files`;
  const parts = files[0].split('/');
  parts.pop();
  return parts.slice(-2).join('/');
}

const ChunkRow = memo(function ChunkRow({ chunk, index, mode, row, now }: { chunk: Chunk; index: number; mode: Mode; row: number; now: number }) {
  const text = useDecode(chunk.text, mode === 'atmos' && index === 0 && now - chunk.ts < 600);
  const fade = mode === 'atmos' ? Math.max(0.1, 1 - index * 0.075) : Math.max(0.5, 1 - index * 0.035);
  const cls = ['chunk', `k-${chunk.kind}`, `s-${chunk.state}`, chunk.accent ? `a-${chunk.accent}` : '', index === 0 ? 'head' : ''].join(' ');
  const meta = [ago(now - chunk.ts), dirOf(chunk.files)].filter(Boolean).join(' · ');
  // Readable mode fades whole rows. Atmos mode keeps the log translucent behind
  // the rain, with failures and approval requests a step stronger.
  const atmos = mode === 'atmos';
  const urgent = chunk.state === 'fail' || chunk.accent === 'fail' || chunk.accent === 'attention';
  const ink = atmos ? { opacity: fade * (urgent ? ATMOS_INK_URGENT : ATMOS_INK) } : undefined;
  return (
    <li
      className={cls}
      style={{ transform: `translateY(${index * row}px)`, opacity: atmos ? undefined : fade }}
      title={chunk.files?.join('\n')}
    >
      <span className="tag" style={ink}>{TAG[chunk.kind]}</span>
      <span className="body">
        <span className="text">
          <span className="ink" style={ink}>
            {text}
            {chunk.state === 'live' && <span className="cursor">▍</span>}
            {chunk.state === 'fail' && <span className="mark fail">✕</span>}
          </span>
        </span>
        <span className="meta">
          <span className="ink" style={ink}>{meta}</span>
        </span>
      </span>
    </li>
  );
});

export interface LaneProps {
  lane: LaneT;
  depth: number;
  parentName?: string;
  mode: Mode;
  now: number;
  collapsed: boolean;
  flash: boolean;
  isFirstChild: boolean;
  isLastChild: boolean;
  onToggle: (id: string) => void;
}

export const Lane = memo(function Lane({ lane, depth, parentName, mode, now, collapsed, flash, isFirstChild, isLastChild, onToggle }: LaneProps) {
  const row = mode === 'atmos' ? 50 : 58;
  const streamRef = useRef<HTMLOListElement>(null);
  const [visible, setVisible] = useState(14);
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVisible(Math.ceil(el.clientHeight / row) + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [row, collapsed]);

  const recent = now - lane.lastEventAt < 1500;
  const cls = [
    'lane',
    `st-${lane.status}`,
    depth > 0 ? 'child' : 'root',
    isFirstChild ? 'first-child' : '',
    isLastChild ? 'last-child' : '',
    collapsed ? 'collapsed' : '',
    recent ? 'hot' : '',
    flash ? 'flash' : '',
  ].join(' ');

  if (collapsed) {
    return (
      <section className={cls} data-lane={lane.id} data-status={lane.status} onClick={() => onToggle(lane.id)} title={`${lane.name} — ${STATUS_LABEL[lane.status]} (click to expand)`}>
        <div className="collapsed-inner">
          <span className={`dot st-${lane.status}`} />
          <span className="vname">{lane.name}</span>
        </div>
      </section>
    );
  }

  return (
    <section className={cls} data-lane={lane.id} data-status={lane.status} aria-label={`${lane.name}: ${STATUS_LABEL[lane.status]}`}>
      <header className="lane-head" onDoubleClick={() => onToggle(lane.id)}>
        {depth > 0 && parentName && <div className="lineage">↳ subagent of {parentName}</div>}
        <div className="title-row">
          <span className="provider">{Object.hasOwn(PROVIDER, lane.provider) ? PROVIDER[lane.provider] : lane.provider.toUpperCase()}</span>
          <h2 className="name" title={lane.cwd ? `${lane.name}\n${lane.cwd}` : lane.name}>
            {lane.name}
          </h2>
          {depth > 0 && (
            <button className="mini" onClick={() => onToggle(lane.id)} title="Collapse lane" aria-label="Collapse lane">
              –
            </button>
          )}
        </div>
        <div className="status-row">
          <span className={`pill st-${lane.status}`}>
            <span className={`dot st-${lane.status}`} />
            {STATUS_LABEL[lane.status]}
          </span>
          <span className="since">{ago(now - lane.statusSince)}</span>
          <span className="counts">
            <b>{lane.tools}</b> tools · <b>{lane.files}</b> files
            {lane.errors ? <b className="err"> · {lane.errors} err</b> : null}
          </span>
        </div>
        <div className={`activity ${lane.status === 'waiting' ? 'attn' : ''}`}>{lane.status === 'waiting' && lane.attention ? lane.attention : lane.activity || '—'}</div>
      </header>
      <ol className="stream" ref={streamRef}>
        {lane.chunks.slice(0, visible).map((c, i) => (
          <ChunkRow key={c.id} chunk={c} index={i} mode={mode} row={row} now={now} />
        ))}
      </ol>
      {(lane.queue.length > 0 || lane.dropped > 0) && (
        <div className="backlog">
          {lane.queue.length > 0 && <>+{lane.queue.length} queued</>}
          {lane.dropped > 0 && <> · {lane.dropped} folded</>}
        </div>
      )}
    </section>
  );
});
