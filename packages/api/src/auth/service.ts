import bcrypt from 'bcryptjs';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
  signAccessToken,
} from './tokens.js';

const { users, sessions, auditLog } = schema;

export class AuthError extends Error {
  constructor(
    public readonly code: 'INVALID_CREDENTIALS' | 'EMAIL_TAKEN' | 'INVALID_REFRESH',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export type PublicUser = {
  id: string;
  email: string;
  name: string | null;
  locale: string;
  createdAt: Date;
};

export type TokenPair = { accessToken: string; refreshToken: string };

type RequestMeta = { userAgent?: string | null; ip?: string | null };

function toPublicUser(u: typeof users.$inferSelect): PublicUser {
  return { id: u.id, email: u.email, name: u.name, locale: u.locale, createdAt: u.createdAt };
}

async function createSession(db: Db, userId: string, email: string, meta: RequestMeta): Promise<TokenPair> {
  const refreshToken = generateRefreshToken();
  await db.insert(sessions).values({
    userId,
    refreshTokenHash: hashRefreshToken(refreshToken),
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
    expiresAt: refreshTokenExpiry(),
  });
  return { accessToken: signAccessToken({ userId, email }), refreshToken };
}

async function audit(db: Db, action: string, userId: string | null, meta: RequestMeta, details?: unknown) {
  await db.insert(auditLog).values({
    actor: 'user',
    action,
    userId,
    entityType: 'user',
    entityId: userId,
    ip: meta.ip ?? null,
    details: details ?? null,
  });
}

export async function register(
  db: Db,
  input: { email: string; password: string; name?: string },
  meta: RequestMeta = {},
): Promise<{ user: PublicUser } & TokenPair> {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(input.password, 12);

  const inserted = await db
    .insert(users)
    .values({ email, passwordHash, name: input.name ?? null })
    .onConflictDoNothing({ target: users.email })
    .returning();
  const user = inserted[0];
  if (!user) throw new AuthError('EMAIL_TAKEN', 'E-Mail ist bereits registriert.');

  await audit(db, 'auth.register', user.id, meta);
  const tokens = await createSession(db, user.id, user.email, meta);
  return { user: toPublicUser(user), ...tokens };
}

export async function login(
  db: Db,
  input: { email: string; password: string },
  meta: RequestMeta = {},
): Promise<{ user: PublicUser } & TokenPair> {
  const email = input.email.trim().toLowerCase();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // Identische Fehlermeldung für "unbekannte E-Mail" und "falsches Passwort" (kein User-Enumeration-Leak).
  if (!user?.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) {
    throw new AuthError('INVALID_CREDENTIALS', 'E-Mail oder Passwort falsch.');
  }

  await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));
  await audit(db, 'auth.login', user.id, meta);
  const tokens = await createSession(db, user.id, user.email, meta);
  return { user: toPublicUser(user), ...tokens };
}

/**
 * Refresh mit Rotation: alter Token wird entwertet, neuer ausgegeben.
 * Reuse-Detection: Wird ein bereits entwerteter Token erneut benutzt, gelten die
 * Zugangsdaten als kompromittiert → ALLE Sessions des Users werden revoked.
 */
export async function refresh(db: Db, refreshToken: string, meta: RequestMeta = {}): Promise<TokenPair> {
  const tokenHash = hashRefreshToken(refreshToken);
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, tokenHash))
    .limit(1);

  if (!session) throw new AuthError('INVALID_REFRESH', 'Refresh-Token ungültig.');

  if (session.revokedAt !== null) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, session.userId), isNull(sessions.revokedAt)));
    await audit(db, 'auth.refresh.reuse_detected', session.userId, meta, {
      sessionId: session.id,
      note: 'Alle Sessions revoked.',
    });
    throw new AuthError('INVALID_REFRESH', 'Refresh-Token wurde bereits benutzt — alle Sessions abgemeldet.');
  }

  if (session.expiresAt <= new Date()) {
    throw new AuthError('INVALID_REFRESH', 'Refresh-Token abgelaufen.');
  }

  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user) throw new AuthError('INVALID_REFRESH', 'Nutzer existiert nicht mehr.');

  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));
  return createSession(db, user.id, user.email, meta);
}

/**
 * Auto-Login für den Einzelnutzer-Betrieb (AUTO_LOGIN_EMAIL): gibt eine ganz
 * normale Session für den konfigurierten User aus — OHNE Passwortabfrage.
 *
 * Sicherheits-Abwägung (Patrick, 2026-07-08): Die App ist ausschließlich über
 * das private Tailnet erreichbar (Bind auf 127.0.0.1 + Tailscale-IP); wer im
 * Tailnet ist, IST Patrick. Die Token-Mechanik (Rotation, Reuse-Detection,
 * Audit) bleibt vollständig aktiv — nur die Passwort-Hürde entfällt. Ohne
 * gesetzte Env bleibt der Endpoint tot (412 im Router).
 */
export async function autoLogin(db: Db, email: string, meta: RequestMeta = {}): Promise<{ user: PublicUser } & TokenPair> {
  const normalized = email.trim().toLowerCase();
  const [user] = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  if (!user) throw new AuthError('INVALID_CREDENTIALS', 'Auto-Login-User existiert nicht.');

  await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));
  await audit(db, 'auth.autologin', user.id, meta);
  const tokens = await createSession(db, user.id, user.email, meta);
  return { user: toPublicUser(user), ...tokens };
}

export async function logout(db: Db, refreshToken: string, meta: RequestMeta = {}): Promise<void> {
  const tokenHash = hashRefreshToken(refreshToken);
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.refreshTokenHash, tokenHash), isNull(sessions.revokedAt)))
    .limit(1);
  if (!session) return; // Logout ist idempotent.
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));
  await audit(db, 'auth.logout', session.userId, meta);
}

/** Aktiven User zu einer gültigen Access-Token-Identität laden (frisch aus der DB). */
export async function getUserById(db: Db, userId: string): Promise<PublicUser | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user ? toPublicUser(user) : null;
}

/** Anzahl aktiver (nicht revoked, nicht abgelaufener) Sessions eines Users. */
export async function countActiveSessions(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
  return rows.length;
}
