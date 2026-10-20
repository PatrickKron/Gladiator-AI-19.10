import {
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesPrimitive,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type Logical,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import { fibLevelPrices, type DrawingKind, type DrawingPoint, type DrawingStyle } from '@gladiator/core/drawings';
import { timeToLogical, type PixelShape, type Px } from '../lib/chart-drawings.js';

/**
 * Rendering der Chart-Zeichnungen für lightweight-charts 5 (Series-Primitive).
 *
 * - Horizontale → echte Price-Lines der Kerzenserie (inkl. Achsen-Label).
 * - Trendlinie / Fibonacci → Canvas-Zeichnung im Pane. Die x-Position kommt aus
 *   Zeit → gebrochener Kerzen-Index (lib/chart-drawings) → logicalToCoordinate,
 *   die y-Position aus priceToCoordinate. Der Chart ruft den Renderer bei JEDEM
 *   Neuzeichnen (Pan/Zoom/Resize) auf — Koordinaten sind also immer aktuell.
 */

export type ChartDrawing = {
  id: string;
  kind: DrawingKind;
  points: DrawingPoint[];
  style: DrawingStyle | null;
};

export const DRAWING_COLORS: Record<DrawingKind, string> = {
  hline: '#8b5cf6',
  trend: '#4fd1ff',
  fib: '#f5b642',
};

type Preview = { kind: DrawingKind; points: DrawingPoint[] } | null;
type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

const fmtPrice = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : 8 });

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private drawings: ChartDrawing[] = [];
  private times: number[] = [];
  private preview: Preview = null;
  private priceLines: IPriceLine[] = [];
  private readonly view: IPrimitivePaneView;

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.view = { renderer: () => renderer };
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart as IChartApi;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
    this.syncPriceLines();
  }

  detached(): void {
    this.removePriceLines();
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  /** Kerzenzeiten (Unix-Sekunden, aufsteigend) des aktuell geladenen Timeframes. */
  setTimes(times: number[]): void {
    this.times = times;
    this.requestUpdate?.();
  }

  setDrawings(drawings: ChartDrawing[]): void {
    this.drawings = drawings;
    this.syncPriceLines();
    this.requestUpdate?.();
  }

  setPreview(preview: Preview): void {
    this.preview = preview;
    this.requestUpdate?.();
  }

  /** Pixel-Formen aller Zeichnungen (Treffer-Test fürs Löschen). */
  shapes(): { id: string; shape: PixelShape }[] {
    const out: { id: string; shape: PixelShape }[] = [];
    for (const d of this.drawings) {
      const s = this.project(d.kind, d.points);
      if (s) out.push({ id: d.id, shape: s });
    }
    return out;
  }

  private removePriceLines(): void {
    if (this.series) {
      for (const l of this.priceLines) {
        try {
          this.series.removePriceLine(l);
        } catch {
          /* Serie schon entsorgt */
        }
      }
    }
    this.priceLines = [];
  }

  private syncPriceLines(): void {
    this.removePriceLines();
    if (!this.series) return;
    for (const d of this.drawings) {
      if (d.kind !== 'hline' || !d.points[0]) continue;
      this.priceLines.push(
        this.series.createPriceLine({
          price: d.points[0].price,
          color: d.style?.color ?? DRAWING_COLORS.hline,
          lineWidth: (d.style?.lineWidth ?? 1) as 1 | 2 | 3 | 4,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: '',
        }),
      );
    }
  }

  private x(time: number): number | null {
    if (!this.chart) return null;
    const logical = timeToLogical(this.times, time);
    if (logical == null) return null;
    return this.chart.timeScale().logicalToCoordinate(logical as Logical);
  }

  private y(price: number): number | null {
    return this.series ? this.series.priceToCoordinate(price) : null;
  }

  private px(p: DrawingPoint): Px | null {
    const x = this.x(p.time);
    const y = this.y(p.price);
    return x == null || y == null ? null : { x, y };
  }

  private project(kind: DrawingKind, points: DrawingPoint[]): PixelShape | null {
    if (kind === 'hline') {
      const y = points[0] ? this.y(points[0].price) : null;
      return y == null ? null : { kind: 'hline', y };
    }
    const a = points[0] ? this.px(points[0]) : null;
    const b = points[1] ? this.px(points[1]) : null;
    if (!a || !b) return null;
    if (kind === 'trend') return { kind: 'segment', a, b };
    const ys: number[] = [];
    for (const lv of fibLevelPrices(points[0]!, points[1]!)) {
      const y = this.y(lv.price);
      if (y != null) ys.push(y);
    }
    return { kind: 'fib', x1: a.x, x2: b.x, ys };
  }

  private draw(target: DrawTarget): void {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const d of this.drawings) this.drawShape(ctx, d.kind, d.points, d.style, false);
      if (this.preview) this.drawShape(ctx, this.preview.kind, this.preview.points, null, true);
    });
  }

  private drawShape(
    ctx: CanvasRenderingContext2D,
    kind: DrawingKind,
    points: DrawingPoint[],
    style: DrawingStyle | null,
    preview: boolean,
  ): void {
    if (kind === 'hline') return; // Price-Line übernimmt (ein Klick, keine Vorschau nötig)
    const color = style?.color ?? DRAWING_COLORS[kind];
    const width = style?.lineWidth ?? 1;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    if (preview) ctx.setLineDash([4, 4]);

    const a = points[0] ? this.px(points[0]) : null;
    const b = points[1] ? this.px(points[1]) : null;
    // Start-Anker (z. B. nach dem ersten Klick) immer markieren
    if (a) this.dot(ctx, a);
    if (!a || !b) {
      ctx.restore();
      return;
    }

    if (kind === 'trend') {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      this.dot(ctx, b);
    } else {
      const x1 = Math.min(a.x, b.x);
      const x2 = Math.max(a.x, b.x);
      const levels = fibLevelPrices(points[0]!, points[1]!);
      const yTop = this.y(levels[0]!.price);
      const yBottom = this.y(levels[levels.length - 1]!.price);
      if (yTop != null && yBottom != null) {
        ctx.globalAlpha = 0.06;
        ctx.fillRect(x1, Math.min(yTop, yBottom), x2 - x1, Math.abs(yBottom - yTop));
        ctx.globalAlpha = 1;
      }
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textBaseline = 'bottom';
      for (const lv of levels) {
        const y = this.y(lv.price);
        if (y == null) continue;
        ctx.globalAlpha = lv.level === 0 || lv.level === 1 ? 0.9 : 0.65;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
        ctx.fillText(`${lv.level} (${fmtPrice(lv.price)})`, x1 + 2, y - 1);
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private dot(ctx: CanvasRenderingContext2D, p: Px): void {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}
