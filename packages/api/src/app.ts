import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { sql } from 'drizzle-orm';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import type { Db } from '@gladiator/db';
import { appRouter } from './routers/index.js';
import { buildContext } from './trpc.js';

/**
 * CORS: NUR Origins aus der Whitelist (Env CORS_ORIGINS, kommasepariert).
 * Ohne Whitelist werden Cross-Origin-Requests abgelehnt — kein offenes cors() (Alt-Fehler).
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

export function createApp(db: Db): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(corsOptions());

  // Rate-Limits: global moderat, Auth-Mutationen streng (Brute-Force-Schutz).
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
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

  app.use(
    '/api/trpc',
    createExpressMiddleware({
      router: appRouter,
      createContext: ({ req }) =>
        buildContext({
          db,
          authorizationHeader: req.headers.authorization ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          ip: req.ip ?? null,
        }),
    }),
  );

  return app;
}
