import { describe, expect, it } from 'vitest';
import { urlBase64ToUint8Array } from './push.js';

describe('urlBase64ToUint8Array (VAPID-Schlüssel fürs Push-Abo)', () => {
  it('dekodiert URL-sicheres Base64 ohne Padding', () => {
    // "hi?" → Base64 "aGk/" → URL-sicher "aGk_"
    expect(Array.from(urlBase64ToUint8Array('aGk_'))).toEqual([104, 105, 63]);
  });

  it('ergänzt fehlendes Padding', () => {
    // "hi" → "aGk=" → ohne Padding "aGk"
    expect(Array.from(urlBase64ToUint8Array('aGk'))).toEqual([104, 105]);
  });

  it('ein echter VAPID-Public-Key ergibt 65 Bytes (unkomprimierter P-256-Punkt)', () => {
    const key = 'BG5sdeAGBX1H4kURa1IsPnpmlvfAkCKKtkYcOtRIWX6qzbPe-h38w3ZXHVWeIl5bnVcCNw90C5slLfRJBhZBMdE';
    const bytes = urlBase64ToUint8Array(key);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
  });
});
