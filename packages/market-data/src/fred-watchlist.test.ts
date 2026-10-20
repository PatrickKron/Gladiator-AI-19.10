/**
 * Daten-Assistent (FRED-Watchlist): eigene offizielle Fed-Serien hinzufügen.
 * Pure Teile lokal; DB-Roundtrip nur mit DATABASE_URL. Der FRED-Abruf ist
 * injiziert (Test-Double) — echte Netz-Calls gehören nicht in die CI.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@gladiator/db';
import type pg from 'pg';
import {
  FRED_CATALOG,
  addFredWatch,
  listFredWatch,
  normalizeFredId,
  readFredWatchSeries,
  removeFredWatch,
  suggestFredSeries,
  syncFredWatch,
  type FredFetcher,
} from './fred-watchlist.js';

describe('normalizeFredId', () => {
  it('Großschreibung, trimmt; nur gültige FRED-IDs', () => {
    expect(normalizeFredId(' m2sl ')).toBe('M2SL');
    expect(normalizeFredId('BAMLH0A0HYM2')).toBe('BAMLH0A0HYM2');
    expect(normalizeFredId('T10Y2Y')).toBe('T10Y2Y');
    expect(normalizeFredId('')).toBeNull();
    expect(normalizeFredId('M2SL; DROP')).toBeNull();
    expect(normalizeFredId('A'.repeat(31))).toBeNull();
  });
});

describe('suggestFredSeries (Assistent: Klartext → offizielle Serien)', () => {
  it('findet Serien über deutsche und englische Begriffe', () => {
    expect(suggestFredSeries('geldmenge').map((s) => s.id)).toContain('M2SL');
    expect(suggestFredSeries('Fed Bilanz').map((s) => s.id)).toContain('WALCL');
    expect(suggestFredSeries('zinskurve inversion').map((s) => s.id)).toContain('T10Y2Y');
    expect(suggestFredSeries('unemployment').map((s) => s.id)).toContain('UNRATE');
  });

  it('direkte ID-Eingabe trifft den Katalog-Eintrag zuerst', () => {
    expect(suggestFredSeries('walcl')[0]?.id).toBe('WALCL');
  });

  it('Katalog-IDs sind eindeutig und gültig', () => {
    const ids = FRED_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(normalizeFredId(id)).toBe(id);
  });

  it('leere Anfrage → kein Rauschen', () => {
    expect(suggestFredSeries('  ')).toEqual([]);
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('FRED-Watchlist DB-Roundtrip', () => {
  let db: Db;
  let pool: pg.Pool;
  const ID = `ZZTEST${process.pid}`;

  const fetcher: FredFetcher = async (id) => {
    if (id !== ID) return [];
    return [
      { ts: new Date('2026-01-01T00:00:00Z'), value: 100 },
      { ts: new Date('2026-02-01T00:00:00Z'), value: 101.5 },
    ];
  };

  beforeAll(() => {
    ({ db, pool } = createDb());
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM macro_series WHERE source = 'fred-user' AND series_id = ${ID}`);
    await pool.end();
  });

  it('hinzufügen prüft gegen die Quelle und speichert die echten Punkte', async () => {
    const res = await addFredWatch(db, ID.toLowerCase(), fetcher);
    expect(res).toMatchObject({ seriesId: ID, points: 2, latest: 101.5 });
    const list = await listFredWatch(db);
    const mine = list.find((w) => w.seriesId === ID);
    expect(mine).toMatchObject({ points: 2, latest: 101.5 });
    expect(mine?.latestTs.toISOString().slice(0, 10)).toBe('2026-02-01');
  });

  it('unbekannte Serie (keine Daten) wird NICHT gespeichert', async () => {
    await expect(addFredWatch(db, 'GIBTESNICHT1', fetcher)).rejects.toThrow(/keine Daten/);
    expect((await listFredWatch(db)).some((w) => w.seriesId === 'GIBTESNICHT1')).toBe(false);
  });

  it('ungültige ID wird abgelehnt', async () => {
    await expect(addFredWatch(db, 'x y', fetcher)).rejects.toThrow(/Ungültige/);
  });

  it('sync aktualisiert neue Werte; Fehler pro Serie werden ehrlich gemeldet', async () => {
    const newer: FredFetcher = async (id) =>
      id === ID ? [{ ts: new Date('2026-03-01T00:00:00Z'), value: 103 }] : Promise.reject(new Error('HTTP 500'));
    const res = await syncFredWatch(db, newer);
    expect(res.synced).toContain(ID);
    const series = await readFredWatchSeries(db, ID, 10);
    expect(series.map((p) => p.value)).toEqual([100, 101.5, 103]);
  });

  it('entfernen löscht die Serie', async () => {
    await removeFredWatch(db, ID);
    expect((await listFredWatch(db)).some((w) => w.seriesId === ID)).toBe(false);
  });
});
