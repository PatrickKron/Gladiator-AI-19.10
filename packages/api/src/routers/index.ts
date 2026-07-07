import { router } from '../trpc.js';
import { agentsRouter } from './agents.js';
import { authRouter } from './auth.js';
import { labRouter } from './lab.js';
import { marketRouter } from './market.js';
import { productRouter } from './product.js';
import { riskRouter } from './risk.js';
import { secretsRouter } from './secrets.js';
import { settingsRouter } from './settings.js';
import { signalsRouter } from './signals.js';
import { strategiesRouter } from './strategies.js';
import { subAgentsRouter } from './sub-agents.js';
import { systemRouter } from './system.js';
import { tradingRouter } from './trading.js';

export const appRouter = router({
  agents: agentsRouter,
  auth: authRouter,
  lab: labRouter,
  market: marketRouter,
  product: productRouter,
  risk: riskRouter,
  secrets: secretsRouter,
  settings: settingsRouter,
  signals: signalsRouter,
  strategies: strategiesRouter,
  subAgents: subAgentsRouter,
  system: systemRouter,
  trading: tradingRouter,
});

export type AppRouter = typeof appRouter;
