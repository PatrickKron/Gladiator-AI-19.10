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
    public readonly code: 'INVALID_CREDENTIALS' | 'EMAIL_TAKEN' | 'INVALID_REFRESH' | 'REGISTRATION_CLOSED' | 'WEAK_PASSWORD' | 'WRONG_PASSWORD',
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

export const REGISTRATION_CLOSED_MESSAGE = 'Registrierung geschlossen — Gladiator ist ein Einzelnutzer-System.';

/**
 * Registrierungs-Sperre (Einzelnutzer-System): Sobald EIN User existiert, ist
 * `register` zu — sonst könnte sich jeder, der die öffentliche Route erreicht,
 * einen Vollzugriffs-Account anlegen (es gibt bewusst keine Rollen).
 * Ausnahme nur explizit per Env `ALLOW_REGISTRATION=1` (Tests, Notfall).
 */
export async function registrationOpen(db: Db): Promise<boolean> {
  if (process.env.ALLOW_REGISTRATION === '1') return true;
  const [row] = await db.select({ id: users.id }).from(users).limit(1);
  return !row;
}

export async function register(
  db: Db,
  input: { email: string; password: string; name?: string },
  meta: RequestMeta = {},
): Promise<{ user: PublicUser } & TokenPair> {
  if (!(await registrationOpen(db))) {
    await audit(db, 'auth.register.rejected', null, meta, { reason: 'registration_closed' });
    throw new AuthError('REGISTRATION_CLOSED', REGISTRATION_CLOSED_MESSAGE);
  }
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

export const MIN_PASSWORD_LENGTH = 10;

function assertPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError('WEAK_PASSWORD', `Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`);
  }
}

/**
 * Passwort ändern (Profil): das aktuelle Passwort ist Pflicht (ein offener
 * Browser allein reicht nicht). Danach werden ALLE Sessions entwertet und eine
 * frische für dieses Gerät ausgegeben — andere Geräte müssen sich neu anmelden.
 */
export async function changePassword(
  db: Db,
  userId: string,
  input: { currentPassword: string; newPassword: string },
  meta: RequestMeta = {},
): Promise<TokenPair> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AuthError('INVALID_CREDENTIALS', 'Nutzer existiert nicht mehr.');
  if (!user.passwordHash || !(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
    await audit(db, 'auth.password_change.rejected', user.id, meta);
    throw new AuthError('WRONG_PASSWORD', 'Aktuelles Passwort stimmt nicht.');
  }
  assertPasswordStrength(input.newPassword);
  if (input.newPassword === input.currentPassword) {
    throw new AuthError('WEAK_PASSWORD', 'Das neue Passwort muss sich vom alten unterscheiden.');
  }
  await setHashAndRevoke(db, user.id, input.newPassword);
  await audit(db, 'auth.password_changed', user.id, meta);
  return createSession(db, user.id, user.email, meta);
}

/**
 * Passwort neu setzen ohne das alte — NUR für das Server-Skript
 * (`npm run auth:set-password`, Shell-Zugang = Besitzer). Entwertet alle Sessions.
 */
export async function setPasswordByEmail(db: Db, email: string, newPassword: string): Promise<void> {
  assertPasswordStrength(newPassword);
  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  if (!user) throw new Error(`Nutzer ${email} nicht gefunden.`);
  await setHashAndRevoke(db, user.id, newPassword);
  await db.insert(auditLog).values({
    actor: 'system',
    action: 'auth.password_reset',
    userId: user.id,
    entityType: 'user',
    entityId: user.id,
    details: { via: 'server-script' },
  });
}

async function setHashAndRevoke(db: Db, userId: string, newPassword: string): Promise<void> {
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
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
