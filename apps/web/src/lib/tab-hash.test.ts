import { describe, expect, it } from 'vitest';
import { buildTabHash, parseTab } from './tab-hash.js';

const TABS = ['positionen', 'historie', 'risiko'] as const;

describe('parseTab', () => {
  it('liest gültigen Tab aus dem Hash', () => {
    expect(parseTab('#/trading?tab=risiko', TABS, 'positionen')).toBe('risiko');
  });
  it('unbekannter Tab → Fallback', () => {
    expect(parseTab('#/trading?tab=xyz', TABS, 'positionen')).toBe('positionen');
  });
  it('ohne Query → Fallback', () => {
    expect(parseTab('#/trading', TABS, 'positionen')).toBe('positionen');
  });
  it('Roundtrip build→parse', () => {
    expect(parseTab(buildTabHash('#/trading', 'historie'), TABS, 'positionen')).toBe('historie');
  });
});
