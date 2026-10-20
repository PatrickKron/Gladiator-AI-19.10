import Anthropic from '@anthropic-ai/sdk';

/**
 * Provider-Router & Kosten-Wächter (08_ §2).
 * Cloud-LLM (Anthropic) für anspruchsvolle Urteile; ohne Key ist der
 * Provider ehrlich „nicht konfiguriert" — abhängige Agenten werden
 * deaktiviert + markiert, NIE durch Zufallswerte ersetzt.
 * Der Kosten-Wächter (Tagesbudget in USD, UTC-Tag) blockt Aufrufe VOR dem
 * Provider, sobald das Budget erschöpft ist.
 */

export type LlmUsage = { inputTokens: number; outputTokens: number };

export type LlmCompletion = { text: string; usage: LlmUsage; costUsd: number };

export type LlmRequest = { system: string; prompt: string; maxTokens?: number };

export interface LlmProvider {
  readonly id: string;
  readonly configured: boolean;
  complete(opts: LlmRequest): Promise<LlmCompletion>;
  /** Optional: Antwort als Text-Deltas (z. B. Workshop-Dialog), Ergebnis wie complete(). */
  stream?(opts: LlmRequest, onText: (delta: string) => void): Promise<LlmCompletion>;
}

/** Preise Claude Opus 4.8 (USD je Token): $5/MTok Input, $25/MTok Output. */
const OPUS_INPUT_USD = 5 / 1_000_000;
const OPUS_OUTPUT_USD = 25 / 1_000_000;
const MODEL = 'claude-opus-4-8';

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  private client: Anthropic | null;

  constructor(apiKey?: string) {
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  async complete(opts: LlmRequest): Promise<LlmCompletion> {
    if (!this.client) throw new Error('Anthropic-Provider nicht konfiguriert (ANTHROPIC_API_KEY fehlt).');
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      thinking: { type: 'adaptive' },
      system: opts.system,
      messages: [{ role: 'user', content: opts.prompt }],
    });
    return toCompletion(response);
  }

  /** Streaming (messages.stream): Text-Deltas sofort weiterreichen, Kosten aus der finalen Usage. */
  async stream(opts: LlmRequest, onText: (delta: string) => void): Promise<LlmCompletion> {
    if (!this.client) throw new Error('Anthropic-Provider nicht konfiguriert (ANTHROPIC_API_KEY fehlt).');
    const stream = this.client.messages.stream({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      thinking: { type: 'adaptive' },
      system: opts.system,
      messages: [{ role: 'user', content: opts.prompt }],
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText(event.delta.text);
    }
    return toCompletion(await stream.finalMessage());
  }
}

function toCompletion(response: Anthropic.Message): LlmCompletion {
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const usage: LlmUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
  return {
    text,
    usage,
    costUsd: usage.inputTokens * OPUS_INPUT_USD + usage.outputTokens * OPUS_OUTPUT_USD,
  };
}

/** Tagesbudget-Wächter (UTC). In-Memory je Prozess; jede Buchung wird zusätzlich auditiert (Aufrufer). */
export class CostGuard {
  private readonly dailyBudgetUsd: number;
  private day = '';
  private spent = 0;

  constructor(opts: { dailyBudgetUsd: number }) {
    this.dailyBudgetUsd = opts.dailyBudgetUsd;
  }

  private roll(now: Date): void {
    const day = now.toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.spent = 0;
    }
  }

  allow(now: Date = new Date()): boolean {
    this.roll(now);
    return this.spent < this.dailyBudgetUsd;
  }

  record(costUsd: number, now: Date = new Date()): void {
    this.roll(now);
    this.spent += costUsd;
  }

  spentUsd(now: Date = new Date()): number {
    this.roll(now);
    return this.spent;
  }

  get budgetUsd(): number {
    return this.dailyBudgetUsd;
  }
}

/** Führt einen LLM-Aufruf NUR aus, wenn das Tagesbudget es erlaubt; bucht die Kosten danach. */
export async function guardedComplete(
  provider: LlmProvider,
  guard: CostGuard,
  opts: { system: string; prompt: string; maxTokens?: number },
  now: Date = new Date(),
): Promise<LlmCompletion> {
  if (!guard.allow(now)) {
    throw new Error(
      `LLM-Tagesbudget erschöpft (${guard.spentUsd(now).toFixed(2)} / ${guard.budgetUsd.toFixed(2)} USD) — Aufruf blockiert.`,
    );
  }
  const result = await provider.complete(opts);
  guard.record(result.costUsd, now);
  return result;
}

/**
 * Wie guardedComplete, aber mit Text-Deltas. Provider ohne Streaming fallen
 * ehrlich auf complete() zurück (der ganze Text kommt dann als ein Delta).
 */
export async function guardedStream(
  provider: LlmProvider,
  guard: CostGuard,
  opts: LlmRequest,
  onText: (delta: string) => void,
  now: Date = new Date(),
): Promise<LlmCompletion> {
  if (!guard.allow(now)) {
    throw new Error(
      `LLM-Tagesbudget erschöpft (${guard.spentUsd(now).toFixed(2)} / ${guard.budgetUsd.toFixed(2)} USD) — Aufruf blockiert.`,
    );
  }
  let result: LlmCompletion;
  if (provider.stream) {
    result = await provider.stream(opts, onText);
  } else {
    result = await provider.complete(opts);
    if (result.text) onText(result.text);
  }
  guard.record(result.costUsd, now);
  return result;
}

/**
 * Lazy-Singleton: liest ANTHROPIC_API_KEY bei JEDEM Zugriff aus process.env
 * und baut den Provider neu, wenn sich der Key geändert hat — so wirken
 * UI-gepflegte Secrets sofort, ohne Dienst-Neustart.
 */
let envProviderCache: { key: string | undefined; provider: AnthropicProvider } | null = null;
export function envAnthropicProvider(): AnthropicProvider {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!envProviderCache || envProviderCache.key !== key) {
    envProviderCache = { key, provider: new AnthropicProvider(key) };
  }
  return envProviderCache.provider;
}
