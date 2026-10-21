import { describe, expect, it } from 'vitest';
import { isIdle } from './idle.js';

describe('Ruhe-Erkennung (Bildschirmschoner)', () => {
  it('ruht erst nach der Wartezeit, nie in einem verborgenen Tab', () => {
    expect(isIdle(0, 1000, 2000, false)).toBe(false);
    expect(isIdle(0, 2000, 2000, false)).toBe(true);
    expect(isIdle(0, 5000, 2000, false)).toBe(true);
    expect(isIdle(0, 5000, 2000, true)).toBe(false);
  });
});
