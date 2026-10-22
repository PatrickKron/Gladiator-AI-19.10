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

/**
 * Werkzeug-Dialog (Gladiator-Chat, Patricks Mängelliste Punkt 4): das Modell darf
 * benannte Werkzeuge aufrufen (Strategie vorschlagen, Backtest starten, Screen laufen
 * lassen …); der Aufrufer führt sie aus und reicht das Ergebnis zurück. Neutrale Typen —
 * kein SDK-Typ verlässt dieses Modul.
 */
export type LlmTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type LlmContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };
export type LlmChatMessage = { role: 'user' | 'assistant'; content: string | LlmContentBlock[] };
export type LlmChatRequest = { system: string; messages: LlmChatMessage[]; tools?: LlmTool[]; maxTokens?: number };
export type LlmChatResult = {
  /** Alle Text-Blöcke der Antwort, zusammengefügt. */
  text: string;
  /** Die Antwort-Blöcke in Originalreihenfolge (für den Verlauf beim nächsten Turn). */
  blocks: LlmContentBlock[];
  toolUses: { id: string; name: string; input: Record<string, unknown> }[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
  usage: LlmUsage;
  costUsd: number;
};

export interface LlmProvider {
  readonly id: string;
  readonly configured: boolean;
  complete(opts: LlmRequest): Promise<LlmCompletion>;
  /** Optional: Antwort als Text-Deltas (z. B. Workshop-Dialog), Ergebnis wie complete(). */
  stream?(opts: LlmRequest, onText: (delta: string) => void): Promise<LlmCompletion>;
  /** Optional: Dialog mit Werkzeugen (Text-Deltas sofort, Werkzeug-Aufrufe am Ende des Turns). */
  chat?(opts: LlmChatRequest, onText?: (delta: string) => void): Promise<LlmChatResult>;
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

  /** Dialog mit Werkzeugen: eine Modell-Antwort je Aufruf; Werkzeuge führt der Aufrufer aus. */
  async chat(opts: LlmChatRequest, onText?: (delta: string) => void): Promise<LlmChatResult> {
    if (!this.client) throw new Error('Anthropic-Provider nicht konfiguriert (ANTHROPIC_API_KEY fehlt).');
    const stream = this.client.messages.stream({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages: opts.messages.map(toSdkMessage),
      ...(opts.tools && opts.tools.length > 0
        ? { tools: opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool['input_schema'] })) }
        : {}),
    });
    if (onText) {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText(event.delta.text);
      }
    }
    return toChatResult(await stream.finalMessage());
  }
}

function toSdkMessage(m: LlmChatMessage): Anthropic.MessageParam {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map((b): Anthropic.ContentBlockParam => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) };
    }),
  };
}

function toChatResult(response: Anthropic.Message): LlmChatResult {
  const blocks: LlmContentBlock[] = [];
  for (const b of response.content) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
  }
  const usage: LlmUsage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  const stop = response.stop_reason;
  return {
    text: blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n'),
    blocks,
    toolUses: blocks.filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use'),
    stopReason: stop === 'end_turn' || stop === 'tool_use' || stop === 'max_tokens' ? stop : 'other',
    usage,
    costUsd: usage.inputTokens * OPUS_INPUT_USD + usage.outputTokens * OPUS_OUTPUT_USD,
  };
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

/** Wie guardedComplete, für den Werkzeug-Dialog: Budget VOR dem Aufruf prüfen, Kosten danach buchen. */
export async function guardedChat(
  provider: LlmProvider,
  guard: CostGuard,
  opts: LlmChatRequest,
  onText?: (delta: string) => void,
  now: Date = new Date(),
): Promise<LlmChatResult> {
  if (!guard.allow(now)) {
    throw new Error(`LLM-Tagesbudget erschöpft (${guard.spentUsd(now).toFixed(2)} / ${guard.budgetUsd} USD) — morgen wieder verfügbar.`);
  }
  if (!provider.chat) throw new Error(`Provider ${provider.id} kann keinen Werkzeug-Dialog.`);
  const res = await provider.chat(opts, onText);
  guard.record(res.costUsd, now);
  return res;
}
