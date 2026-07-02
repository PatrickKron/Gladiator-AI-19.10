import { router } from '../trpc.js';
import { authRouter } from './auth.js';
import { marketRouter } from './market.js';
import { systemRouter } from './system.js';

export const appRouter = router({
  auth: authRouter,
  market: marketRouter,
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
