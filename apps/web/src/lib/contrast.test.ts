/**
 * Kontrast-Audit (Welle F): die Tokens aus styles.css müssen WCAG AA erfüllen —
 * Text 4,5:1, große Schrift/UI-Flächen 3:1. Der Test liest die ECHTE Datei; ändert
 * jemand ein Token auf einen schwächeren Wert, fällt der Test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AA_LARGE, AA_TEXT, contrastRatio, over, parseHex } from './contrast.js';

const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');
const token = (name: string): string => {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{3,6});`));
  if (!m) throw new Error(`Token --color-${name} fehlt in styles.css`);
  return m[1]!;
};

describe('Kontrast der Design-Tokens (WCAG AA)', () => {
  it('Rechner: Schwarz/Weiß 21:1, gleiche Farbe 1:1, Hex-Kurzform', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#3b82f6', '#3b82f6')).toBe(1);
    expect(parseHex('#abc')).toEqual([0xaa, 0xbb, 0xcc]);
    expect(over('#ffffff', 0.5, '#000000')).toBe('#808080');
  });

  it('Text (ink, mut) auf allen drei Flächen ≥ 4,5:1', () => {
    for (const bg of ['bg', 'bg2', 'bg3']) {
      expect(contrastRatio(token('ink'), token(bg)), `ink/${bg}`).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrastRatio(token('mut'), token(bg)), `mut/${bg}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('farbiger Text (Links, Geld, Warnung) auf Karten ≥ 4,5:1', () => {
    for (const c of ['blue', 'cyan', 'violet', 'pos', 'neg', 'warn']) {
      expect(contrastRatio(token(c), token('bg2')), `${c}/bg2`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('Primär-Knopf: Weiß auf der vollen Blau-Fläche ≥ 4,5:1 (deshalb --color-blue-solid)', () => {
    expect(contrastRatio('#ffffff', token('blue-solid'))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(css).toMatch(/\.btn-primary \{\s*background: var\(--color-blue-solid\);/);
  });

  it('Chips: Text auf der getönten Fläche ≥ 4,5:1 (Rot wird dafür aufgehellt)', () => {
    const bg2 = token('bg2');
    expect(contrastRatio(token('pos'), over(token('pos'), 0.1, bg2)), 'chip pos').toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(token('warn'), over(token('warn'), 0.1, bg2)), 'chip warn').toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(token('cyan'), over(token('blue'), 0.12, bg2)), 'chip acc').toBeGreaterThanOrEqual(AA_TEXT);
    const chipRed = over(token('neg'), 0.8, '#ffffff'); // color-mix(neg 80%, white)
    expect(css).toContain('.chip--neg { color: color-mix(in srgb, var(--color-neg) 80%, white)');
    expect(contrastRatio(chipRed, over(token('neg'), 0.1, bg2)), 'chip neg').toBeGreaterThanOrEqual(AA_TEXT);
    // Das reine Token-Rot allein würde auf der Tönung knapp scheitern — der Grund für die Aufhellung.
    expect(contrastRatio(token('neg'), over(token('neg'), 0.1, bg2))).toBeLessThan(AA_TEXT);
  });

  it('UI-Flächen: Linien und Akzent-Flächen ≥ 3:1 gegenüber der Grundfläche', () => {
    expect(contrastRatio(token('blue'), token('bg'))).toBeGreaterThanOrEqual(AA_LARGE);
    expect(contrastRatio(token('pos'), token('bg'))).toBeGreaterThanOrEqual(AA_LARGE);
    expect(contrastRatio(token('neg'), token('bg'))).toBeGreaterThanOrEqual(AA_LARGE);
  });
});
