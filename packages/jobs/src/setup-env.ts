/**
 * Selbsthosten (Vision-Punkt 4): `.env` aus `.env.example` erzeugen. Alle
 * Pflicht-Geheimnisse bekommen kryptografisch zufällige Werte, Web-Push frische
 * VAPID-Schlüssel. Optionale Fremd-Zugänge (Anthropic, Börsen, Telegram …)
 * bleiben auskommentiert — die trägt nur der Betreiber ein, nie erfunden.
 * Rein (Zufall injiziert) und getestet; das Skript schreibt nie über eine vorhandene .env.
 */

export type SecretGen = {
  hex: (bytes: number) => string;
  password: () => string;
  vapid: () => { publicKey: string; privateKey: string };
};

export function fillEnvFromExample(example: string, gen: SecretGen): string {
  const pg = gen.password();
  const vapid = gen.vapid();
  const set: Record<string, string> = {
    POSTGRES_PASSWORD: pg,
    JWT_SECRET: gen.hex(32),
    ENCRYPTION_KEY: gen.hex(32),
  };
  return example
    .split('\n')
    .map((line) => {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) {
        const [, key, value] = m as unknown as [string, string, string];
        if (key in set) return `${key}=${set[key]}`;
        if (key === 'DATABASE_URL') return `${key}=${value.replace('CHANGE_ME', encodeURIComponent(pg))}`;
        return line;
      }
      if (/^#\s*VAPID_PUBLIC_KEY=/.test(line)) return `VAPID_PUBLIC_KEY=${vapid.publicKey}`;
      if (/^#\s*VAPID_PRIVATE_KEY=/.test(line)) return `VAPID_PRIVATE_KEY=${vapid.privateKey}`;
      return line;
    })
    .join('\n');
}
