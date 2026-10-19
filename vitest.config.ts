import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // Tests legen eigene User an, obwohl die Test-DB schon User enthält — die
    // Registrierungs-Sperre (Einzelnutzer) gezielt öffnen. Die Sperre selbst
    // prüft registration-lock.test.ts, das die Variable dort wieder entfernt.
    env: { ALLOW_REGISTRATION: '1' },
  },
});
