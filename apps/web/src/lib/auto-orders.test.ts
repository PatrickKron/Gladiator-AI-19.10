import { describe, expect, it } from 'vitest';
import { AUTO_ORDERS_DEFAULT, buildAutoOrders, loadAutoOrders, saveAutoOrders } from './auto-orders.js';

describe('auto-orders', () => {
  it('aus → nichts; TP/SL einzeln oder zusammen; Komma erlaubt', () => {
    expect(buildAutoOrders({ ...AUTO_ORDERS_DEFAULT, enabled: false })).toEqual({ error: false });
    expect(buildAutoOrders({ enabled: true, takeProfitPct: '100', stopLossPct: '30' }).value).toEqual({ takeProfitPct: 100, stopLossPct: 30, sellPercent: 100 });
    expect(buildAutoOrders({ enabled: true, takeProfitPct: '', stopLossPct: '12,5' }).value).toEqual({ stopLossPct: 12.5, sellPercent: 100 });
  });

  it('ungültig → Fehler statt still ignorieren', () => {
    expect(buildAutoOrders({ enabled: true, takeProfitPct: '', stopLossPct: '' }).error).toBe(true);
    expect(buildAutoOrders({ enabled: true, takeProfitPct: 'x', stopLossPct: '30' }).error).toBe(true);
    expect(buildAutoOrders({ enabled: true, takeProfitPct: '50', stopLossPct: '99' }).error).toBe(true);
    expect(buildAutoOrders({ enabled: true, takeProfitPct: '0.5', stopLossPct: '' }).error).toBe(true);
  });

  it('je Wallet gemerkt; kaputter oder fehlender Speicher → Standard', () => {
    const store = new Map<string, string>();
    const st = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveAutoOrders('w1', { enabled: true, takeProfitPct: '80', stopLossPct: '25' }, st);
    expect(loadAutoOrders('w1', st)).toEqual({ enabled: true, takeProfitPct: '80', stopLossPct: '25' });
    expect(loadAutoOrders('w2', st)).toEqual(AUTO_ORDERS_DEFAULT);
    store.set('gladiator.autoTpSl.w3', '{kaputt');
    expect(loadAutoOrders('w3', st)).toEqual(AUTO_ORDERS_DEFAULT);
    expect(loadAutoOrders('w1', null)).toEqual(AUTO_ORDERS_DEFAULT);
  });
});
