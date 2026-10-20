import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { sql } from 'drizzle-orm';
import { workshopChatStreamHandler } from './workshop/chat-stream.js';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import type { Db } from '@gladiator/db';
import type { LivePriceFeed, Ticker } from '@gladiator/market-data';
import type { TradingVenue } from '@gladiator/exchange';
import { workerHeartbeatAgeSecAsync } from '@gladiator/jobs';
import { appRouter } from './routers/index.js';
import { buildContext } from './trpc.js';
import { pineWebhookHandler } from './webhook/pine.js';

export type AppOptions = {
  prices?: LivePriceFeed | null;
  venue?: TradingVenue | null;
  /** Pfad zum gebauten Web-Frontend (dist). Fehlt er, wird nur die API bedient. */
  webDistDir?: string | null;
};

/**
 * CORS: Same-Origin ist immer erlaubt (Vite-Module-Scripts senden auch same-origin
 * einen Origin-Header!), zusätzlich Origins aus der Whitelist (Env CORS_ORIGINS).
 * Fremde Origins bekommen schlicht KEINE CORS-Header (Browser blockt das Lesen) —
 * niemals einen Error werfen, das würde alle Browser-Requests mit 500 killen.
 */
function corsMiddleware(): express.RequestHandler {
  const allowed = new Set(
    (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );
  return (req, res, next) => {
    const selfOrigin = `${req.protocol}://${req.headers.host ?? ''}`;
    cors({
      origin: (origin, cb) => cb(null, !origin || origin === selfOrigin || allowed.has(origin)),
      credentials: true,
    })(req, res, next);
  };
}

export function defaultWebDistDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'web', 'dist');
}

