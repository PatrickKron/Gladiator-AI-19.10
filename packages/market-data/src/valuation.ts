import type { FetchLike } from './fx.js';

/**
 * USD-Bewertung von Börsen-Beständen (Vermögens-Ansicht): echte Binance-
 * Spot-Kurse je Währung. USD-Stablecoins zählen 1:1 (sie SIND die
 * USD-Quote-Einheit der Kurse — transparent als Annahme dokumentiert).
 * Währungen ohne verfügbaren Kurs bleiben ehrlich unbewertet (unvalued),
 * es wird NIE ein Preis erfunden.
 */

const USD_STABLES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'BUSD', 'USD']);
const BINANCE_BATCH = 'https://api.binance.com/api/v3/ticker/price?symbols=';

export type ValuedBalances = {
  /** Je Währung der USD-Wert (nur bewertbare). */
  valuedUsd: Record<string, number>;
  totalUsd: number;
  /** Währungen ohne echten Kurs — Anzeige „nicht bewertbar", zählt nicht in totalUsd. */
  unvalued: string[];
};

/** Holt echte USDT-Kurse für die gefragten Währungen (ein Batch-Call). */
async function fetchUsdtPrices(currencies: string[], fetchImpl: FetchLike): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (currencies.length === 0) return out;
  const symbols = currencies.map((c) => `${c}USDT`);
  // Binance batch: symbols=["BTCUSDT","ETHUSDT"] — unbekannte Symbole lassen
  // den GANZEN Batch fehlschlagen, deshalb fallen wir dann auf Einzelabfragen zurück.
  try {
    const url = BINANCE_BATCH + encodeURIComponent(JSON.stringify(symbols));
    const res = await fetchImpl(url);
    if (res.ok) {
      const body = (await res.json()) as { symbol: string; price: string }[];
      for (const row of body) {
        const price = Number(row.price);
        if (Number.isFinite(price) && price > 0) out.set(row.symbol.slice(0, -4), price);
      }
      return out;
    }
  } catch {
    // Batch fehlgeschlagen → Einzelabfragen unten
  }
  for (const c of currencies) {
    try {
      const res = await fetchImpl(`https://api.binance.com/api/v3/ticker/price?symbol=${c}USDT`);
      if (!res.ok) continue;
      const body = (await res.json()) as { price?: string };
      const price = Number(body.price);
      if (Number.isFinite(price) && price > 0) out.set(c, price);
    } catch {
      // Währung bleibt unbewertet — ehrlich.
    }
  }
  return out;
}

/** Bewertet {Währung → Menge} in USD mit echten Kursen. */
export async function valueBalancesUsd(
  amounts: Record<string, number>,
  fetchImpl: FetchLike = fetch,
): Promise<ValuedBalances> {
  const valuedUsd: Record<string, number> = {};
  const unvalued: string[] = [];
  const needPrice: string[] = [];

  for (const [currency, amount] of Object.entries(amounts)) {
    if (!(amount > 0)) continue;
    if (USD_STABLES.has(currency.toUpperCase())) valuedUsd[currency] = amount;
    else needPrice.push(currency.toUpperCase());
  }

  const prices = await fetchUsdtPrices(needPrice, fetchImpl);
  for (const [currency, amount] of Object.entries(amounts)) {
    if (!(amount > 0) || valuedUsd[currency] !== undefined) continue;
    const price = prices.get(currency.toUpperCase());
    if (price === undefined) unvalued.push(currency);
    else valuedUsd[currency] = amount * price;
  }

  const totalUsd = Object.values(valuedUsd).reduce((a, b) => a + b, 0);
  return { valuedUsd, totalUsd, unvalued: unvalued.sort() };
}
