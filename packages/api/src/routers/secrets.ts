import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { schema } from '@gladiator/db';
import {
  BinanceTestnetVenue,
  HyperliquidTestnetVenue,
  deleteSecret,
  getSecretStatus,
  secretDef,
  setSecret,
  validateSecretValue,
  type SecretKey,
} from '@gladiator/exchange';
import { protectedProcedure, router } from '../trpc.js';

const { auditLog } = schema;

/**
 * UI-gepflegte Secrets (Patrick ohne SSH): Whitelist-Keys, Vault-verschlüsselt
 * (AES-256-GCM, ENCRYPTION_KEY), maskierte Anzeige, echte Funktionstests.
 * SICHERHEIT: Klartext-Werte tauchen NIE in Antworten, Logs oder Audit auf —
 * auditiert wird nur der Key-Name + last4.
 */

const KEY_ENUM = z.enum([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'ANTHROPIC_API_KEY',
  'PINE_WEBHOOK_SECRET',
  'BINANCE_TESTNET_KEY',
  'BINANCE_TESTNET_SECRET',
  'HYPERLIQUID_TESTNET_WALLET',
  'HYPERLIQUID_TESTNET_AGENT_KEY',
  'HEALTHCHECKS_URL',
  'FRED_API_KEY',
  'TWELVE_DATA_API_KEY',
]);

type TestResult = { ok: boolean; detail: string };

/** ECHTE Funktionstests gegen die jeweiligen Dienste — kein Fake-Grün. */
async function testSecret(key: SecretKey): Promise<TestResult> {
  const value = process.env[key];
  if (!value) return { ok: false, detail: 'Kein Wert gesetzt (weder DB noch .env).' };

  try {
    switch (key) {
      case 'TELEGRAM_BOT_TOKEN': {
        const res = await fetch(`https://api.telegram.org/bot${value}/getMe`);
        const json = (await res.json()) as { ok?: boolean; result?: { username?: string } };
        return json.ok
          ? { ok: true, detail: `Bot erreichbar: @${json.result?.username ?? '?'}` }
          : { ok: false, detail: `Telegram lehnt den Token ab (HTTP ${res.status}).` };
      }
      case 'TELEGRAM_CHAT_ID': {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) return { ok: false, detail: 'Erst TELEGRAM_BOT_TOKEN setzen — Chat-Test braucht den Bot.' };
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: value, text: '✅ Gladiator: Telegram-Test erfolgreich.' }),
        });
        const json = (await res.json()) as { ok?: boolean; description?: string };
        return json.ok
          ? { ok: true, detail: 'Testnachricht zugestellt — prüfe dein Telegram.' }
          : { ok: false, detail: `Telegram: ${json.description ?? `HTTP ${res.status}`}` };
      }
      case 'ANTHROPIC_API_KEY': {
        const res = await fetch('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': value, 'anthropic-version': '2023-06-01' },
        });
        if (res.ok) return { ok: true, detail: 'Anthropic-API akzeptiert den Key.' };
        return { ok: false, detail: `Anthropic lehnt ab (HTTP ${res.status}) — Key prüfen.` };
      }
      case 'BINANCE_TESTNET_KEY':
      case 'BINANCE_TESTNET_SECRET': {
        const k = process.env.BINANCE_TESTNET_KEY;
        const s = process.env.BINANCE_TESTNET_SECRET;
        if (!k || !s) return { ok: false, detail: 'Beide Binance-Werte (KEY + SECRET) setzen, dann testen.' };
        return await new BinanceTestnetVenue(k, s).validate();
      }
      case 'HYPERLIQUID_TESTNET_WALLET':
      case 'HYPERLIQUID_TESTNET_AGENT_KEY': {
        const w = process.env.HYPERLIQUID_TESTNET_WALLET;
        const a = process.env.HYPERLIQUID_TESTNET_AGENT_KEY;
        if (!w || !a) return { ok: false, detail: 'Beide Hyperliquid-Werte (WALLET + AGENT_KEY) setzen, dann testen.' };
        return await new HyperliquidTestnetVenue(w, a).validate();
      }
      case 'HEALTHCHECKS_URL': {
        const res = await fetch(value, { method: 'GET' });
        return res.ok
          ? { ok: true, detail: `Ping angenommen (HTTP ${res.status}) — Dead-Man's-Switch aktiv.` }
          : { ok: false, detail: `Monitor antwortet mit HTTP ${res.status}.` };
      }
      case 'FRED_API_KEY': {
        const res = await fetch(
          `https://api.stlouisfed.org/fred/series/observations?series_id=DFF&api_key=${value}&file_type=json&limit=1`,
        );
        return res.ok
          ? { ok: true, detail: 'FRED-API akzeptiert den Key.' }
          : { ok: false, detail: `FRED lehnt ab (HTTP ${res.status}).` };
      }
      case 'TWELVE_DATA_API_KEY': {
        // api_usage validiert den Key ohne Daten-Credit zu verbrauchen.
        const res = await fetch(`https://api.twelvedata.com/api_usage?apikey=${encodeURIComponent(value)}`);
        const json = (await res.json()) as { status?: string; message?: string; current_usage?: number; plan_limit?: number };
        if (json.status === 'error') return { ok: false, detail: `Twelve Data lehnt ab: ${json.message ?? 'Key ungültig'}.` };
        if (!res.ok) return { ok: false, detail: `Twelve Data HTTP ${res.status}.` };
        return {
          ok: true,
          detail: `Twelve Data akzeptiert den Key — Nutzung heute: ${json.current_usage ?? '?'}/${json.plan_limit ?? '?'} Calls.`,
        };
      }
      case 'PINE_WEBHOOK_SECRET':
        // Ehrlich: kein externer Test möglich — das Secret prüft eingehende Alerts.
        return { ok: true, detail: 'Format ok. Externer Test nicht möglich — TradingView-Alert senden, um den Webhook zu prüfen.' };
    }
  } catch (err) {
    return { ok: false, detail: `Test fehlgeschlagen: ${String(err).slice(0, 200)}` };
  }
}

