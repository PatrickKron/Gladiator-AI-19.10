/**
 * Begrenzter In-Memory-Cache mit TTL und LRU-Verdrängung.
 * Verhindert unbegrenztes Speicherwachstum bei dynamisch hinzugefügten Assets/Tokens
 * und hält veraltete Einträge automatisch sauber.
 */
export interface TtlLruCacheOptions {
  /** Maximale Anzahl Einträge (mind. 1). */
  maxSize: number;
  /** Standard-Gültigkeitsdauer in Millisekunden (0 = unbegrenzt bis LRU-Verdrängung). */
  ttlMs: number;
  /** Optionaler Zeitgeber (für deterministische Tests). */
  now?: () => number;
}

type CacheEntry<V> = {
  value: V;
  expiresAt: number | null;
};

export class TtlLruCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  constructor(opts: TtlLruCacheOptions) {
    this.maxSize = Math.max(1, Math.floor(opts.maxSize));
    this.defaultTtlMs = Math.max(0, opts.ttlMs);
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && this.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // LRU: Zugriff verschiebt den Eintrag ans Ende (zuletzt genutzt)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V, ttlMs: number = this.defaultTtlMs): void {
    const expiresAt = ttlMs > 0 ? this.now() + ttlMs : null;
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt });
    while (this.store.size > this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  /** Entfernt alle abgelaufenen Einträge und gibt die Anzahl entfernter Schlüssel zurück. */
  prune(): number {
    const t = this.now();
    let removed = 0;
    for (const [k, entry] of this.store) {
      if (entry.expiresAt !== null && t >= entry.expiresAt) {
        this.store.delete(k);
        removed++;
      }
    }
    return removed;
  }
}
