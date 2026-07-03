import { router } from '../trpc.js';
import { authRouter } from './auth.js';
import { labRouter } from './lab.js';
import { marketRouter } from './market.js';
import { riskRouter } from './risk.js';
import { signalsRouter } from './signals.js';
import { systemRouter } from './system.js';
import { tradingRouter } from './trading.js';

export const appRouter = router({
  auth: authRouter,
  lab: labRouter,
  market: marketRouter,
  risk: riskRouter,
  signals: signalsRouter,
  system: systemRouter,
  trading: tradingRouter,
});

export type AppRouter = typeof appRouter;
