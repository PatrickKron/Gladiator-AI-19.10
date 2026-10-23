import { useEffect, useRef } from 'react';
import { ensurePriceStream, onTick } from '../lib/prices.js';

/**
 * Plexus-Konstellation (Design-System v2, kalibriert an Patricks Referenzbild):
 * driftende Lichtpunkte mit Verbindungslinien in Blau/Violett/Magenta.
 * Datenbezug: Jeder ECHTE Tick lässt das Netz kurz aufpulsen —
 * grün getönt bei Up-Ticks, rot bei Down-Ticks. Kein sinnloses Dauer-Geloope:
 * die Grundbewegung ist minimal, das Leben kommt aus dem Markt.
 */

const NODE_COLORS = ['#2e7cf6', '#2e7cf6', '#4fd1ff', '#8b5cf6', '#8b5cf6', '#e14ecf'];
const LINK_DIST = 120;

type Node = { x: number; y: number; vx: number; vy: number; r: number; color: string };

export function PlexusHero({ density = 26, className = '' }: { density?: number; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    ensurePriceStream();

    let pulse = 0;
    let pulseColor: string | null = null;
    const offTick = onTick((t) => {
      pulse = Math.min(1, pulse + 0.55);
      pulseColor = t.direction === 'up' ? '#3ddc97' : t.direction === 'down' ? '#ff5c6c' : null;
    });

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let nodes: Node[] = [];
    let w = 0;
    let h = 0;

    function layout() {
      if (!canvas || !ctx) return;
      const rect = canvas.parentElement?.getBoundingClientRect();
      w = Math.max(1, Math.floor(rect?.width ?? window.innerWidth));
      h = Math.max(1, Math.floor(rect?.height ?? 300));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.round((w * h) / 900_000 * density * 10) || density;
      nodes = Array.from({ length: Math.min(count, 90) }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.12,
        vy: (Math.random() - 0.5) * 0.12,
        r: 1 + Math.random() * 1.8,
        color: NODE_COLORS[Math.floor(Math.random() * NODE_COLORS.length)]!,
      }));
    }
    layout();
    const ro = new ResizeObserver(layout);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const boost = 1 + pulse * 0.9;

      // Linien
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]!;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d > LINK_DIST) continue;
          const alpha = (1 - d / LINK_DIST) * 0.28 * boost;
          ctx.strokeStyle = pulse > 0.35 && pulseColor ? pulseColor : a.color;
          ctx.globalAlpha = alpha;
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // Punkte mit Glow
      for (const n of nodes) {
        ctx.globalAlpha = Math.min(1, 0.75 * boost);
        ctx.fillStyle = n.color;
        ctx.shadowColor = pulse > 0.35 && pulseColor ? pulseColor : n.color;
        ctx.shadowBlur = 8 * boost;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * (1 + pulse * 0.4), 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        if (!reduced) {
          n.x += n.vx;
          n.y += n.vy;
          if (n.x < -10) n.x = w + 10;
          if (n.x > w + 10) n.x = -10;
          if (n.y < -10) n.y = h + 10;
          if (n.y > h + 10) n.y = -10;
        }
      }
      ctx.globalAlpha = 1;
      pulse = Math.max(0, pulse - 0.02);
    }

    let raf = 0;
    function loop() {
      draw();
      raf = requestAnimationFrame(loop);
    }
    if (reduced) {
      draw();
    } else {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      offTick();
    };
  }, [density]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 ${className}`}
    />
  );
}
