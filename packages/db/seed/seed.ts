/**
 * Seed: portiert die ECHTEN v1-Daten (users, packages, assets, magazineArticles)
 * aus packages/db/seed/data/*.json (Export aus backend-node/gladiator_v2.db, read-only).
 * Idempotent: bereits vorhandene Zeilen (unique keys) werden übersprungen.
 * KEINE erfundenen Daten — nur der Port der v1-Realität (04_ §6).
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createDb } from '../src/client.js';
import { assets, magazineArticles, packages, users } from '../src/schema/index.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');

function loadJson<T>(name: string): T[] {
  const file = path.join(dataDir, `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`Seed-Datei fehlt: ${file}. Die v1-Exporte müssen nach seed/data/ übertragen werden (scp).`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as T[];
}

/** v1 speichert Unix-Sekunden; defensiv auch Millisekunden akzeptieren. */
function toDate(value: number | null | undefined): Date | null {
  if (value == null) return null;
  return new Date(value > 1e12 ? value : value * 1000);
}

type V1User = {
  id: number;
  email: string;
  password: string | null;
  name: string | null;
  vorname: string | null;
  nachname: string | null;
  role: 'user' | 'admin';
  createdAt: number;
  lastSignedIn: number | null;
};
type V1Package = {
  id: number;
  packageId: string;
  name: string;
  description: string | null;
  category: string;
  subcategory: string | null;
  icon: string | null;
  color: string | null;
  assetCount: number | null;
  totalSignals: number | null;
  isActive: number | boolean | null;
  createdAt: number;
};
type V1Asset = {
  id: number;
  assetId: string;
  packageId: number;
  ticker: string;
  name: string;
  exchange: string | null;
  assetType: string;
  tradingPair: string | null;
  baseCurrency: string | null;
  quoteCurrency: string | null;
  totalSignals: number | null;
  isActive: number | boolean | null;
  createdAt: number;
};
type V1Article = {
  id: number;
  title: string;
  content: string;
  summary: string | null;
  category: 'recap' | 'breaking' | 'analysis' | 'crypto' | 'forex';
  imageUrl: string | null;
  sourceUrl: string | null;
  isPublished: number | boolean | null;
  publishedAt: number | null;
  createdAt: number;
};

const { db, pool } = createDb();

try {
  const v1Users = loadJson<V1User>('users');
  const v1Packages = loadJson<V1Package>('packages');
  const v1Assets = loadJson<V1Asset>('assets');
  const v1Articles = loadJson<V1Article>('magazineArticles');

  // Users (Passwort-Hashes bleiben gültig; legacyV1Id für Nachverfolgung)
  for (const u of v1Users) {
    const displayName =
      u.name ?? [u.vorname, u.nachname].filter(Boolean).join(' ').trim() ?? null;
    // Kein role-Mapping: v2 kennt nur EINEN User-Typ (Entscheidung 2026-07-02).
    await db
      .insert(users)
      .values({
        email: u.email,
        passwordHash: u.password,
        name: displayName === '' ? null : displayName,
        createdAt: toDate(u.createdAt) ?? new Date(),
        lastSignedIn: toDate(u.lastSignedIn),
        legacyV1Id: u.id,
      })
      .onConflictDoNothing({ target: users.email });
  }

  // Packages (Original-IDs beibehalten, damit Asset-FKs stimmen)
  for (const p of v1Packages) {
    await db
      .insert(packages)
      .values({
        id: p.id,
        packageId: p.packageId,
        name: p.name,
        description: p.description,
        category: p.category,
        subcategory: p.subcategory,
        icon: p.icon,
        color: p.color,
        assetCount: p.assetCount ?? 0,
        totalSignals: p.totalSignals ?? 0,
        isActive: Boolean(p.isActive ?? true),
        createdAt: toDate(p.createdAt) ?? new Date(),
      })
      .onConflictDoNothing({ target: packages.id });
  }

  // Assets
  for (const a of v1Assets) {
    await db
      .insert(assets)
      .values({
        id: a.id,
        assetId: a.assetId,
        packageId: a.packageId,
        ticker: a.ticker,
        name: a.name,
        exchange: a.exchange,
        assetType: a.assetType,
        tradingPair: a.tradingPair,
        baseCurrency: a.baseCurrency,
        quoteCurrency: a.quoteCurrency,
        totalSignals: a.totalSignals ?? 0,
        isActive: Boolean(a.isActive ?? true),
        createdAt: toDate(a.createdAt) ?? new Date(),
      })
      .onConflictDoNothing({ target: assets.id });
  }

  // Magazin-Artikel
  for (const m of v1Articles) {
    await db
      .insert(magazineArticles)
      .values({
        id: m.id,
        title: m.title,
        content: m.content,
        summary: m.summary,
        category: m.category,
        imageUrl: m.imageUrl,
        sourceUrl: m.sourceUrl,
        isPublished: Boolean(m.isPublished ?? false),
        publishedAt: toDate(m.publishedAt),
        createdAt: toDate(m.createdAt) ?? new Date(),
      })
      .onConflictDoNothing({ target: magazineArticles.id });
  }

  // Sequenzen hinter die explizit gesetzten IDs stellen
  for (const table of ['packages', 'assets', 'magazine_articles']) {
    await db.execute(
      sql.raw(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${table}))`,
      ),
    );
  }

  const counts = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM packages) AS packages,
      (SELECT count(*) FROM assets) AS assets,
      (SELECT count(*) FROM magazine_articles) AS magazine_articles
  `);
  console.log('Seed abgeschlossen. Zeilen in DB:', counts.rows[0]);
  console.log(
    `Quelle (v1-Export): users=${v1Users.length}, packages=${v1Packages.length}, assets=${v1Assets.length}, magazineArticles=${v1Articles.length}`,
  );
} finally {
  await pool.end();
}
