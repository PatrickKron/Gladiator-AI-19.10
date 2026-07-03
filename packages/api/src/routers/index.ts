import { router } from '../trpc.js';
import { authRouter } from './auth.js';
import { labRouter } from './lab.js';
import { marketRouter } from './market.js';
import { signalsRouter } from './signals.js';
import { systemRouter } from './system.js';

export const appRouter = router({
  auth: authRouter,
  lab: labRouter,
  market: marketRouter,
  signals: signalsRouter,
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
