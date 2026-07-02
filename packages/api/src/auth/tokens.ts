import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { requireEnv } from '@gladiator/db';

const ISSUER = 'gladiator-v2';
export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_DAYS = 30;

export type AccessTokenPayload = { userId: string; email: string };

/** Access-JWT signieren. JWT_SECRET ist Pflicht — kein Fallback (Boot-Abbruch-Semantik). */
export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign({ email: payload.email }, requireEnv('JWT_SECRET'), {
    subject: payload.userId,
    issuer: ISSUER,
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

/** Access-JWT prüfen. Ungültig/abgelaufen/manipuliert → null (Aufrufer antwortet 401). */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, requireEnv('JWT_SECRET'), { issuer: ISSUER });
    if (typeof decoded === 'string' || !decoded.sub || typeof decoded.email !== 'string') return null;
    return { userId: decoded.sub, email: decoded.email };
  } catch {
    return null;
  }
}

/** Kryptografisch zufälliger Refresh-Token (256 Bit). Wird NIE im Klartext gespeichert. */
export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** SHA-256-Hash für die Ablage in sessions.refresh_token_hash. */
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function refreshTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
