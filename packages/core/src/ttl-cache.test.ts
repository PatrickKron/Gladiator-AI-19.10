import { describe, expect, it } from 'vitest';
import { TtlLruCache } from './ttl-cache.js';

describe('TtlLruCache', () => {
  it('speichert Werte bis zum TTL-Ablauf und verwirft abgelaufene Einträge', () => {
    let t = 1_000;
    const cache = new TtlLruCache<string, number>({ maxSize: 10, ttlMs: 500, now: () => t });

    cache.set('btc', 95_000);
    expect(cache.get('btc')).toBe(95_000);
    expect(cache.has('btc')).toBe(true);

    t += 499;
    expect(cache.get('btc')).toBe(95_000);

    t += 1;
    expect(cache.get('btc')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('verdrängt den am längsten ungenutzten Schlüssel (echtes LRU)', () => {
    const cache = new TtlLruCache<string, string>({ maxSize: 2, ttlMs: 60_000 });
    cache.set('a', '1');
    cache.set('b', '2');
    // Zugriff auf 'a' macht 'b' zum ältesten Eintrag
    expect(cache.get('a')).toBe('1');
    cache.set('c', '3');

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
    expect(cache.size).toBe(2);
  });

  it('unterstützt individuelle TTL je Eintrag und prune()', () => {
    let t = 10_000;
    const cache = new TtlLruCache<string, string>({ maxSize: 5, ttlMs: 5_000, now: () => t });
    cache.set('short', 'x', 1_000);
    cache.set('long', 'y', 10_000);
    cache.set('forever', 'z', 0);

    t += 2_000;
    expect(cache.prune()).toBe(1);
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBe('y');
    expect(cache.get('forever')).toBe('z');
    expect(cache.size).toBe(2);
  });
});
