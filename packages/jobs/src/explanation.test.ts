/**
 * Nutzer-Erklärung des Signalobjekts (§11/§14): deterministische Reason-Codes
 * bleiben die Basis-Wahrheit; MIT konfiguriertem ANTHROPIC_API_KEY wird
 * zusätzlich eine LLM-Kurzfassung in der Sprache des Nutzers erzeugt.
 * Graceful degradation ist Pflicht: ohne Key, bei Budget-Stopp oder
 * LLM-Fehler kommt IMMER die deterministische Version zurück — nie ein Fehler.
 */
import { describe, expect, it } from 'vitest';
import { CostGuard, type LlmProvider } from '@gladiator/agents';
import {
  buildExplanationMessages,
  deterministicExplanation,
  explainForUser,
  sanitizeExplanation,
  type ExplanationFacts,
} from './explanation.js';

const FACTS: ExplanationFacts = {
  symbol: 'BTC/USDT',
  timeframe: '1h',
  direction: 'long',
  finalDecision: 'no_trade',
  hedgeMode: 'defensive',
  hedgeReason: 'CPI-Release-Fenster aktiv — Positionsgröße reduziert.',
  riskClass: 'high',
  regime: 'sideways',
  cpiStatus: 'release_window',
  cotStatus: 'crowded_long',
  buffettStatus: 'not_applicable',
  shadowWarning: '',
  devilsAdvocate: 'Historische Longs in dieser Session negativ.',
};

const fakeProvider = (opts: { configured: boolean; text?: string; fail?: boolean }): LlmProvider => ({
  id: 'fake',
  configured: opts.configured,
  complete: async () => {
    if (opts.fail) throw new Error('API down');
    return { text: opts.text ?? '', usage: { inputTokens: 10, outputTokens: 10 }, costUsd: 0.001 };
  },
});

const guard = () => new CostGuard({ dailyBudgetUsd: 5 });

describe('deterministicExplanation', () => {
  it('baut exakt das bisherige Reason-Code-Format (kein Regressionsbruch)', () => {
    expect(deterministicExplanation(FACTS)).toBe(
      'Entscheidung: no_trade. Hedge: CPI-Release-Fenster aktiv — Positionsgröße reduziert. CPI-Phase: release_window. COT: crowded_long.',
    );
  });

  it('lässt neutrale/nicht anwendbare Bausteine weg', () => {
    const out = deterministicExplanation({ ...FACTS, cpiStatus: 'none', cotStatus: 'neutral', buffettStatus: 'not_applicable' });
    expect(out).toBe('Entscheidung: no_trade. Hedge: CPI-Release-Fenster aktiv — Positionsgröße reduziert.');
  });
});

describe('buildExplanationMessages', () => {
  it('instruiert die Sprache des Nutzers; unbekanntes Locale fällt auf Deutsch zurück', () => {
    expect(buildExplanationMessages(FACTS, 'fr').system).toContain('Français');
    expect(buildExplanationMessages(FACTS, 'xx').system).toContain('Deutsch');
    expect(buildExplanationMessages(FACTS, undefined).system).toContain('Deutsch');
  });

  it('gibt dem Modell nur echte Fakten und verbietet neue Zahlen/Empfehlungen', () => {
    const { system, prompt } = buildExplanationMessages(FACTS, 'de');
    expect(prompt).toContain('BTC/USDT');
    expect(prompt).toContain('release_window');
    expect(system).toMatch(/keine (neuen |)Fakten/i);
  });
});

describe('sanitizeExplanation', () => {
  it('entfernt Code-Fences/Whitespace und deckelt die Länge', () => {
    expect(sanitizeExplanation('```\nKlarer Text.\n```')).toBe('Klarer Text.');
    expect(sanitizeExplanation('  a\n\n b ')).toBe('a b');
    expect(sanitizeExplanation('x'.repeat(2000)).length).toBeLessThanOrEqual(600);
  });
});

describe('explainForUser', () => {
  it('ohne konfigurierten Provider: deterministische Version, kein LLM-Call', async () => {
    const out = await explainForUser(fakeProvider({ configured: false }), guard(), FACTS, 'de');
    expect(out).toBe(deterministicExplanation(FACTS));
  });

  it('mit Provider: LLM-Kurzfassung ergänzt die deterministischen Codes', async () => {
    const out = await explainForUser(
      fakeProvider({ configured: true, text: 'Kein Trade: Der CPI-Release läuft gerade und Futures sind einseitig long positioniert.' }),
      guard(),
      FACTS,
      'de',
    );
    expect(out).toContain('CPI-Release läuft gerade');
    // Die Reason-Codes bleiben als auditierbare Basis enthalten
    expect(out).toContain('Entscheidung: no_trade.');
  });

  it('LLM-Fehler oder leere Antwort ⇒ still deterministisch (nie werfen)', async () => {
    const failed = await explainForUser(fakeProvider({ configured: true, fail: true }), guard(), FACTS, 'de');
    expect(failed).toBe(deterministicExplanation(FACTS));
    const empty = await explainForUser(fakeProvider({ configured: true, text: '   ' }), guard(), FACTS, 'de');
    expect(empty).toBe(deterministicExplanation(FACTS));
  });

  it('erschöpftes Tagesbudget ⇒ deterministisch statt Fehler', async () => {
    const g = new CostGuard({ dailyBudgetUsd: 1 });
    g.record(2);
    const out = await explainForUser(fakeProvider({ configured: true, text: 'sollte nie ankommen' }), g, FACTS, 'de');
    expect(out).toBe(deterministicExplanation(FACTS));
  });
});
