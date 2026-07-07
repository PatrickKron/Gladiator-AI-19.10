import { describe, expect, it } from 'vitest';
import { pickTf } from './chart-tf.js';

describe('pickTf', () => {
  it('Query-Override hat Vorrang vor gemerkt und Fallback', () => {
    expect(pickTf('4h', '1h', '15m')).toBe('4h');
  });
  it('ohne Override zählt der gemerkte Timeframe', () => {
    expect(pickTf(null, '4h')).toBe('4h');
  });
  it('ohne Override und ohne gemerkt → Fallback (Default 1h)', () => {
    expect(pickTf(null, null)).toBe('1h');
    expect(pickTf(null, null, '1d')).toBe('1d');
  });
});
