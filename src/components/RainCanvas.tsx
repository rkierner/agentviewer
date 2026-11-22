import { useEffect, useRef } from 'react';
import type { Chunk, MatrixStore } from '../store';

/**
 * Activity rain. There is no random filler: every falling column is a real
 * activity chunk from the lane it falls in — the command that ran, the file
 * that was edited, the pattern that was searched — written downward one
 * character at a time, Matrix-style, with a bright head and a fading trail.
 * An idle lane is still; a busy lane pours.
 */

const FONT = 16;
const LINE = 18; // vertical pitch between characters
const WRITE_CPS = 22; // characters written per second
const HOLD_MS = 1400; // full column stays lit after writing completes
const FADE_MS = 2600; // then fades out
const PER_LANE = 9;

const COLOR: Record<string, string> = {
  run: '198,255,138',
  edit: '110,255,160',
  read: '70,230,130',
  search: '70,230,130',
  web: '120,235,200',
  delegate: '95,242,208',
  approval: '255,181,71',
  status: '120,200,150',
  other: '90,240,150',
  fail: '255,93,93',
};

export interface LaneRect {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Stream {
  lane: string;
  text: string;
  col: number; // x offset within the lane, in px
  y0: number; // y offset within the lane stream area, in px
  rgb: string;
  born: number;
  /** ms spent paused, subtracted from age */
  frozen: number;
}

/** Turn a chunk into the short, command-like string that rains. */
export function rainText(c: Chunk): string {
  const strip = (s: string) => s.replace(/^(running|ran|reading|read|editing|edited|writing|wrote|searching|searched|finding|found|fetching|fetched|delegating:|delegated:)\s+/i, '');
  const file = c.files?.length === 1 ? c.files[0] : undefined;
  let t: string;
  if (c.state === 'fail') t = `x ${strip(c.text)}`;
  else if (c.accent === 'attention') t = `? ${strip(c.text.replace(/^(approval needed|needs approval)\s*[:·]\s*/i, ''))}`;
  else if (c.accent === 'spawn') t = `>> ${c.text.replace(/^spawned\s+/i, '')}`;
  else if (c.kind === 'run') t = `$ ${strip(c.text)}`;
  else if (c.kind === 'edit') t = `+ ${file ?? strip(c.text)}`;
  else if (c.kind === 'read') t = file ?? strip(c.text);
  else if (c.kind === 'search') t = `/${strip(c.text).replace(/^"|"$/g, '')}/`;
  else t = strip(c.text);
  return t.replace(/\s+/g, ' ').trim();
}

function colorFor(c: Chunk) {
  if (c.state === 'fail' || c.accent === 'fail') return COLOR.fail;
  if (c.accent === 'attention') return COLOR.approval;
  if (c.accent === 'spawn') return COLOR.delegate;
  return COLOR[c.kind] ?? COLOR.other;
}

export function RainCanvas({ store, getLaneRects }: { store: MatrixStore; getLaneRects: () => LaneRect[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let w = 0;
    let h = 0;
    let raf = 0;
    let last = 0;
    let lastRects = 0;
    let rects = new Map<string, LaneRect>();
    let streams: Stream[] = [];
    const seen = new Map<string, string>(); // lane id → newest chunk id spawned
    const lastCols = new Map<string, number[]>(); // lane id → recently used columns
    let paused = store.getSnapshot().paused;
    let pausedAt = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const refreshRects = () => {
      rects = new Map(getLaneRects().map((r) => [r.id, r]));
    };

    const pickColumn = (laneId: string, r: LaneRect) => {
      const cols = Math.max(1, Math.floor((r.right - r.left - 16) / FONT));
      const recent = lastCols.get(laneId) ?? [];
      // Prefer columns far from recently used ones, so streams spread out.
      let best = 0;
      let bestScore = -1;
      for (let tries = 0; tries < 8; tries++) {
        const c = Math.floor(Math.random() * cols);
        const score = recent.length ? Math.min(...recent.map((x) => Math.abs(x - c))) : cols;
        if (score > bestScore) {
          best = c;
          bestScore = score;
        }
      }
      lastCols.set(laneId, [...recent, best].slice(-5));
      return 8 + best * FONT;
    };

    const spawn = (laneId: string, chunk: Chunk, now: number) => {
      const r = rects.get(laneId);
      if (!r) return;
      const height = r.bottom - r.top;
      const maxChars = Math.max(6, Math.floor((height - 20) / LINE));
      let text = rainText(chunk);
      if (chunk.count > 1) text = `${text} x${chunk.count}`;
      if (text.length > Math.min(maxChars, 48)) text = text.slice(0, Math.min(maxChars, 48) - 1) + '~';
      const room = Math.max(0, height - text.length * LINE - 10);
      // Start near the top more often than not, so columns read as "falling in".
      const y0 = Math.floor(Math.pow(Math.random(), 1.6) * Math.min(room, height * 0.55));
      const mine = streams.filter((s) => s.lane === laneId);
      if (mine.length >= PER_LANE) streams = streams.filter((s) => s !== mine[0]);
      streams.push({ lane: laneId, text, col: pickColumn(laneId, r), y0, rgb: colorFor(chunk), born: now, frozen: 0 });
    };

    // Watch the store: every chunk *released* into a lane becomes a stream.
    const onStore = () => {
      const s = store.getSnapshot();
      const now = performance.now();
      if (s.paused !== paused) {
        if (s.paused) pausedAt = now;
        else for (const st of streams) st.frozen += now - pausedAt;
        paused = s.paused;
      }
      if (rects.size === 0 || now - lastRects > 300) {
        refreshRects();
        lastRects = now;
      }
      for (const id of s.order) {
        const lane = s.lanes[id];
        const head = lane.chunks[0];
        if (!head) continue;
        const prev = seen.get(id);
        if (prev === head.id) continue;
        seen.set(id, head.id);
        // Skip replayed history on first sight of a lane, except its newest chunk.
        if (prev === undefined && Date.now() - head.ts > 4000) continue;
        spawn(id, head, now);
      }
      for (const id of [...seen.keys()]) if (!s.lanes[id]) seen.delete(id);
    };
    const unsub = store.subscribe(onStore);
    onStore();

    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || t - last < 33) return;
      last = t;
      if (t - lastRects > 300) {
        refreshRects();
        lastRects = t;
      }
      ctx.clearRect(0, 0, w, h);
      ctx.font = `${FONT}px "JetBrains Mono", monospace`;
      const now = paused ? pausedAt : t;
      const alive: Stream[] = [];
      for (const s of streams) {
        const r = rects.get(s.lane);
        if (!r) continue; // lane gone or collapsed
        const age = now - s.born - s.frozen;
        const writeMs = (s.text.length / WRITE_CPS) * 1000;
        const total = writeMs + HOLD_MS + FADE_MS;
        if (age > total) continue;
        alive.push(s);
        const written = Math.min(s.text.length, Math.floor((age / 1000) * WRITE_CPS) + 1);
        const fade = age > writeMs + HOLD_MS ? 1 - (age - writeMs - HOLD_MS) / FADE_MS : 1;
        const x = r.left + s.col + FONT / 2;
        if (x > r.right - 6) continue;
        for (let i = 0; i < written; i++) {
          const y = r.top + s.y0 + i * LINE;
          if (y > r.bottom - LINE) break;
          const ch = s.text[i];
          if (ch === ' ') continue;
          const isHead = i === written - 1 && written < s.text.length;
          // Trail: characters further behind the head are dimmer.
          const behind = written - 1 - i;
          const a = isHead ? 1 : Math.max(0.42, 1 - behind * 0.024) * fade;
          if (isHead) {
            ctx.fillStyle = `rgba(235,255,240,${a})`;
            ctx.shadowColor = `rgba(${s.rgb},0.9)`;
            ctx.shadowBlur = 10;
            ctx.fillText(ch, x, y);
            ctx.shadowBlur = 0;
          } else {
            ctx.fillStyle = `rgba(${s.rgb},${a})`;
            ctx.fillText(ch, x, y);
          }
        }
      }
      streams = alive;
    };
    raf = requestAnimationFrame(frame);

    return () => {
      unsub();
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [store, getLaneRects]);

  return <canvas ref={ref} className="rain" aria-hidden="true" />;
}
