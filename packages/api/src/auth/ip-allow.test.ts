import { describe, expect, it } from 'vitest';
import { isAutoLoginAllowedIp, parseCidrList } from './ip-allow.js';

/** Auto-Login nur aus localhost / Tailnet (100.64.0.0/10) oder explizit freigegebenen Netzen. */
describe('isAutoLoginAllowedIp', () => {
  it('localhost (IPv4, IPv6, IPv4-mapped) ist erlaubt', () => {
    expect(isAutoLoginAllowedIp('127.0.0.1')).toBe(true);
    expect(isAutoLoginAllowedIp('::1')).toBe(true);
    expect(isAutoLoginAllowedIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('Tailscale-Adressen (100.64.0.0/10) sind erlaubt, Ränder exakt', () => {
    expect(isAutoLoginAllowedIp('100.72.94.1')).toBe(true);
    expect(isAutoLoginAllowedIp('::ffff:100.100.1.2')).toBe(true);
    expect(isAutoLoginAllowedIp('100.64.0.0')).toBe(true);
    expect(isAutoLoginAllowedIp('100.127.255.255')).toBe(true);
    expect(isAutoLoginAllowedIp('100.63.255.255')).toBe(false);
    expect(isAutoLoginAllowedIp('100.128.0.0')).toBe(false);
  });

  it('öffentliche und private Fremdnetze sind gesperrt, fehlende IP auch', () => {
    expect(isAutoLoginAllowedIp('203.0.113.5')).toBe(false);
    expect(isAutoLoginAllowedIp('192.168.1.10')).toBe(false);
    expect(isAutoLoginAllowedIp('2001:db8::1')).toBe(false);
    expect(isAutoLoginAllowedIp(null)).toBe(false);
    expect(isAutoLoginAllowedIp('kein-ip')).toBe(false);
  });

  it('zusätzliche Netze per AUTO_LOGIN_ALLOWED_CIDRS', () => {
    const extra = parseCidrList('192.168.1.0/24, 10.0.0.5/32');
    expect(isAutoLoginAllowedIp('192.168.1.10', extra)).toBe(true);
    expect(isAutoLoginAllowedIp('10.0.0.5', extra)).toBe(true);
    expect(isAutoLoginAllowedIp('10.0.0.6', extra)).toBe(false);
  });

  it('kaputte CIDR-Einträge werden ignoriert, nie „alles erlauben"', () => {
    const extra = parseCidrList('0.0.0.0/0, nonsense, 1.2.3.4/40');
    expect(extra).toEqual([]);
    expect(isAutoLoginAllowedIp('203.0.113.5', extra)).toBe(false);
  });
});
