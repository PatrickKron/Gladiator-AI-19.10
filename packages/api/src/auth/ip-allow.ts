/**
 * Netz-Freigabe für das Auto-Login (Einzelnutzer im Tailnet): ohne Passwort
 * darf sich nur anmelden, wer von localhost (z. B. `tailscale serve`) oder
 * direkt aus dem Tailnet (100.64.0.0/10) kommt. Zusätzliche Netze nur explizit
 * per AUTO_LOGIN_ALLOWED_CIDRS; ein „alles"-Netz (/0) wird nie akzeptiert.
 */

type Cidr = { base: number; mask: number };

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function toCidr(base: string, bits: number): Cidr | null {
  const n = ipv4ToInt(base);
  if (n === null || !Number.isInteger(bits) || bits < 1 || bits > 32) return null;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return { base: (n & mask) >>> 0, mask };
}

const DEFAULT_ALLOWED: Cidr[] = [toCidr('127.0.0.0', 8)!, toCidr('100.64.0.0', 10)!];

/** 'a.b.c.d/n, …' → gültige Netze; ungültige und /0 werden verworfen. */
export function parseCidrList(raw: string | undefined): Cidr[] {
  if (!raw) return [];
  const out: Cidr[] = [];
  for (const entry of raw.split(',')) {
    const [base, bits] = entry.trim().split('/');
    if (!base || bits === undefined) continue;
    const c = toCidr(base, Number(bits));
    if (c) out.push(c);
  }
  return out;
}

export function isAutoLoginAllowedIp(ip: string | null, extra: Cidr[] = []): boolean {
  if (!ip) return false;
  const raw = ip.trim();
  if (raw === '::1') return true;
  const v4 = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  const n = ipv4ToInt(v4);
  if (n === null) return false; // übriges IPv6: nicht freigegeben
  return [...DEFAULT_ALLOWED, ...extra].some((c) => ((n & c.mask) >>> 0) === c.base);
}
