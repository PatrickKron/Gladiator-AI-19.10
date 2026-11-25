import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import {
  checkAssetNetworkCompatibility,
  DEX_DIRECT_PRESETS,
  exchangeWithdrawUrl,
  executeCexSpotBuy,
  executeWhitelistedCexWithdraw,
  expectedWalletApprovalPhrase,
  explorerAddressUrl,
  fetchLiveSpotQuote,
  fetchOnChainAssetBalance,
  loadRiskSettings,
  SPOT_NETWORK_IDS,
  SPOT_NETWORKS,
  validateDestinationAddress,
  verifyWalletApprovalPhrase,
  WITHDRAW_CONFIRM_PHRASE,
  type SpotNetworkId,
} from '@gladiator/exchange';
import { protectedProcedure, router } from '../trpc.js';

const { auditLog, exchangeConnections, spotWorkflows, venueApprovals, walletAddressBook } = schema;

/**
 * tRPC-Router für den 3-Wege Spot-Kauf & Self-Custody Wallet-Workflow (Welle 27):
 * Bewusst ausschließlich manuelle User-Endpunkte (KEIN KI-/Chat-/Agenten-Zugriff auf Auszahlungen!).
 */
export const spotWorkflowRouter = router({
  /** Komplette Übersicht: 3 Wege, Netzwerke, Adressbuch, aktive Verbindungen & bisherige Workflows. */
  overview: protectedProcedure.query(async ({ ctx }) => {
    const [settings, wallets, workflows, connections, approvals] = await Promise.all([
      loadRiskSettings(ctx.db, ctx.user.id),
      ctx.db
        .select()
        .from(walletAddressBook)
        .where(eq(walletAddressBook.userId, ctx.user.id))
        .orderBy(desc(walletAddressBook.createdAt)),
      ctx.db
        .select()
        .from(spotWorkflows)
        .where(eq(spotWorkflows.userId, ctx.user.id))
        .orderBy(desc(spotWorkflows.createdAt))
        .limit(40),
      ctx.db
        .select({
          id: exchangeConnections.id,
          exchangeId: exchangeConnections.exchangeId,
          exchangeName: exchangeConnections.exchangeName,
          label: exchangeConnections.label,
          mode: exchangeConnections.mode,
          status: exchangeConnections.status,
        })
        .from(exchangeConnections)
        .where(
          and(
            eq(exchangeConnections.userId, ctx.user.id),
            eq(exchangeConnections.status, 'active'),
            isNull(exchangeConnections.revokedAt),
          ),
        ),
      ctx.db
        .select({ venueId: venueApprovals.venueId })
        .from(venueApprovals)
        .where(isNull(venueApprovals.revokedAt)),
    ]);

    const approvedVenues = new Set(approvals.map((a) => a.venueId));

    return {
      tradingMode: settings.mode,
      killSwitchActive: settings.killSwitchActive,
      withdrawConfirmPhrase: WITHDRAW_CONFIRM_PHRASE,
      networks: SPOT_NETWORKS,
      dexPresets: DEX_DIRECT_PRESETS,
      addressBook: wallets.map((w) => ({
        id: w.id,
        label: w.label,
        network: w.network as SpotNetworkId,
        address: w.address,
        memo: w.memo,
        isWhitelisted: w.isWhitelisted,
        approvedAt: w.approvedAt?.toISOString() ?? null,
        approvalPhraseExpected: expectedWalletApprovalPhrase(w.label),
        explorerUrl: explorerAddressUrl(w.network as SpotNetworkId, w.address),
      })),
      connections: connections.map((c) => ({
        ...c,
        hasLiveApproval: approvedVenues.has(c.exchangeId) || approvedVenues.has(`live:${c.id}`),
      })),
      workflows: workflows.map((wf) => ({
        id: wf.id,
        path: wf.path as 'guided_cex' | 'dex_direct' | 'api_withdraw',
        mode: wf.mode as 'paper' | 'live',
        exchangeConnectionId: wf.exchangeConnectionId,
        exchangeName: wf.exchangeName,
        symbol: wf.symbol,
        baseAsset: wf.baseAsset,
        quoteAsset: wf.quoteAsset,
        quoteAmount: Number(wf.quoteAmount),
        filledBaseQty: wf.filledBaseQty === null ? null : Number(wf.filledBaseQty),
        avgFillPrice: wf.avgFillPrice === null ? null : Number(wf.avgFillPrice),
        feePaid: wf.feePaid === null ? null : Number(wf.feePaid),
        exchangeOrderId: wf.exchangeOrderId,
        destinationWalletId: wf.destinationWalletId,
        destinationAddress: wf.destinationAddress,
        destinationNetwork: (wf.destinationNetwork as SpotNetworkId | null) ?? null,
        withdrawTxId: wf.withdrawTxId,
        withdrawFee: wf.withdrawFee === null ? null : Number(wf.withdrawFee),
        baselineOnchainBalance: wf.baselineOnchainBalance === null ? null : Number(wf.baselineOnchainBalance),
        confirmedOnchainBalance: wf.confirmedOnchainBalance === null ? null : Number(wf.confirmedOnchainBalance),
        stage: wf.stage,
        statusNote: wf.statusNote,
        explorerUrl:
          wf.destinationNetwork && wf.destinationAddress
            ? explorerAddressUrl(wf.destinationNetwork as SpotNetworkId, wf.destinationAddress)
            : null,
        exchangeWithdrawLink: exchangeWithdrawUrl(wf.exchangeName.split(' ')[0]!.toLowerCase(), wf.baseAsset),
        createdAt: wf.createdAt.toISOString(),
        updatedAt: wf.updatedAt.toISOString(),
      })),
    };
  }),

  /** Live-Spot-Kursvorschau + Netzwerk-Kompatibilitätsprüfung vor dem Kauf. */
  quote: protectedProcedure
    .input(
      z.object({
        symbol: z.string().trim().min(3).max(24),
        quoteAmount: z.number().positive().max(10_000_000),
        exchangeId: z.string().trim().default('binance'),
        network: z.enum(SPOT_NETWORK_IDS).optional(),
      }),
    )
    .query(async ({ input }) => {
      const norm = input.symbol.trim().toUpperCase();
      const [baseAsset = 'BTC', quoteAsset = 'USDT'] = norm.split('/');
      const q = await fetchLiveSpotQuote(norm, input.exchangeId);
      const feeQuote = Math.round(input.quoteAmount * q.takerFeeRate * 100) / 100;
      const estBaseQty = (input.quoteAmount - feeQuote) / q.askPrice;
      const compatibility = input.network ? checkAssetNetworkCompatibility(baseAsset, input.network) : { compatible: true, warning: null };
      return {
        symbol: norm,
        baseAsset,
        quoteAsset,
        askPrice: q.askPrice,
        feeQuote,
        estBaseQty,
        exchangeId: q.exchangeId,
        compatibility,
      };
    }),

  /** Ziel-Wallet ins Adressbuch eintragen (strenge Formatprüfung + On-Chain-Check). */
  addWallet: protectedProcedure
    .input(
      z.object({
        label: z.string().trim().min(2).max(60),
        network: z.enum(SPOT_NETWORK_IDS),
        address: z.string().trim().min(10).max(120),
        memo: z.string().trim().max(80).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const v = validateDestinationAddress(input.network, input.address);
      if (!v.valid) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: v.reason ?? 'Ungültige Zieladresse.' });
      }
      const onchain = await fetchOnChainAssetBalance(input.network, v.normalized).catch(() => null);
      const [inserted] = await ctx.db
        .insert(walletAddressBook)
        .values({
          userId: ctx.user.id,
          label: input.label,
          network: input.network,
          address: v.normalized,
          memo: input.memo || null,
          isWhitelisted: false,
        })
        .returning();

      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'wallet_book.add',
        entityType: 'wallet_address_book',
        entityId: inserted!.id,
        details: { label: input.label, network: input.network, addressLast6: v.normalized.slice(-6) },
      });

      return { wallet: inserted!, onchain };
    }),

  /** Ziel-Wallet per Bestätigungsphrase `WALLET-FREIGABE <Label>` für Weg C freischalten. */
  approveWallet: protectedProcedure
    .input(z.object({ id: z.string().uuid(), phrase: z.string().trim().min(5).max(120) }))
    .mutation(async ({ ctx, input }) => {
      const [w] = await ctx.db
        .select()
        .from(walletAddressBook)
        .where(and(eq(walletAddressBook.id, input.id), eq(walletAddressBook.userId, ctx.user.id)))
        .limit(1);
      if (!w) throw new TRPCError({ code: 'NOT_FOUND', message: 'Wallet-Eintrag nicht gefunden.' });

      if (!verifyWalletApprovalPhrase(input.phrase, w.label)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Bitte exakt „${expectedWalletApprovalPhrase(w.label)}“ eingeben.`,
        });
      }

      const [updated] = await ctx.db
        .update(walletAddressBook)
        .set({ isWhitelisted: true, approvedAt: new Date() })
        .where(eq(walletAddressBook.id, w.id))
        .returning();

      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'wallet_book.whitelist_approve',
        entityType: 'wallet_address_book',
        entityId: w.id,
        details: { label: w.label, network: w.network },
      });

      return updated!;
    }),

  /** Ziel-Wallet aus dem Adressbuch entfernen. */
  deleteWallet: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [deleted] = await ctx.db
        .delete(walletAddressBook)
        .where(and(eq(walletAddressBook.id, input.id), eq(walletAddressBook.userId, ctx.user.id)))
        .returning({ id: walletAddressBook.id });
      if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'Wallet-Eintrag nicht gefunden.' });
      return { ok: true };
    }),

  /** Live-On-Chain-Saldo einer gespeicherten Wallet abfragen. */
  walletBalance: protectedProcedure
    .input(z.object({ id: z.string().uuid(), asset: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const [w] = await ctx.db
        .select()
        .from(walletAddressBook)
        .where(and(eq(walletAddressBook.id, input.id), eq(walletAddressBook.userId, ctx.user.id)))
        .limit(1);
      if (!w) throw new TRPCError({ code: 'NOT_FOUND', message: 'Wallet nicht gefunden.' });
      return fetchOnChainAssetBalance(w.network as SpotNetworkId, w.address, input.asset);
    }),

  /** Schritt 1: CEX-Spot-Kauf ausführen (Paper-Default oder Live hinter allen Gates). */
  buySpot: protectedProcedure
    .input(
      z.object({
        path: z.enum(['guided_cex', 'api_withdraw']).default('guided_cex'),
        mode: z.enum(['paper', 'live']).default('paper'),
        symbol: z.string().trim().min(3).max(24),
        quoteAmount: z.number().positive().max(1_000_000),
        exchangeConnectionId: z.string().uuid().nullable().optional(),
        destinationWalletId: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await executeCexSpotBuy(ctx.db, {
          userId: ctx.user.id,
          ...input,
        });
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : 'Spot-Kauf fehlgeschlagen.',
        });
      }
    }),

  /** Weg A (Geführter Transfer): Nutzer markiert, dass er die Auszahlung auf der Börse mit 2FA gesendet hat. */
  markManualSent: protectedProcedure
    .input(z.object({ workflowId: z.string().uuid(), txId: z.string().trim().max(140).optional() }))
    .mutation(async ({ ctx, input }) => {
      const [wf] = await ctx.db
        .select()
        .from(spotWorkflows)
        .where(and(eq(spotWorkflows.id, input.workflowId), eq(spotWorkflows.userId, ctx.user.id)))
        .limit(1);
      if (!wf) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workflow nicht gefunden.' });

      const nextStage = wf.mode === 'paper' ? 'onchain_confirmed' : 'withdrawn';
      const [updated] = await ctx.db
        .update(spotWorkflows)
        .set({
          stage: nextStage,
          withdrawTxId: input.txId || wf.withdrawTxId || (wf.mode === 'paper' ? `paper-guided-${wf.id.slice(0, 8)}` : null),
          statusNote:
            wf.mode === 'paper'
              ? 'Paper-Workflow abgeschlossen (geführter Transfer durchgespielt).'
              : 'Auszahlung als gesendet markiert — prüfe mit „On-Chain-Eingang prüfen“, sobald die Blockchain bestätigt hat.',
          updatedAt: new Date(),
        })
        .where(eq(spotWorkflows.id, wf.id))
        .returning();
      return updated!;
    }),

  /** Weg C (1-Klick API-Auszahlung an eigene Whitelist-Wallet, verlangt `TRANSFER BESTÄTIGEN`). */
  withdrawToWhitelistedWallet: protectedProcedure
    .input(
      z.object({
        workflowId: z.string().uuid(),
        confirmPhrase: z.string().trim().min(3).max(60),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await executeWhitelistedCexWithdraw(ctx.db, {
          userId: ctx.user.id,
          workflowId: input.workflowId,
          confirmPhrase: input.confirmPhrase,
        });
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : 'Auszahlung fehlgeschlagen.',
        });
      }
    }),

  /** Prüft live auf der echten Blockchain, ob der Kontostand auf der Ziel-Wallet gestiegen ist. */
  checkOnChainArrival: protectedProcedure
    .input(z.object({ workflowId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [wf] = await ctx.db
        .select()
        .from(spotWorkflows)
        .where(and(eq(spotWorkflows.id, input.workflowId), eq(spotWorkflows.userId, ctx.user.id)))
        .limit(1);
      if (!wf) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workflow nicht gefunden.' });
      if (!wf.destinationAddress || !wf.destinationNetwork) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Keine Ziel-Wallet am Workflow hinterlegt.' });
      }

      const res = await fetchOnChainAssetBalance(
        wf.destinationNetwork as SpotNetworkId,
        wf.destinationAddress,
        wf.baseAsset,
      );

      const baseBefore = wf.baselineOnchainBalance !== null ? Number(wf.baselineOnchainBalance) : null;
      const arrived =
        res.supported &&
        res.balance !== null &&
        ((baseBefore !== null && res.balance > baseBefore + 1e-8) || (baseBefore === null && res.balance > 0));

      const note = !res.supported
        ? `Automatischer Token-Check für ${wf.baseAsset} auf ${wf.destinationNetwork} nicht direkt per Standard-RPC hinterlegt — bitte über den Block-Explorer-Link prüfen.`
        : res.balance === null
          ? `RPC momentan nicht erreichbar (${res.error ?? 'Timeout'}) — später erneut prüfen oder Block-Explorer öffnen.`
          : arrived
            ? `✅ Eingang auf der Blockchain bestätigt! Aktueller Wallet-Bestand: ${res.balance} ${res.unit}${baseBefore !== null ? ` (vorher: ${baseBefore} ${res.unit})` : ''}.`
            : `Aktueller On-Chain-Bestand: ${res.balance} ${res.unit}${baseBefore !== null ? ` (unverändert seit Kauf: ${baseBefore} ${res.unit})` : ''} — noch kein neuer Eingang sichtbar.`;

      const [updated] = await ctx.db
        .update(spotWorkflows)
        .set({
          ...(arrived ? { stage: 'onchain_confirmed', confirmedOnchainBalance: String(res.balance) } : {}),
          statusNote: note,
          updatedAt: new Date(),
        })
        .where(eq(spotWorkflows.id, wf.id))
        .returning();

      return {
        arrived,
        onchain: res,
        workflow: updated!,
      };
    }),
});
