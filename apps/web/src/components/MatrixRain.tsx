import { useEffect, useRef } from 'react';
import { ensurePriceStream, getLatest, onTick } from '../lib/prices.js';
import type { RainTone } from '../lib/effects.js';

/**
 * Daten-Regen (Special-Effekt, Design-System v3): Vollbild-Canvas, rAF,
 * Schweif über Alpha-Overlay. Zeichenquelle sind ECHTE SSE-Ticks (Symbol,
 * Preisziffern, %-Änderung) — vor dem ersten Tick fallen nur Markenglyphen,
 * nie erfundene Zahlen. Drei Parallax-Ebenen über Glyphgröße.
 *
 * Die Komponente zeichnet nur; WANN und WIE STARK sie sichtbar ist, entscheidet
 * RainLayer über `intensity` (0 … 1, weich nachgeführt) und `tone`
 * (Ereignis-Impuls: blau, grün, rot). Hover auf einer Markt-Karte hebt die
 * Spalten des Symbols hervor (setRainHighlight).
 */

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
const BRAND_CHARS = 'GLADIATOR·BTC·ETH·SOL·';
const DEPTHS = [
  { font: 11, alpha: 0.4 },
  { font: 14, alpha: 0.65 },
  { font: 17, alpha: 1 },
] as const;
const STEP_MS = 42;
const FADE = 'rgba(11, 13, 18, 0.09)';
const HEAD = '#eaf2ff';
const TONES: Record<RainTone, { body: string; glow: string }> = {
  accent: { body: '#3b82f6', glow: '#60a5fa' },
  pos: { body: '#22c55e', glow: '#4ade80' },
  neg: { body: '#ef4444', glow: '#f87171' },
};
const POS = '#22c55e';
const NEG = '#ef4444';
const FLASH_MS = 700;

// Hover-Kopplung (Markt-Karte → Regen), modulweiter Zustand.
let highlightSymbol: string | null = null;
export function setRainHighlight(symbol: string | null): void {
  highlightSymbol = symbol;
}

type Column = {
  x: number;
  y: number;
  depth: 0 | 1 | 2;
  symbol: string;
  streamPos: number;
};

export function MatrixRain({ intensity, tone = 'accent', focusSymbol = null }: { intensity: number; tone?: RainTone; focusSymbol?: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const targetRef = useRef(intensity);
  const toneRef = useRef<RainTone>(tone);
  const focusRef = useRef<string | null>(focusSymbol);
  targetRef.current = intensity;
  toneRef.current = tone;
  focusRef.current = focusSymbol;

  // Eingeschränkte Bewegung: kein rAF-Lauf, aber die Sichtbarkeit folgt dem Zustand (Standbild, höchstens 0,25).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    canvas.style.opacity = String(Math.min(0.25, intensity));
  }, [intensity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ensurePriceStream();

    // Zeichen-Pools je Symbol — gefüllt aus echten Ticks.
    const pools = new Map<string, string>(SYMBOLS.map((s) => [s, BRAND_CHARS]));
    const flashes = new Map<string, { color: string; until: number }>();

    for (const t of getLatest()) {
      pools.set(t.symbol, tokenize(t.symbol, t.price, t.changePct24h));
    }
    const offTick = onTick((t) => {
      pools.set(t.symbol, tokenize(t.symbol, t.price, t.changePct24h));
      if (t.direction !== 'flat') {
        flashes.set(t.symbol, {
          color: t.direction === 'up' ? POS : NEG,
          until: performance.now() + FLASH_MS,
        });
      }
    });

    function tokenize(symbol: string, price: number, pct: number | null): string {
      const short = symbol.replace('/USDT', '');
      const parts = [short, price.toFixed(2), pct === null ? '' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`];
      return ` ${parts.join(' ')} `.repeat(3);
    }

    let columns: Column[] = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

    function layout() {
      if (!canvas || !ctx) return;
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0b0d12';
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

      columns = [];
      let x = 0;
      let i = 0;
      while (x < window.innerWidth) {
        const depth = DEPTHS[i % 3 === 0 ? 2 : i % 3 === 1 ? 0 : 1]!;
        const depthIdx = (i % 3 === 0 ? 2 : i % 3 === 1 ? 0 : 1) as 0 | 1 | 2;
        columns.push({
          x,
          y: -Math.random() * window.innerHeight,
          depth: depthIdx,
          symbol: SYMBOLS[i % SYMBOLS.length]!,
          streamPos: Math.floor(Math.random() * 64),
        });
        x += depth.font + 4;
        i++;
      }
    }
    layout();
    window.addEventListener('resize', layout);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function drawStep(now: number) {
      if (!ctx) return;
      // Schweif: alles Vorherige leicht Richtung Hintergrund abdunkeln
      ctx.fillStyle = FADE;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      const palette = TONES[toneRef.current];
      const focus = focusRef.current ?? highlightSymbol;

      for (const col of columns) {
        const { font, alpha } = DEPTHS[col.depth];
        const pool = pools.get(col.symbol) ?? BRAND_CHARS;
        const ch = pool[col.streamPos % pool.length] ?? '·';
        const flash = flashes.get(col.symbol);
        const flashing = flash !== undefined && flash.until > now;
        const highlighted = focus === col.symbol;

        ctx.font = `${font}px "JetBrains Mono", monospace`;

        // Körperzeichen an der vorherigen Kopfposition (Schweif in der Tonfarbe)
        const bodyColor = flashing ? flash.color : highlighted ? palette.glow : palette.body;
        ctx.globalAlpha = alpha * (highlighted ? 0.95 : 0.6);
        ctx.fillStyle = bodyColor;
        ctx.fillText(ch, col.x, col.y);

        // Kopfzeichen: fast weiß mit Glow
        const nextY = col.y + font;
        const headCh = pool[(col.streamPos + 1) % pool.length] ?? '·';
        ctx.globalAlpha = Math.min(1, alpha * (highlighted ? 1.4 : 1));
        ctx.fillStyle = HEAD;
        ctx.shadowColor = flashing ? flash.color : palette.glow;
        ctx.shadowBlur = col.depth === 2 || highlighted ? 14 : 8;
        ctx.fillText(headCh, col.x, nextY);
        ctx.shadowBlur = 0;

        col.y = nextY;
        col.streamPos++;
        if (col.y > window.innerHeight && Math.random() > 0.975) {
          col.y = -font;
          col.streamPos = 0;
        }
      }
      ctx.globalAlpha = 1;
    }

    // Sichtbarkeit weich nachführen; bei 0 wird nicht gezeichnet (keine Last im Normalbetrieb).
    let shown = 0;
    let raf = 0;
    let last = 0;
    function loop(now: number) {
      const target = targetRef.current;
      shown += (target - shown) * 0.08;
      if (Math.abs(target - shown) < 0.004) shown = target;
      if (canvas) canvas.style.opacity = shown.toFixed(3);
      if (shown > 0.005 && now - last >= STEP_MS) {
        last = now;
        drawStep(now);
      }
      raf = requestAnimationFrame(loop);
    }

    if (reduced) {
      // Eingefrorenes, sehr dunkles Standbild — keine Animation.
      for (let i = 0; i < 24; i++) drawStep(0);
    } else {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', layout);
      offTick();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none fixed inset-0 z-0" style={{ opacity: 0 }} />;
}
