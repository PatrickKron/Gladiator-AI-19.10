import { describe, expect, it } from 'vitest';
import { de } from './de.js';
import { en } from './en.js';
import { it as itCatalog } from './it.js';
import { es } from './es.js';
import { fr } from './fr.js';

/**
 * B6-Wächter: alle 5 Sprachkataloge haben EXAKT dieselben Keys und
 * identische Interpolations-Platzhalter — keine Sprache fällt still auf
 * fehlende Übersetzungen zurück.
 */

function flatten(obj: Record<string, unknown>, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else if (v && typeof v === 'object') for (const [k2, v2] of flatten(v as Record<string, unknown>, key)) out.set(k2, v2);
  }
  return out;
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
}

const catalogs = { de, en, it: itCatalog, es, fr } as const;
const reference = flatten(de);

describe('i18n-Kataloge (DE/EN/IT/ES/FR)', () => {
  it.each(Object.keys(catalogs).filter((c) => c !== 'de'))('%s hat exakt dieselben Keys wie de', (code) => {
    const cat = flatten(catalogs[code as keyof typeof catalogs]);
    const missing = [...reference.keys()].filter((k) => !cat.has(k));
    const extra = [...cat.keys()].filter((k) => !reference.has(k));
    expect(missing, `fehlende Keys in ${code}`).toEqual([]);
    expect(extra, `überzählige Keys in ${code}`).toEqual([]);
  });

  it.each(Object.keys(catalogs).filter((c) => c !== 'de'))('%s hat identische Platzhalter je Key', (code) => {
    const cat = flatten(catalogs[code as keyof typeof catalogs]);
    const broken: string[] = [];
    for (const [key, value] of reference) {
      const want = placeholders(value).join(',');
      const got = placeholders(cat.get(key) ?? '').join(',');
      if (want !== got) broken.push(`${key}: de=[${want}] ${code}=[${got}]`);
    }
    expect(broken).toEqual([]);
  });

  it('keine leeren Übersetzungen', () => {
    for (const [code, cat] of Object.entries(catalogs)) {
      for (const [key, value] of flatten(cat)) {
        expect(value.length, `${code}:${key} ist leer`).toBeGreaterThan(0);
      }
    }
  });
});