export const secretsRouter = router({
  /** Status aller Whitelist-Keys — nur maskiert, nie Klartext. */
  list: protectedProcedure.query(({ ctx }) => getSecretStatus(ctx.db)),

  set: protectedProcedure
    .input(z.object({ key: KEY_ENUM, value: z.string().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const error = validateSecretValue(input.key, input.value);
      if (error) throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: error });
      const { last4 } = await setSecret(ctx.db, input.key, input.value, ctx.user.id);
      await ctx.db.insert(auditLog).values({
        actor: 'user',
        userId: ctx.user.id,
        action: 'secret.set',
        entityType: 'app_secret',
        details: { key: input.key, last4 }, // NIE der Wert
        ip: ctx.ip,
      });
      return { ok: true, immediate: secretDef(input.key)!.immediate };
    }),

  remove: protectedProcedure.input(z.object({ key: KEY_ENUM })).mutation(async ({ ctx, input }) => {
    await deleteSecret(ctx.db, input.key);
    await ctx.db.insert(auditLog).values({
      actor: 'user',
      userId: ctx.user.id,
      action: 'secret.deleted',
      entityType: 'app_secret',
      details: { key: input.key },
      ip: ctx.ip,
    });
    return { ok: true };
  }),

  /** Echter Funktionstest des GESPEICHERTEN Werts (DB/.env-aufgelöst). */
  test: protectedProcedure.input(z.object({ key: KEY_ENUM })).mutation(async ({ ctx, input }) => {
    const result = await testSecret(input.key);
    await ctx.db.insert(auditLog).values({
      actor: 'user',
      userId: ctx.user.id,
      action: result.ok ? 'secret.test.passed' : 'secret.test.failed',
      entityType: 'app_secret',
      details: { key: input.key, detail: result.detail.slice(0, 300) },
      ip: ctx.ip,
    });
    return result;
  }),

  /**
   * Dienst-Neustart aus der UI (für Boot-Time-Keys wie Börsen-Venues).
   * systemd (Restart=always) startet den Prozess neu; DB-Secrets werden beim
   * Boot geladen. Auditiert; antwortet vor dem Exit.
   */
  restartService: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.insert(auditLog).values({
      actor: 'user',
      userId: ctx.user.id,
      action: 'system.restart.requested',
      entityType: 'system',
      details: { reason: 'Secrets-Übernahme (UI)' },
      ip: ctx.ip,
    });
    setTimeout(() => {
      console.log('[system] Neustart via UI angefordert — Prozess beendet sich, systemd startet neu.');
      process.exit(0);
    }, 800);
    return { ok: true, detail: 'Dienst startet in < 15 s neu — die Seite danach neu laden.' };
  }),
});
