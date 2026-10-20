import { describe, expect, it } from 'vitest';
import { fillEnvFromExample } from './setup-env.js';

const EXAMPLE = `# Kopf
POSTGRES_PASSWORD=CHANGE_ME
DATABASE_URL=postgres://gladiator:CHANGE_ME@127.0.0.1:5433/gladiator
JWT_SECRET=CHANGE_ME_64_HEX
ENCRYPTION_KEY=CHANGE_ME_64_HEX
# VAPID_PUBLIC_KEY=...
# VAPID_PRIVATE_KEY=...
# ANTHROPIC_API_KEY=sk-ant-...
`;

let n = 0;
const gen = { hex: (bytes: number) => String(++n).padStart(bytes * 2, 'a'), password: () => `pw${++n}`, vapid: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }) };

describe('fillEnvFromExample (Selbsthosten: npm run setup:env)', () => {
  it('füllt alle Pflicht-Geheimnisse mit Zufallswerten, DB-Passwort auch in der DATABASE_URL', () => {
    const env = fillEnvFromExample(EXAMPLE, gen);
    const pw = /POSTGRES_PASSWORD=(.+)/.exec(env)![1]!;
    expect(pw).not.toBe('CHANGE_ME');
    expect(env).toContain(`DATABASE_URL=postgres://gladiator:${pw}@127.0.0.1:5433/gladiator`);
    expect(/JWT_SECRET=([0-9a-f]{64})\n/.test(env)).toBe(true);
    expect(/ENCRYPTION_KEY=([0-9a-f]{64})\n/.test(env)).toBe(true);
    expect(env).not.toContain('CHANGE_ME');
  });

  it('aktiviert Web-Push mit frischen VAPID-Schlüsseln', () => {
    const env = fillEnvFromExample(EXAMPLE, gen);
    expect(env).toContain('VAPID_PUBLIC_KEY=PUB');
    expect(env).toContain('VAPID_PRIVATE_KEY=PRIV');
  });

  it('optionale Fremd-Schlüssel bleiben auskommentiert (nie erfunden)', () => {
    const env = fillEnvFromExample(EXAMPLE, gen);
    expect(env).toContain('# ANTHROPIC_API_KEY=sk-ant-...');
  });

  it('JWT- und Vault-Schlüssel sind verschieden', () => {
    const env = fillEnvFromExample(EXAMPLE, gen);
    expect(/JWT_SECRET=(\S+)/.exec(env)![1]).not.toBe(/ENCRYPTION_KEY=(\S+)/.exec(env)![1]);
  });
});
