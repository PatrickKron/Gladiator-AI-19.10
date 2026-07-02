import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { sql } from 'drizzle-orm';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import type { Db } from '@gladiator/db';
import type { LivePriceFeed, Ticker } from '@gladiator/market-data';
import { appRouter } from './routers/index.js';
import { buildContext } from './trpc.js';

export type AppOptions = {
  prices?: LivePriceFeed | null;
  /** Pfad zum gebauten Web-Frontend (dist). Fehlt er, wird nur die API bedient. */
  webDistDir?: string | null;
};

/**
 * CORS: NUR Origins aus der Whitelist (Env CORS_ORIGINS, kommasepariert).
 * Ohne Whitelist werden Cross-Origin-Requests abgelehnt — kein offenes cors() (Alt-Fehler).
 * Same-Origin (Web-UI wird vom selben Server ausgeliefert) braucht kein CORS.
 */
function corsOptions() {
  const allowed = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return cors({
    origin: (origin, cb) => {
      if (!origin || allowed.includes(origin)) return cb(null, true);
      cb(new Error('CORS: Origin nicht erlaubt.'));
    },
    credentials: true,
  });
}

export function defaultWebDistDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'web', 'dist');
}

export function createApp(db: Db, opts: AppOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(corsOptions());

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
    ['/api/trpc/auth.login', '/api/trpc/auth.register', '/api/trpc/auth.refresh'],
    rateLimit({
      windowMs: 60_000,
      limit: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Zu viele Auth-Versuche — bitte kurz warten.' },
    }),
  );

  // Ehrlicher Health-Check: prüft die echte DB-Verbindung.
  app.get('/health', async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ ok: true, db: 'up' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  /**
   * SSE-Stream mit echten Live-Ticks. BEWUSST ohne Auth: er enthält ausschließlich
   * öffentliche Binance-Marktdaten (Symbol/Preis/24h%) und speist den Daten-Rain
   * auch auf dem Login-Screen. Alle nutzerbezogenen Endpunkte bleiben geschützt.
   */
  app.get('/api/stream/prices', (req, res) => {
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

  app.use(
    '/api/trpc',
    createExpressMiddleware({
      router: appRouter,
      createContext: ({ req }) =>
        buildContext({
          db,
          prices: opts.prices ?? null,
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
