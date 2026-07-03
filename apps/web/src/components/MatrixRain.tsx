import { useEffect, useRef } from 'react';
import { ensurePriceStream, getLatest, onTick } from '../lib/prices.js';

/**
 * Signatur-Effekt „Daten-Rain" (DESIGN_SYSTEM.md §6):
 * Vollbild-Canvas, requestAnimationFrame, Trail via Alpha-Overlay.
 * Zeichenquelle sind ECHTE SSE-Ticks (Symbol, Preisziffern, %-Änderung) —
 * vor dem ersten Tick fallen nur Markenglyphen, nie erfundene Zahlen.
 * 3 Parallax-Ebenen über Glyphgröße (größer = schneller = näher).
 * Grüne/rote Ticks lassen die Spalten ihres Symbols kurz aufblitzen;
 * Hover auf einer Preis-Karte hebt die Spalten des Symbols hervor.
 */

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
const BRAND_CHARS = 'GLADIATOR·BTC·ETH·SOL·';
const DEPTHS = [
  { font: 11, alpha: 0.4 },
  { font: 14, alpha: 0.65 },
  { font: 17, alpha: 1 },
] as const;
const STEP_MS = 42;
const FADE = 'rgba(5, 8, 16, 0.09)';
const BODY = '#3e8bff';
const HEAD = '#eaf6ff';
const GLOW = '#4fd1ff';
const POS = '#3ddc97';
const NEG = '#ff5c6c';
const FLASH_MS = 700;

// Hover-Kopplung (Preis-Karte → Rain), modulweiter Zustand.
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

export function MatrixRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
      ctx.fillStyle = '#050810';
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
      // Trail: alles Vorherige leicht Richtung Hintergrund abdunkeln
      ctx.fillStyle = FADE;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

      for (const col of columns) {
        const { font, alpha } = DEPTHS[col.depth];
        const pool = pools.get(col.symbol) ?? BRAND_CHARS;
        const ch = pool[col.streamPos % pool.length] ?? '·';
        const flash = flashes.get(col.symbol);
        const flashing = flash !== undefined && flash.until > now;
        const highlighted = highlightSymbol === col.symbol;

        ctx.font = `${font}px "JetBrains Mono", monospace`;

        // Körperzeichen an der vorherigen Kopfposition (Schweif in Blau auslaufend)
        const bodyColor = flashing ? flash.color : highlighted ? GLOW : BODY;
        ctx.globalAlpha = alpha * (highlighted ? 0.95 : 0.6);
        ctx.fillStyle = bodyColor;
        ctx.fillText(ch, col.x, col.y);

        // Kopfzeichen: fast weiß-blau mit Glow
        const nextY = col.y + font;
        const headCh = pool[(col.streamPos + 1) % pool.length] ?? '·';
        ctx.globalAlpha = Math.min(1, alpha * (highlighted ? 1.4 : 1));
        ctx.fillStyle = HEAD;
        ctx.shadowColor = flashing ? flash.color : GLOW;
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

    let raf = 0;
    let last = 0;
    function loop(now: number) {
      if (now - last >= STEP_MS) {
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

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0"
      style={{ opacity: 0.25 }}
    />
  );
}
