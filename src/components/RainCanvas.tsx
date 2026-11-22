import { useEffect, useRef } from 'react';
import type { AgentStatus } from '../../shared/events';

/**
 * Background code-rain. Columns that sit under a lane take that lane's state:
 * fast and green while working, slow amber when waiting for you, sparse red on
 * failure, nearly still when idle or done. Outside lanes it is a faint drizzle.
 * Rendered at ~30fps, paused when the tab is hidden.
 */

const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789<>/{}[]=+*#:;';

const STYLE: Record<AgentStatus | 'none', { rgb: string; speed: number; alpha: number; density: number }> = {
  working: { rgb: '70,255,140', speed: 1, alpha: 0.6, density: 1 },
  waiting: { rgb: '255,181,71', speed: 0.45, alpha: 0.5, density: 0.8 },
  failed: { rgb: '255,93,93', speed: 0.25, alpha: 0.35, density: 0.5 },
  completed: { rgb: '120,200,150', speed: 0.12, alpha: 0.18, density: 0.35 },
  idle: { rgb: '90,140,110', speed: 0.12, alpha: 0.16, density: 0.3 },
  none: { rgb: '60,200,110', speed: 0.18, alpha: 0.14, density: 0.3 },
};

export interface LaneRegion {
  left: number;
  right: number;
  status: AgentStatus;
  /** 0..1, recent activity boost. */
  heat: number;
}

interface Drop {
  y: number;
  speed: number;
  len: number;
}

export function RainCanvas({ getRegions, paused }: { getRegions: () => LaneRegion[]; paused: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const FONT = 15;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let drops: Drop[] = [];
    let regions: LaneRegion[] = [];
    let raf = 0;
    let last = 0;
    let lastRegions = 0;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cols = Math.ceil(w / FONT);
      drops = Array.from({ length: cols }, (_, i) => drops[i] ?? { y: Math.random() * h, speed: 0.6 + Math.random() * 0.8, len: 8 + Math.random() * 18 });
      ctx.fillStyle = '#020805';
      ctx.fillRect(0, 0, w, h);
    };
    resize();
    window.addEventListener('resize', resize);

    const styleAt = (x: number) => {
      for (const r of regions) if (x >= r.left && x <= r.right) return { s: STYLE[r.status], heat: r.heat };
      return { s: STYLE.none, heat: 0 };
    };

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || t - last < 33) return;
      const dt = Math.min(3, (t - last) / 33);
      last = t;
      if (t - lastRegions > 400) {
        regions = getRegions();
        lastRegions = t;
      }
      // Trail fade.
      ctx.fillStyle = 'rgba(2,8,5,0.16)';
      ctx.fillRect(0, 0, w, h);
      if (pausedRef.current) return;
      ctx.font = `${FONT}px "JetBrains Mono", monospace`;
      ctx.textBaseline = 'top';
      for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        const x = i * FONT;
        const { s, heat } = styleAt(x + FONT / 2);
        // Density: skip some columns deterministically so lanes aren't solid.
        if (((i * 2654435761) >>> 0) % 100 > s.density * 100 * (0.55 + heat * 0.45)) {
          continue;
        }
        const step = FONT * s.speed * d.speed * (1 + heat * 0.8) * dt * 0.55;
        d.y += step;
        const ch = GLYPHS[(Math.random() * GLYPHS.length) | 0];
        const a = Math.min(0.85, s.alpha * (0.7 + heat * 0.6));
        // Head glyph is brighter, like the classic leading character.
        ctx.fillStyle = `rgba(${s.rgb},${a})`;
        ctx.fillText(ch, x, d.y);
        if (heat > 0.3 && Math.random() < 0.3) {
          ctx.fillStyle = `rgba(220,255,230,${a * 0.6})`;
          ctx.fillText(ch, x, d.y);
        }
        if (d.y > h + d.len * FONT * 0.3 && Math.random() > 0.96) {
          d.y = -FONT * Math.random() * 10;
          d.speed = 0.6 + Math.random() * 0.8;
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [getRegions]);

  return <canvas ref={ref} className="rain" aria-hidden="true" />;
}
