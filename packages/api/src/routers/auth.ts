import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, protectedProcedure, router } from '../trpc.js';
import { AuthError, autoLogin, changePassword, login, logout, refresh, register } from '../auth/service.js';
import { isAutoLoginAllowedIp, parseCidrList } from '../auth/ip-allow.js';

function mapAuthError(err: unknown): never {
  if (err instanceof AuthError) {
    switch (err.code) {
      case 'EMAIL_TAKEN':
        throw new TRPCError({ code: 'CONFLICT', message: err.message });
      case 'REGISTRATION_CLOSED':
        throw new TRPCError({ code: 'FORBIDDEN', message: err.message });
      case 'WEAK_PASSWORD':
      case 'WRONG_PASSWORD':
        // BAD_REQUEST statt UNAUTHORIZED: ein vertipptes Passwort darf die laufende Session nicht beenden
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      case 'INVALID_CREDENTIALS':
      case 'INVALID_REFRESH':
        throw new TRPCError({ code: 'UNAUTHORIZED', message: err.message });
    }
  }
  throw err;
}

const credentialsSchema = z.object({
  email: z.string().email('Ungültige E-Mail-Adresse.'),
  password: z.string().min(10, 'Passwort braucht mindestens 10 Zeichen.'),
});

export const authRouter = router({
  register: publicProcedure
    .input(credentialsSchema.extend({ name: z.string().min(1).max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await register(ctx.db, input, { userAgent: ctx.userAgent, ip: ctx.ip });
      } catch (err) {
        mapAuthError(err);
      }
    }),

  login: publicProcedure
    .input(z.object({ email: z.string().email(), password: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await login(ctx.db, input, { userAgent: ctx.userAgent, ip: ctx.ip });
      } catch (err) {
        mapAuthError(err);
      }
    }),

  /**
   * Auto-Login (Einzelnutzer im privaten Tailnet): aktiv NUR wenn
   * AUTO_LOGIN_EMAIL gesetzt ist — sonst 412 und das normale Formular gilt.
   * Nur von localhost/Tailnet (100.64.0.0/10) bzw. AUTO_LOGIN_ALLOWED_CIDRS — sonst 403.
   */
  autoLogin: publicProcedure.mutation(async ({ ctx }) => {
    const email = process.env.AUTO_LOGIN_EMAIL?.trim();
    if (!email) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Auto-Login ist nicht konfiguriert (AUTO_LOGIN_EMAIL).' });
    }
    // Ohne Passwort nur aus localhost/Tailnet (oder explizit freigegebenen Netzen).
    if (!isAutoLoginAllowedIp(ctx.ip, parseCidrList(process.env.AUTO_LOGIN_ALLOWED_CIDRS))) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Auto-Login nur aus dem privaten Netz — bitte mit Passwort anmelden.' });
    }
    try {
      return await autoLogin(ctx.db, email, { userAgent: ctx.userAgent, ip: ctx.ip });
    } catch (err) {
      mapAuthError(err);
    }
  }),

  refresh: publicProcedure
    .input(z.object({ refreshToken: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await refresh(ctx.db, input.refreshToken, { userAgent: ctx.userAgent, ip: ctx.ip });
      } catch (err) {
        mapAuthError(err);
      }
    }),

  logout: publicProcedure
    .input(z.object({ refreshToken: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await logout(ctx.db, input.refreshToken, { userAgent: ctx.userAgent, ip: ctx.ip });
      return { ok: true };
    }),

  /** Profil des angemeldeten Users — 401 ohne gültiges Token. */
  me: protectedProcedure.query(({ ctx }) => ctx.user),

  /** Passwort ändern (aktuelles Passwort Pflicht); entwertet alle Sessions, liefert eine neue. */
  changePassword: protectedProcedure
    .input(z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await changePassword(ctx.db, ctx.user.id, input, { userAgent: ctx.userAgent, ip: ctx.ip });
      } catch (err) {
        mapAuthError(err);
      }
    }),
});