export function createApp(db: Db, opts: AppOptions = {}): express.Express {
  const app = express();
  // Aktive SSE-Preis-Streams je Client-IP (Schutz gegen Socket-Hunger, s. /api/stream/prices).
  const sseStreamsByIp = new Map<string, number>();
  app.disable('x-powered-by');
  // helmet: upgrade-insecure-requests + HSTS deaktiviert — der Dienst läuft bewusst
  // über HTTP im Tailscale-Netz (WireGuard verschlüsselt). Mit der Default-CSP
  // würde der Browser alle Assets auf HTTPS zwingen → Seite bleibt schwarz.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: { upgradeInsecureRequests: null },
      },
      hsts: false,
    }),
  );
  app.use(corsMiddleware());

  // Rate-Limits: global moderat, Auth-Mutationen streng (Brute-Force-Schutz).
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(
    ['/api/trpc/auth.login', '/api/trpc/auth.register', '/api/trpc/auth.refresh', '/api/trpc/auth.autoLogin'],
    rateLimit({
      windowMs: 60_000,
      limit: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Zu viele Auth-Versuche — bitte kurz warten.' },
    }),
  );

  /**
   * Ehrlicher Health-Check (Phase 7): echte DB-Verbindung + Worker-Heartbeat
   * (Position-Monitor läuft minütlich) + Preis-Feed-Status. `degraded` wird
   * true, wenn der Worker > 5 min still ist — der Watchdog alarmiert dann.
   */
  app.get('/health', async (_req, res) => {
    let dbUp = true;
    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      dbUp = false;
    }
    // Prozessübergreifend: bei getrenntem Worker (ROLE=web) kommt der Takt aus Redis.
    const workerAgeSec = await workerHeartbeatAgeSecAsync();
    const degraded = workerAgeSec !== null && workerAgeSec > 300;
    const feed = opts.prices ? opts.prices.snapshot().status : null;
    res.status(dbUp ? 200 : 503).json({
      ok: dbUp && !degraded,
      db: dbUp ? 'up' : 'down',
      workerAgeSec, // null = Worker noch nicht gestartet (Boot-Phase)
      degraded,
      feed,
    });
  });

  /**
   * SSE-Stream mit echten Live-Ticks. BEWUSST ohne Auth: er enthält ausschließlich
   * öffentliche Binance-Marktdaten (Symbol/Preis/24h%) und speist den Daten-Rain
   * auch auf dem Login-Screen. Alle nutzerbezogenen Endpunkte bleiben geschützt.
   */
  app.get('/api/stream/prices', (req, res) => {
    // Max. 3 Streams je Client-IP: Chrome erlaubt nur 6 Verbindungen je Host —
    // halten viele (auch vergessene) Tabs je einen SSE-Stream, verhungern neue
    // Tabs endlos im "Lädt …". Überzählige bekommen 429; EventSource schließt
    // bei Nicht-200 DAUERHAFT (kein Reconnect), der Socket wird sofort frei.
    const clientKey = req.ip ?? 'unknown';
    const active = sseStreamsByIp.get(clientKey) ?? 0;
    if (active >= 3) {
      res.status(429).json({ error: 'Zu viele offene Preis-Streams von dieser Adresse — alte Gladiator-Tabs schließen oder neu laden.' });
      return;
    }
    sseStreamsByIp.set(clientKey, active + 1);
    res.on('close', () => {
      const n = (sseStreamsByIp.get(clientKey) ?? 1) - 1;
      if (n <= 0) sseStreamsByIp.delete(clientKey);
      else sseStreamsByIp.set(clientKey, n);
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const feed = opts.prices;
    if (!feed) {
      res.write(`event: feed\ndata: ${JSON.stringify({ feed: 'offline' })}\n\n`);
      // Verbindung offen halten, damit der Client nicht in eine Reconnect-Schleife läuft
      const idle = setInterval(() => res.write(': keepalive\n\n'), 25_000);
      req.on('close', () => clearInterval(idle));
      return;
    }

    // Initial: letzter bekannter Stand (echte Ticks)
    const snap = feed.snapshot();
    res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);

    const onTick = (t: Ticker) => res.write(`event: tick\ndata: ${JSON.stringify(t)}\n\n`);
    const onStatus = (s: unknown) => res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`);
    feed.on('tick', onTick);
    feed.on('status', onStatus);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000);

    req.on('close', () => {
      clearInterval(keepalive);
      feed.off('tick', onTick);
      feed.off('status', onStatus);
    });
  });

  /**
   * Pine-/TradingView-Webhook (07_ §1): Raw-Body (HMAC über exakte Bytes),
   * strenges Rate-Limit. Ohne PINE_WEBHOOK_SECRET antwortet er ehrlich 503.
   */
  app.post(
    '/api/webhook/pine',
    rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }),
    express.raw({ type: '*/*', limit: '64kb' }),
    pineWebhookHandler(db),
  );

  /** Workshop-Dialog als Stream (SSE über POST); gleiche Logik wie workshop.chat. */
  app.post(
    '/api/workshop/:id/chat-stream',
    rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }),
    express.json({ limit: '32kb' }),
    workshopChatStreamHandler(db),
  );

  app.use(
    '/api/trpc',
    createExpressMiddleware({
      router: appRouter,
      // Clients bekommen in Produktion keine Stacks mehr (sanitizeErrorShape) —
      // ungeplante Fehler landen dafür vollständig im Server-Log (journald).
      onError({ error, path }) {
        if (error.code === 'INTERNAL_SERVER_ERROR') {
          console.error(`[trpc] ${path ?? '<unbekannt>'}:`, error.cause ?? error);
        }
      },
      createContext: ({ req }) =>
        buildContext({
          db,
          prices: opts.prices ?? null,
          venue: opts.venue ?? null,
          authorizationHeader: req.headers.authorization ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          ip: req.ip ?? null,
        }),
    }),
  );

  // Web-UI (gebautes Vite-Frontend) ausliefern, wenn vorhanden — sonst nur API.
  const distDir = opts.webDistDir === undefined ? defaultWebDistDir() : opts.webDistDir;
  if (distDir && fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir));
    app.get(/^\/(?!api\/|health).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return app;
}
