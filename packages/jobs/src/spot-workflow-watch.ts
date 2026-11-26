import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { fetchOnChainAssetBalance, type SpotNetworkId } from '@gladiator/exchange';
import { notifySafe } from './notify.js';

const { auditLog, spotWorkflows } = schema;

/**
 * Hintergrund-Wächter für laufende Spot-→-Wallet-Transfers (Welle 28):
 * Prüft regelmäßig alle offenen Spot-Workflows (`withdrawn` sowie Live-`awaiting_transfer`)
 * mit hinterlegter Zieladresse gegen die echte Blockchain (mempool.space / Solana RPC / EVM RPC).
 * Sobald der On-Chain-Kontostand gegenüber dem Stand beim Kauf (`baselineOnchainBalance`)
 * gestiegen ist, wird der Workflow automatisch auf `onchain_confirmed` gesetzt, im Audit-Log
 * dokumentiert und per In-App-Glocke + Web-Push gemeldet.
 */

export type SpotWorkflowWatchResult = {
  checked: number;
  confirmed: number;
  errors: string[];
};

/** Reine Entscheidungsfunktion: Ist ein neuer On-Chain-Eingang gegenüber dem Kauf-Ausgangsstand nachgewiesen? */
export function hasOnChainArrivalOccurred(
  baselineBalance: number | null,
  currentBalance: number | null,
  supported: boolean,
): boolean {
  if (!supported || currentBalance === null || !Number.isFinite(currentBalance)) return false;
  if (baselineBalance !== null && Number.isFinite(baselineBalance)) {
    return currentBalance > baselineBalance + 1e-8;
  }
  return currentBalance > 0;
}

export async function runSpotWorkflowWatch(
  db: Db,
  deps: {
    fetchBalance?: typeof fetchOnChainAssetBalance;
    notify?: typeof notifySafe;
  } = {},
): Promise<SpotWorkflowWatchResult> {
  const fetchBal = deps.fetchBalance ?? fetchOnChainAssetBalance;
  const sendNotify = deps.notify ?? notifySafe;

  const openRows = await db
    .select()
    .from(spotWorkflows)
    .where(
      and(
        inArray(spotWorkflows.stage, ['withdrawn', 'awaiting_transfer']),
        isNotNull(spotWorkflows.destinationAddress),
        isNotNull(spotWorkflows.destinationNetwork),
      ),
    );

  let checked = 0;
  let confirmed = 0;
  const errors: string[] = [];

  for (const wf of openRows) {
    // Paper-Workflows im Stadium awaiting_transfer warten auf den manuellen Klick des Nutzers
    if (wf.mode === 'paper' && wf.stage === 'awaiting_transfer') continue;
    if (!wf.destinationAddress || !wf.destinationNetwork) continue;

    checked++;
    try {
      const res = await fetchBal(
        wf.destinationNetwork as SpotNetworkId,
        wf.destinationAddress,
        wf.baseAsset,
      );
      const baseBefore = wf.baselineOnchainBalance !== null ? Number(wf.baselineOnchainBalance) : null;
      if (!hasOnChainArrivalOccurred(baseBefore, res.balance, res.supported)) {
        continue;
      }

      const note = `✅ Eingang auf der Blockchain automatisch bestätigt! Aktueller Wallet-Bestand: ${res.balance} ${res.unit}${baseBefore !== null ? ` (vorher: ${baseBefore} ${res.unit})` : ''}.`;

      await db
        .update(spotWorkflows)
        .set({
          stage: 'onchain_confirmed',
          confirmedOnchainBalance: String(res.balance),
          statusNote: note,
          updatedAt: new Date(),
        })
        .where(eq(spotWorkflows.id, wf.id));

      await db.insert(auditLog).values({
        actor: 'system',
        userId: wf.userId,
        action: 'spot.onchain.auto_confirmed',
        entityType: 'spot_workflow',
        entityId: wf.id,
        details: {
          symbol: wf.symbol,
          baseAsset: wf.baseAsset,
          network: wf.destinationNetwork,
          baselineBalance: baseBefore,
          confirmedBalance: res.balance,
        },
      });

      await sendNotify(db, {
        kind: 'price_alert',
        title: `✅ Wallet-Eingang bestätigt: ${wf.baseAsset} (${wf.destinationNetwork})`,
        body: `${note} Zieladresse: ${wf.destinationAddress.slice(0, 8)}…${wf.destinationAddress.slice(-6)}`,
        link: '#/traden?tab=spot',
      });

      confirmed++;
    } catch (err) {
      errors.push(`${wf.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { checked, confirmed, errors };
}
