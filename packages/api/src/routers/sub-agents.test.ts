import { describe, expect, it } from 'vitest';
import { parseSubAgentSpec } from '@gladiator/strategy-engine';
import { SUB_AGENT_TEMPLATES } from './sub-agent-templates.js';

/**
 * Vorlagen sind Teil der öffentlichen API — jede MUSS eine valide, sofort
 * scharfschaltbare Definition sein. Dieser Test verhindert stilles Driften.
 */
describe('Sub-Agent-Vorlagen', () => {
  it('jede Vorlage ist eine valide subAgentSpec-Definition', () => {
    for (const tpl of SUB_AGENT_TEMPLATES) {
      const parsed = parseSubAgentSpec(tpl.spec);
      expect(parsed.ok, `${tpl.key}: ${parsed.ok ? '' : parsed.errors.join('; ')}`).toBe(true);
    }
  });

  it('Schlüssel sind eindeutig und Symbole gesetzt', () => {
    const keys = SUB_AGENT_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const tpl of SUB_AGENT_TEMPLATES) expect(tpl.symbols.length).toBeGreaterThan(0);
  });
});
