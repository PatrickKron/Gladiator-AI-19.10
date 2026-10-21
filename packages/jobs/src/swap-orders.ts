import { and, eq, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { schema, type Db } from '@gladiator/db';
import { fetchPairDepths, fetchTokenMarket, walletBalances, type PoolDepth, type SwapChainId, type TokenMarket } from '@gladiator/exchange';
import { notifySafe } from './notify.js';
import { executePreparedSwap, prepareSwap, swapNet, type SwapWalletRow } from './swap-service.js';

const { swapOrders, swapWallets } = schema;

/**
 * Limit-Orders + Auto-Sell (Vision-Punkt 5e): Take-Profit, Stop-Loss,
 * Trailing-Stop und Limit-Kauf für Wallet-Bestände. Der Worker ruft
 * `runSwapOrders` jede Minute; ausgelöst wird über denselben Swap-Pfad wie im
 * Ticket (Angebot, Sicherheitscheck beim Kauf, Gate, Paper/Live).
 */

export type SwapOrderKind = 'take_profit' | 'stop_loss' | 'trailing_stop' | 'limit_buy' | 'dca' | 'alert_above' | 'alert_below' | 'rug_guard';

/** Reine Preisalarme: lösen nur eine Meldung aus, nie einen Swap. */
export const ALERT_KINDS: SwapOrderKind[] = ['alert_above', 'alert_below'];
export const isAlertKind = (k: SwapOrderKind): boolean => ALERT_KINDS.includes(k);

export const SWAP_ORDER_LABEL: Record<SwapOrderKind, string> = {
  take_profit: 'Take-Profit',
  stop_loss: 'Stop-Loss',
  trailing_stop: 'Trailing-Stop',
  limit_buy: 'Limit-Kauf',
  dca: 'DCA-Kauf',
  alert_above: 'Preisalarm über',
  alert_below: 'Preisalarm unter',
  rug_guard: 'Rug-Schutz',
};

/** Bestand weg → übrige Verkaufs-Orders für diesen Token sind gegenstandslos (OCO-Verhalten). */
export async function cancelSellOrdersIfSoldOut(db: Db, walletId: string, token: string): Promise<void> {
  const left = (await walletBalances(db, walletId)).find((b) => b.token === token);
  if (left && BigInt(left.amountAtomic) > 0n) return;
  await db
    .update(swapOrders)
    .set({ status: 'cancelled', closedAt: new Date(), error: 'Bestand verkauft' })
    .where(
      // Kauf-Orders (Limit-Kauf, DCA) und Preisalarme bleiben — sie bauen den Bestand ja gerade auf
      and(eq(swapOrders.walletId, walletId), eq(swapOrders.token, token), eq(swapOrders.status, 'open'), notInArray(swapOrders.kind, ['limit_buy', 'dca', 'alert_above', 'alert_below'])),
    );
}

export type OrderState = { kind: SwapOrderKind; triggerPriceUsd: number | null; trailPct: number | null; peakPriceUsd: number | null };

/**
 * Reine Bewertung gegen den aktuellen Preis. Trailing: Höchstkurs nachziehen,
 * auslösen, wenn der Preis um `trailPct` darunter fällt.
 */
export function evaluateSwapOrder(o: OrderState, priceUsd: number): { trigger: boolean; peakPriceUsd: number | null } {
  if (!(priceUsd > 0)) return { trigger: false, peakPriceUsd: o.peakPriceUsd };
  switch (o.kind) {
    case 'take_profit':
      return { trigger: o.triggerPriceUsd !== null && priceUsd >= o.triggerPriceUsd, peakPriceUsd: null };
    case 'stop_loss':
      return { trigger: o.triggerPriceUsd !== null && priceUsd <= o.triggerPriceUsd, peakPriceUsd: null };
    case 'limit_buy':
      return { trigger: o.triggerPriceUsd !== null && priceUsd <= o.triggerPriceUsd, peakPriceUsd: null };
    case 'dca':
      // zeitgesteuert (runDcaOrders), nie preisgesteuert
      return { trigger: false, peakPriceUsd: null };
    case 'alert_above':
      return { trigger: o.triggerPriceUsd !== null && priceUsd >= o.triggerPriceUsd, peakPriceUsd: null };
    case 'alert_below':
      return { trigger: o.triggerPriceUsd !== null && priceUsd <= o.triggerPriceUsd, peakPriceUsd: null };
    case 'rug_guard':
      // liquiditätsgesteuert (evaluateRugGuard), nie preisgesteuert
      return { trigger: false, peakPriceUsd: null };
    case 'trailing_stop': {
      const peak = Math.max(o.peakPriceUsd ?? priceUsd, priceUsd);
      const trail = o.trailPct ?? 0;
      return { trigger: trail > 0 && priceUsd <= peak * (1 - trail / 100), peakPriceUsd: peak };
    }
  }
}

/**
 * Rug-Schutz (rein): Höchststand der Pool-Tiefe √(Basis × Quote) nachziehen;
 * fällt sie um `dropPct` darunter (Liquidität abgezogen = typischer Rug),
 * auslösen. Die Pool-Tiefe bleibt bei normalem Handel gleich — ein Kursrutsch
 * allein löst also nie aus (anders als die USD-Liquidität, die mit dem Kurs fällt).
 */
export function evaluateRugGuard(o: { dropPct: number | null; peakDepth: number | null }, depth: number | null): { trigger: boolean; peakDepth: number | null } {
  if (depth === null || !(depth >= 0)) return { trigger: false, peakDepth: o.peakDepth };
  const peak = Math.max(o.peakDepth ?? depth, depth);
  const drop = o.dropPct ?? 0;
  return { trigger: drop > 0 && peak > 0 && depth <= peak * (1 - drop / 100), peakDepth: peak };
}

/**
 * Rug-Schutz: Umzug statt Rug (rein). Fällt der beobachtete Pool, weil der
 * Token in einen NEUEN, tiefen Pool umgezogen ist (z. B. Abschluss einer
 * pump.fun-Bonding-Curve), wird der neue Pool übernommen statt verkauft. Ein Rug
 * erzeugt keinen neuen tiefen Pool: Er muss mindestens die Hälfte der
 * USD-Liquidität haben, die der alte Pool beim Tiefen-Höchststand hatte —
 * kursbereinigt, denn bei konstantem Produkt wächst die USD-Liquidität mit
 * √Kurs (ein Kursrutsch seitdem verhindert sonst jeden Umzug).
 */
export function rugGuardMigrates(
  o: { pairAddress: string | null; peakLiquidityUsd: number | null; peakPriceUsd: number | null },
  best: { pairAddress: string | null; liquidityUsd: number | null; depth: number | null } | null,
  priceUsd: number,
): boolean {
  if (!best || !best.pairAddress || !o.pairAddress || best.pairAddress === o.pairAddress) return false;
  if (o.peakLiquidityUsd === null || !(o.peakLiquidityUsd > 0) || best.liquidityUsd === null || best.depth === null || !(best.depth > 0)) return false;
  // Altbestand ohne Kurs zum Höchststand: unbereinigt (strenger) vergleichen
  const scale = o.peakPriceUsd !== null && o.peakPriceUsd > 0 && priceUsd > 0 ? Math.sqrt(Math.min(priceUsd / o.peakPriceUsd, 1)) : 1;
  return best.liquidityUsd >= o.peakLiquidityUsd * scale * 0.5;
}

/** Plausibilität beim Anlegen: eine Order, die sofort auslösen würde, ist fast immer ein Tippfehler. */
export function validateNewOrder(o: OrderState, priceUsd: number): string | null {
  if (o.kind === 'dca') return null;
  if (o.kind === 'rug_guard') {
    if (!(o.trailPct !== null && o.trailPct >= 10 && o.trailPct <= 90)) return 'Rug-Schutz: Liquiditätsabfall 10 bis 90 %.';
    return null;
  }
  if (o.kind === 'trailing_stop') {
    if (!(o.trailPct !== null && o.trailPct >= 0.5 && o.trailPct <= 90)) return 'Trailing-Abstand: 0,5 bis 90 %.';
    return null;
  }
  if (!(o.triggerPriceUsd !== null && o.triggerPriceUsd > 0)) return 'Auslösepreis fehlt.';
  if (o.kind === 'take_profit' && o.triggerPriceUsd <= priceUsd) return 'Take-Profit muss über dem aktuellen Preis liegen.';
  if (o.kind === 'alert_above' && o.triggerPriceUsd <= priceUsd) return 'Alarm „über“ muss über dem aktuellen Preis liegen.';
  if (o.kind === 'alert_below' && o.triggerPriceUsd >= priceUsd) return 'Alarm „unter“ muss unter dem aktuellen Preis liegen.';
  if ((o.kind === 'stop_loss' || o.kind === 'limit_buy') && o.triggerPriceUsd >= priceUsd) {
    return `${SWAP_ORDER_LABEL[o.kind]} muss unter dem aktuellen Preis liegen.`;
  }
  return null;
}

export type SwapOrdersResult = { checked: number; triggered: number; filled: number; failed: number; errors: string[] };

type OrderRow = typeof swapOrders.$inferSelect;

function stateOf(o: OrderRow): OrderState {
  return {
    kind: o.kind,
    triggerPriceUsd: o.triggerPriceUsd === null ? null : Number(o.triggerPriceUsd),
    trailPct: o.trailPct === null ? null : Number(o.trailPct),
    peakPriceUsd: o.peakPriceUsd === null ? null : Number(o.peakPriceUsd),
  };
}

async function closeOrder(db: Db, id: string, status: 'filled' | 'failed' | 'cancelled', extra: { tradeId?: string; error?: string }): Promise<void> {
  await db
    .update(swapOrders)
    .set({ status, closedAt: new Date(), tradeId: extra.tradeId ?? null, error: extra.error ?? null })
    .where(eq(swapOrders.id, id));
}

/** Eine ausgelöste Order ausführen (Status vorher atomar open → executing). */
async function fireOrder(db: Db, o: OrderRow, w: SwapWalletRow, priceUsd: number, out: SwapOrdersResult): Promise<void> {
  const claimed = await db
    .update(swapOrders)
    .set({ status: 'executing', triggeredAt: new Date() })
    .where(and(eq(swapOrders.id, o.id), eq(swapOrders.status, 'open')))
    .returning({ id: swapOrders.id });
  if (claimed.length === 0) return; // anderer Lauf war schneller
  out.triggered++;
  const label = SWAP_ORDER_LABEL[o.kind];
  if (isAlertKind(o.kind)) {
    // nur melden — kein Swap, kein Geld bewegt
    await closeOrder(db, o.id, 'filled', {});
    out.filled++;
    await notifySafe(db, {
      userId: w.userId,
      kind: 'price_alert',
      title: `${o.symbol} ${o.kind === 'alert_above' ? 'über' : 'unter'} ${Number(o.triggerPriceUsd).toPrecision(4)} $`,
      body: `Aktuell ${priceUsd.toPrecision(4)} $ (${w.label})`,
      link: '#/traden?tab=wallet',
    });
    return;
  }
  const side = o.kind === 'limit_buy' ? 'buy' : 'sell';
  try {
    const p = await prepareSwap(db, w, {
      side,
      token: o.token,
      amount: side === 'buy' ? (o.buyAmount ?? undefined) : undefined,
      percent: side === 'sell' ? Number(o.sellPercent ?? 100) : undefined,
      slippageBps: o.slippageBps ?? undefined,
    });
    const r = await executePreparedSwap(db, p, side, { userId: w.userId, ip: null, actor: 'system', confirmedLive: o.confirmedLive, origin: label, orderId: o.id });
    await closeOrder(db, o.id, 'filled', { tradeId: r.tradeId });
    out.filled++;
    if (w.mode === 'paper') {
      // live meldet executePreparedSwap selbst (mit Tx)
      await notifySafe(db, {
        userId: w.userId,
        kind: 'system',
        title: `${label} ausgeführt: ${o.symbol}`,
        body: `${p.quote.inAmount} ${p.quote.inToken.symbol} → ${p.quote.outAmount} ${p.quote.outToken.symbol} bei ${priceUsd.toPrecision(4)} $ (${w.label}, Paper)`,
        link: '#/traden?tab=wallet',
      });
    }
    if (side === 'sell') await cancelSellOrdersIfSoldOut(db, w.id, o.token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await closeOrder(db, o.id, 'failed', { error: msg });
    out.failed++;
    out.errors.push(`${label} ${o.symbol}: ${msg}`);
    await notifySafe(db, {
      userId: w.userId,
      kind: 'system',
      severity: 'warn',
      title: `${label} nicht ausgeführt: ${o.symbol}`,
      body: `${msg} (${w.label})`,
      link: '#/traden?tab=wallet',
    });
  }
}

export async function runSwapOrders(db: Db): Promise<SwapOrdersResult> {
  const out: SwapOrdersResult = { checked: 0, triggered: 0, filled: 0, failed: 0, errors: [] };
  const rows = await db
    .select({ order: swapOrders, wallet: swapWallets })
    .from(swapOrders)
    .innerJoin(swapWallets, eq(swapOrders.walletId, swapWallets.id))
    .where(and(eq(swapOrders.status, 'open'), ne(swapOrders.kind, 'dca'), isNull(swapWallets.archivedAt)));
  if (rows.length === 0) return out;

  const byChain = new Map<SwapChainId, Set<string>>();
  for (const r of rows) {
    const c = r.wallet.chain as SwapChainId;
    if (!byChain.has(c)) byChain.set(c, new Set());
    byChain.get(c)!.add(r.order.token);
  }
  const prices = new Map<string, number>();
  const depths = new Map<string, PoolDepth>();
  const markets = new Map<string, TokenMarket>();
  for (const [chain, tokens] of byChain) {
    try {
      const m = await fetchTokenMarket(chain, [...tokens], swapNet());
      for (const [t, v] of m) {
        prices.set(`${chain}:${t}`, v.priceUsd);
        markets.set(`${chain}:${t}`, v);
      }
      const pools = rows.filter((r) => r.wallet.chain === chain && r.order.kind === 'rug_guard' && r.order.pairAddress).map((r) => r.order.pairAddress!);
      if (pools.length > 0) for (const [a, d] of await fetchPairDepths(chain, pools, swapNet())) depths.set(`${chain}:${a}`, d);
    } catch (err) {
      // ohne Kurs keine Entscheidung — nichts auslösen, beim nächsten Takt neu
      out.errors.push(`Kurse ${chain}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const { order, wallet } of rows) {
    const price = prices.get(`${wallet.chain}:${order.token}`);
    if (price === undefined) continue;
    out.checked++;
    if (order.kind === 'rug_guard') {
      // nur der beim Anlegen festgehaltene Pool zählt; fehlt er in der Antwort → nichts entscheiden
      const pool = order.pairAddress ? (depths.get(`${wallet.chain}:${order.pairAddress}`) ?? null) : null;
      const before = order.peakDepth === null ? null : Number(order.peakDepth);
      const rg = evaluateRugGuard({ dropPct: order.trailPct === null ? null : Number(order.trailPct), peakDepth: before }, pool?.depth ?? null);
      if (rg.peakDepth !== null && rg.peakDepth !== before) {
        // neuer Höchststand: USD-Liquidität + Kurs dazu merken (Maßstab für einen späteren Umzug)
        await db
          .update(swapOrders)
          .set({ peakDepth: String(rg.peakDepth), ...(pool?.liquidityUsd != null ? { peakLiquidityUsd: String(pool.liquidityUsd), peakPriceUsd: String(price) } : {}) })
          .where(eq(swapOrders.id, order.id));
      }
      if (rg.trigger) {
        const best = markets.get(`${wallet.chain}:${order.token}`) ?? null;
        const num = (v: string | null) => (v === null ? null : Number(v));
        if (rugGuardMigrates({ pairAddress: order.pairAddress, peakLiquidityUsd: num(order.peakLiquidityUsd), peakPriceUsd: num(order.peakPriceUsd) }, best, price)) {
          // Token ist umgezogen: neuen Pool beobachten, nicht verkaufen
          await db
            .update(swapOrders)
            .set({
              pairAddress: best!.pairAddress,
              peakDepth: String(best!.depth),
              peakLiquidityUsd: best!.liquidityUsd === null ? null : String(best!.liquidityUsd),
              peakPriceUsd: String(price),
            })
            .where(and(eq(swapOrders.id, order.id), eq(swapOrders.status, 'open')));
          await notifySafe(db, {
            userId: wallet.userId,
            kind: 'system',
            title: `Rug-Schutz: ${order.symbol} ist in einen neuen Pool umgezogen`,
            body: `Der alte Pool hat Liquidität verloren, der Token handelt jetzt in einem neuen, tiefen Pool — der Rug-Schutz beobachtet ab sofort diesen (${wallet.label}). Nichts verkauft.`,
            link: '#/traden?tab=wallet',
          });
          continue;
        }
        await fireOrder(db, order, wallet, price, out);
      }
      continue;
    }
    const ev = evaluateSwapOrder(stateOf(order), price);
    if (order.kind === 'trailing_stop' && ev.peakPriceUsd !== null && ev.peakPriceUsd !== (order.peakPriceUsd === null ? null : Number(order.peakPriceUsd))) {
      await db.update(swapOrders).set({ peakPriceUsd: String(ev.peakPriceUsd) }).where(eq(swapOrders.id, order.id));
    }
    if (ev.trigger) await fireOrder(db, order, wallet, price, out);
  }
  return out;
}

/**
 * Beim Zurückziehen der Live-Freigabe bzw. Entfernen der Wallet: offene Orders
 * UND gerade laufende DCA stoppen (eine laufende DCA käme sonst nach ihrem
 * Kauf wieder auf „open“). Laufende Einzel-Orders schließen sich selbst ab.
 */
export function stoppableOrders(walletId: string, opts: { keepAlerts?: boolean } = {}) {
  const base = and(eq(swapOrders.walletId, walletId), or(eq(swapOrders.status, 'open'), and(eq(swapOrders.status, 'executing'), eq(swapOrders.kind, 'dca'))));
  // Preisalarme handeln nie → Freigabe zurückziehen lässt sie stehen (Entfernen der Wallet nicht)
  return opts.keepAlerts ? and(base, notInArray(swapOrders.kind, ALERT_KINDS)) : base;
}

/** Hängende „executing“-Orders (Prozess abgestürzt) nach 10 min als fehlgeschlagen markieren — nie doppelt ausführen. */
export async function failStuckSwapOrders(db: Db): Promise<number> {
  const rows = await db
    .update(swapOrders)
    .set({ status: 'failed', closedAt: new Date(), error: 'Ausführung unterbrochen — Status bitte prüfen (Bestand/Explorer).' })
    .where(and(eq(swapOrders.status, 'executing'), sql`${swapOrders.triggeredAt} < now() - interval '10 minutes'`))
    .returning({ id: swapOrders.id });
  return rows.length;
}

/** DCA nach einem Lauf (rein): Zähler hoch, fertig nach dem letzten Kauf, sonst nächster Termin ab jetzt (kein Nachholen verpasster Termine). */
export function dcaAfterRun(o: { runsDone: number; runsTotal: number; intervalMinutes: number }, now: Date): { runsDone: number; done: boolean; nextRunAt: Date } {
  const runsDone = o.runsDone + 1;
  return { runsDone, done: runsDone >= o.runsTotal, nextRunAt: new Date(now.getTime() + o.intervalMinutes * 60_000) };
}

export type DcaResult = { due: number; bought: number; skipped: number; failed: number; errors: string[] };

/**
 * DCA-Käufe (Vision-Punkt 5, „wie Trojan“): fällige Orders atomar
 * open → executing, Kauf über denselben Swap-Pfad wie das Ticket (Angebot,
 * Sicherheitscheck, Gate, Paper/Live). Jeder Termin zählt genau einmal —
 * ausgeführt, über der Preisgrenze übersprungen oder fehlgeschlagen —, damit
 * eine DCA nie endlos läuft und nie doppelt kauft.
 */
export async function runDcaOrders(db: Db, now = new Date()): Promise<DcaResult> {
  const out: DcaResult = { due: 0, bought: 0, skipped: 0, failed: 0, errors: [] };
  const rows = await db
    .select({ order: swapOrders, wallet: swapWallets })
    .from(swapOrders)
    .innerJoin(swapWallets, eq(swapOrders.walletId, swapWallets.id))
    .where(and(eq(swapOrders.status, 'open'), eq(swapOrders.kind, 'dca'), lte(swapOrders.nextRunAt, now), isNull(swapWallets.archivedAt)));
  for (const { order: o, wallet: w } of rows) {
    const claimed = await db
      .update(swapOrders)
      .set({ status: 'executing', triggeredAt: now })
      .where(and(eq(swapOrders.id, o.id), eq(swapOrders.status, 'open'), lte(swapOrders.nextRunAt, now)))
      .returning({ id: swapOrders.id });
    if (claimed.length === 0) continue;
    out.due++;
    const step = dcaAfterRun({ runsDone: o.runsDone, runsTotal: o.runsTotal ?? 1, intervalMinutes: o.intervalMinutes ?? 60 }, now);
    const nr = `${step.runsDone}/${o.runsTotal}`;
    let tradeId: string | null = o.tradeId;
    let note: string | null = null;
    try {
      const p = await prepareSwap(db, w, { side: 'buy', token: o.token, amount: o.buyAmount ?? undefined, slippageBps: o.slippageBps ?? undefined });
      const cap = o.maxPriceUsd === null ? null : Number(o.maxPriceUsd);
      if (cap !== null && p.info.priceUsd !== null && p.info.priceUsd > cap) {
        note = `Kauf ${nr} übersprungen: Kurs ${p.info.priceUsd.toPrecision(4)} $ über der Preisgrenze ${cap} $`;
        out.skipped++;
      } else {
        const r = await executePreparedSwap(db, p, 'buy', { userId: w.userId, ip: null, actor: 'system', confirmedLive: o.confirmedLive, origin: `DCA ${nr}`, orderId: o.id });
        tradeId = r.tradeId;
        out.bought++;
        if (w.mode === 'paper') {
          await notifySafe(db, {
            userId: w.userId,
            kind: 'system',
            title: `DCA-Kauf ${nr}: ${o.symbol}`,
            body: `${p.quote.inAmount} ${p.quote.inToken.symbol} → ${p.quote.outAmount} ${p.quote.outToken.symbol} (${w.label}, Paper)`,
            link: '#/traden?tab=wallet',
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      note = `Kauf ${nr} fehlgeschlagen: ${msg}`;
      out.failed++;
      out.errors.push(`DCA ${o.symbol}: ${msg}`);
      await notifySafe(db, { userId: w.userId, kind: 'system', severity: 'warn', title: `DCA-Kauf ${nr} nicht ausgeführt: ${o.symbol}`, body: `${msg} (${w.label})`, link: '#/traden?tab=wallet' });
    }
    // Nur zurück auf „open“, wenn niemand die Order inzwischen beendet hat (Freigabe
    // zurückgezogen, Wallet entfernt, als hängend markiert) — sonst Zähler + Ergebnis
    // nachtragen, Status aber stehen lassen. Nie eine gestoppte DCA wiederbeleben.
    const reopened = await db
      .update(swapOrders)
      .set({
        status: step.done ? 'filled' : 'open',
        runsDone: step.runsDone,
        nextRunAt: step.nextRunAt,
        tradeId,
        error: note,
        closedAt: step.done ? now : null,
      })
      .where(and(eq(swapOrders.id, o.id), eq(swapOrders.status, 'executing')))
      .returning({ id: swapOrders.id });
    if (reopened.length === 0) {
      await db.update(swapOrders).set({ runsDone: step.runsDone, tradeId }).where(eq(swapOrders.id, o.id));
    }
  }
  return out;
}
