/**
 * Auto-TP/SL beim Kauf (Trojan): Einstellung je Wallet im Browser gemerkt
 * (reine Ansichts-Vorgabe — angelegt werden die Orders erst nach dem Kauf
 * vom Server, mit derselben Prüfung wie von Hand).
 */

export type AutoOrdersSetting = { enabled: boolean; takeProfitPct: string; stopLossPct: string };

export const AUTO_ORDERS_DEFAULT: AutoOrdersSetting = { enabled: false, takeProfitPct: '100', stopLossPct: '30' };

const key = (walletId: string) => `gladiator.autoTpSl.${walletId}`;

export function loadAutoOrders(walletId: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): AutoOrdersSetting {
  try {
    const raw = storage?.getItem(key(walletId));
    if (!raw) return AUTO_ORDERS_DEFAULT;
    const v = JSON.parse(raw) as Partial<AutoOrdersSetting>;
    return {
      enabled: v.enabled === true,
      takeProfitPct: typeof v.takeProfitPct === 'string' ? v.takeProfitPct : AUTO_ORDERS_DEFAULT.takeProfitPct,
      stopLossPct: typeof v.stopLossPct === 'string' ? v.stopLossPct : AUTO_ORDERS_DEFAULT.stopLossPct,
    };
  } catch {
    return AUTO_ORDERS_DEFAULT;
  }
}

export function saveAutoOrders(walletId: string, s: AutoOrdersSetting, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(key(walletId), JSON.stringify(s));
  } catch {
    // privater Modus o. Ä.: Einstellung gilt dann nur für diese Ansicht
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const pct = (v: string) => {
  const t = v.trim().replace(',', '.');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
};

/**
 * Für execute(): undefined = aus. Leeres Feld = dieser Teil aus.
 * Ungültige Werte → `error` (Kauf-Knopf bleibt dann gesperrt, nie still ignoriert).
 */
export function buildAutoOrders(s: AutoOrdersSetting): { value?: { takeProfitPct?: number; stopLossPct?: number; sellPercent: number }; error: boolean } {
  if (!s.enabled) return { error: false };
  const tp = pct(s.takeProfitPct);
  const sl = pct(s.stopLossPct);
  const tpBad = tp !== undefined && !(tp >= 1 && tp <= 10_000);
  const slBad = sl !== undefined && !(sl >= 1 && sl <= 95);
  if (tpBad || slBad || (tp === undefined && sl === undefined)) return { error: true };
  return { value: { ...(tp !== undefined ? { takeProfitPct: tp } : {}), ...(sl !== undefined ? { stopLossPct: sl } : {}), sellPercent: 100 }, error: false };
}
