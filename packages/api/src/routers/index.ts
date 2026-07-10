import { router } from '../trpc.js';
import { agentsRouter } from './agents.js';
import { authRouter } from './auth.js';
import { catalogRouter } from './catalog.js';
import { demoRouter } from './demo.js';
import { exchangesRouter } from './exchanges.js';
import { intelligenceRouter } from './intelligence.js';
import { labRouter } from './lab.js';
import { marketRouter } from './market.js';
import { mlRouter } from './ml.js';
import { productRouter } from './product.js';
import { rlRouter } from './rl.js';
import { riskRouter } from './risk.js';
import { secretsRouter } from './secrets.js';
import { settingsRouter } from './settings.js';
import { signalsRouter } from './signals.js';
import { strategiesRouter } from './strategies.js';
import { subAgentsRouter } from './sub-agents.js';
import { systemRouter } from './system.js';
import { tradingRouter } from './trading.js';
import { workshopRouter } from './workshop.js';

export const appRouter = router({
  agents: agentsRouter,
  auth: authRouter,
  catalog: catalogRouter,
  demo: demoRouter,
  exchanges: exchangesRouter,
  intelligence: intelligenceRouter,
  lab: labRouter,
  market: marketRouter,
  ml: mlRouter,
  product: productRouter,
  rl: rlRouter,
  risk: riskRouter,
  secrets: secretsRouter,
  settings: settingsRouter,
  signals: signalsRouter,
  strategies: strategiesRouter,
  subAgents: subAgentsRouter,
  system: systemRouter,
  trading: tradingRouter,
  workshop: workshopRouter,
});

export type AppRouter = typeof appRouter;
