import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer, IPrimitivePaneView, Logical, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';
import { timeToLogical } from '../lib/chart-drawings.js';

/**
 * Smart-Money-Flächen für lightweight-charts 5 (Series-Primitive am Kerzen-Chart):
 * Zonen (Order Blocks, FVG) als Boxen von ihrer Entstehung bis zur Mitigation,
 * Liquiditäts-Level (Equal Highs/Lows) als Segmente, Premium/Discount als
 * getönte Flächen der Dealing Range. Offene Elemente (`toTime: null`) laufen bis
 * zum rechten Rand. x über Zeit → gebrochener Kerzen-Index (wie die Zeichnungen),
 * y über priceToCoordinate — der Chart ruft `draw` bei jedem Pan/Zoom erneut auf.
 */

export type SmcItem =
  | { kind: 'box'; fromTime: number; toTime: number | null; top: number; bottom: number; fill: string; stroke?: string; label?: string; labelColor?: string }
  | { kind: 'line'; fromTime: number; toTime: number | null; price: number; color: string; width?: number; dash?: number[]; label?: string };

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

export class SmcBoxesPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private items: SmcItem[] = [];
  private times: number[] = [];
  private readonly view: IPrimitivePaneView;

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.view = { renderer: () => renderer };
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart as IChartApi;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  /** Kerzenzeiten (Unix-Sekunden, aufsteigend) — bei neuer Live-Kerze nachführen. */
  setTimes(times: number[]): void {
    this.times = times;
    this.requestUpdate?.();
  }

  setItems(items: SmcItem[]): void {
    this.items = items;
    this.requestUpdate?.();
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

  private draw(target: DrawTarget): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const right = mediaSize.width;
      for (const it of this.items) {
        const x1 = this.x(it.fromTime);
        if (x1 == null) continue;
        const x2 = it.toTime == null ? right : (this.x(it.toTime) ?? right);
        if (x2 <= 0 || x1 >= right) continue;
        const left = Math.max(0, x1);
        const w = Math.min(right, x2) - left;
        if (w <= 0) continue;
        ctx.save();
        if (it.kind === 'box') {
          const yt = this.y(it.top);
          const yb = this.y(it.bottom);
          if (yt == null || yb == null) {
            ctx.restore();
            continue;
          }
          const top = Math.min(yt, yb);
          const h = Math.max(1, Math.abs(yb - yt));
          ctx.fillStyle = it.fill;
          ctx.fillRect(left, top, w, h);
          if (it.stroke) {
            ctx.strokeStyle = it.stroke;
            ctx.lineWidth = 1;
            ctx.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1);
          }
          if (it.label) this.text(ctx, it.label, left + 4, top + 11, it.labelColor ?? it.stroke ?? '#8b94b8');
        } else {
          const yv = this.y(it.price);
          if (yv == null) {
            ctx.restore();
            continue;
          }
          ctx.strokeStyle = it.color;
          ctx.lineWidth = it.width ?? 1;
          if (it.dash) ctx.setLineDash(it.dash);
          ctx.beginPath();
          ctx.moveTo(left, yv + 0.5);
          ctx.lineTo(left + w, yv + 0.5);
          ctx.stroke();
          if (it.label) this.text(ctx, it.label, left + 4, yv - 3, it.color);
        }
        ctx.restore();
      }
    });
  }

  private text(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, color: string): void {
    ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = color;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, x, y);
  }
}
