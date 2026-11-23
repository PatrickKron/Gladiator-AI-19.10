import type { Db } from '@gladiator/db';
import { parseHedgingConfig } from '@gladiator/risk';
import { promoteVersion } from '../routers/strategies.js';
import { applyHedgingConfig, applyKillSwitch, applyTradingSettings, ensureTradingSettings, settingsInput } from '../routers/settings.js';
import { placeDemoOrderFor } from '../routers/demo.js';
import type { ConfirmRequest } from './tools.js';

/**
 * Führt eine bestätigte Karte aus — der EINZIGE Weg, über den der Gladiator-Chat etwas
 * scharf schaltet. Jede Aktion nutzt dieselbe Service-Funktion wie die Seite (Gate, Audit,
 * Benachrichtigung inklusive). Liefert die Notiz für die Karte.
 */
export async function executeConfirm(db: Db, user: { id: string; email: string }, req: ConfirmRequest, ip: string | null): Promise<string> {
  switch (req.action) {
    case 'promote_version': {
      const v = await promoteVersion(db, user.id, req.args.versionId, ip);
      return `Version ${v.version} läuft jetzt auf Paper.`;
    }
    case 'update_settings': {
      const row = await ensureTradingSettings(db, user.id);
      const merged = settingsInput.parse({
        riskPctPerTrade: Number(row.riskPctPerTrade),
        maxLeverage: Number(row.maxLeverage),
        maxOpenPositions: row.maxOpenPositions,
        maxExposurePctPerAsset: Number(row.maxExposurePctPerAsset),
        dailyLossLimitPct: Number(row.dailyLossLimitPct),
        weeklyLossLimitPct: Number(row.weeklyLossLimitPct),
        maxDrawdownPct: Number(row.maxDrawdownPct),
        ...req.args,
      });
      await applyTradingSettings(db, user.id, merged, ip);
      return `Gespeichert: ${Object.entries(req.args)
        .map(([k, v]) => `${k} = ${v}`)
        .join(', ')} — gilt ab jetzt für jede Order.`;
    }
    case 'kill_switch': {
      const out = await applyKillSwitch(db, user, req.args.active, ip);
      return out.killSwitchActive ? 'Kill-Switch ist AKTIV — keine Agenten-Orders mehr.' : 'Kill-Switch ist aus — Agenten-Orders wieder frei.';
    }
    case 'demo_order': {
      const r = await placeDemoOrderFor(db, user.id, req.args);
      const fill = r.avgFillPrice !== null ? ` zu ≈ ${r.avgFillPrice.toFixed(2)}` : '';
      return `Demo-Order gesetzt (${r.status})${fill} — Übungskonto, kein echtes Geld.`;
    }
    case 'update_hedging': {
      const row = await ensureTradingSettings(db, user.id);
      const current = parseHedgingConfig(row.hedgingConfig);
      const nextAssignments = { ...current.assetAssignments };
      if (req.args.assetAssignments) {
        for (const [sym, id] of Object.entries(req.args.assetAssignments)) {
          if (id === '__default__') delete nextAssignments[sym.toUpperCase()];
          else nextAssignments[sym.toUpperCase()] = id;
        }
      }
      const merged = {
        ...current,
        ...(req.args.enabled !== undefined ? { enabled: req.args.enabled } : {}),
        ...(req.args.defaultStrategyId !== undefined ? { defaultStrategyId: req.args.defaultStrategyId } : {}),
        ...(req.args.triggerVix !== undefined ? { triggerVix: req.args.triggerVix } : {}),
        ...(req.args.triggerDrawdownPct !== undefined ? { triggerDrawdownPct: req.args.triggerDrawdownPct } : {}),
        ...(req.args.maxHedgeRatioPct !== undefined ? { maxHedgeRatioPct: req.args.maxHedgeRatioPct } : {}),
        assetAssignments: nextAssignments,
      };
      await applyHedgingConfig(db, user.id, merged, ip);
      return 'Pro-Asset-Hedging gespeichert — greift ab sofort im Signal-Review, Ticket-Sizing und Hedging-Designer.';
    }
    default: {
      const never: never = req;
      throw new Error(`Unbekannte Aktion: ${JSON.stringify(never)}`);
    }
  }
}
