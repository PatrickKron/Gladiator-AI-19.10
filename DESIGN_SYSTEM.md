# Gladiator v2 — Design-System „Blue Matrix Premium"

> Verbindlich für alle Seiten (auch Phase 6). Richtung von Patrick (2026-07-02): dunkles, edles
> Sci-Fi-Command-Center in Blau; Signatur-Effekt = Digital Rain aus **echten** Live-Marktdaten.
> Kalibriert an: Awwwards-Dark-Fintech-Referenzen, Arwes (Sci-Fi-UI), Linear/Vercel-Reduktion,
> Hyperliquid-Terminal (Informationsdichte + Ruhe), Dark-Glassmorphism-Techniken (12–16px Blur,
> Licht-Kante, Ambient-Orbs), Matrix-Rain-Canvas-Pattern (1D-Drop-Array, Alpha-Trail).

## 1. Prinzipien

1. **Ein Signatur-Effekt** — der Daten-Rain. Alles andere ist Zurückhaltung: viel Dunkelraum,
   Licht nur wo Bedeutung ist.
2. **Ehrlichkeit** — jede angezeigte Zahl ist echt oder der Zustand heißt sichtbar „nicht verbunden".
   Auch der Rain besteht aus echten Ticks (Preise, %-Änderungen, Symbole), nie aus Zufallswerten.
3. **Lesbarkeit vor Effekt** — Content-Kontrast AA; Rain-Opacity ≤ 0.25; Rain konkurriert nie mit Text.
4. **Eine Lichtquelle** — zentraler blauer Glow; Karten sind Glas mit blauer Licht-Kante,
   keine harten Schatten-Stapel.
5. **Motion mit Absicht** — Stagger beim Laden, Micro-Glow bei Ticks, federnde Hovers.
   Nichts loopt sinnlos. `prefers-reduced-motion` wird respektiert (Rain statisch/aus, Reveals sofort).

## 2. Farben (CSS-Variablen in `apps/web/src/styles.css`)

| Token | Wert | Verwendung |
|---|---|---|
| `--color-bg` | `#050810` | Grundfläche (blaugetöntes Fast-Schwarz, nie reines Schwarz) |
| `--color-bg2` | `#070d18` | Vertiefungen, Tabellen-Zebra |
| `--color-glass` | `rgba(255,255,255,0.04)` | Glas-Karten-Fläche |
| `--color-line` | `rgba(79,209,255,0.14)` | Licht-Kante (Border) der Glas-Karten |
| `--color-ink` | `#eaf2ff` | Primärtext |
| `--color-mut` | `#7d8cab` | Sekundärtext, Labels |
| `--color-blue` | `#2e7cf6` | Primär-Blau (Aktionen, Marken-Glow) |
| `--color-cyan` | `#4fd1ff` | Glow-Spitzen, Rain-Köpfe, Fokus |
| `--color-pos` | `#3ddc97` | Long/positiv |
| `--color-neg` | `#ff5c6c` | Short/negativ |
| `--color-warn` | `#e8b84b` | Warnung, ROHBAU-Badge |

Rain-Verlauf: Kopf `#eaf6ff` (fast weiß-blau, Glow), Schweif `#4fd1ff → #2e7cf6 → transparent`.

## 3. Typografie

- **UI:** Inter Variable (`@fontsource-variable/inter`, selbst gehostet — kein CDN).
- **Zahlen/Daten:** JetBrains Mono (`@fontsource/jetbrains-mono`) mit **`font-variant-numeric: tabular-nums`**
  — Preise springen beim Ticken nicht.
- **Hierarchie:** große, selbstbewusste Zahlen (28–36px Mono) > mittlere Controls > kleine gedämpfte Helper.
- **Labels:** Versalien, 10.5–11.5px, `letter-spacing: 0.18em`, Farbe `--color-mut`.
- **Wortmarke:** „GLADIATOR" in Versalien, `letter-spacing: 0.3em`, dezenter Cyan-Glow.

## 4. Flächen & Tiefe (Glas)

```css
.glass {
  background: var(--color-glass);
  backdrop-filter: blur(14px);
  border: 1px solid var(--color-line);       /* Licht-Kante */
  border-radius: 1rem;
  box-shadow: 0 8px 32px rgba(0,0,0,0.38),   /* Tiefe */
              inset 0 1px 0 rgba(255,255,255,0.05); /* obere Kante fängt Licht */
}
```

- Hover: Border-Glow verstärken (`box-shadow: 0 0 24px rgba(46,124,246,0.18)`), 2px Lift.
- Ambient: 1–2 große radiale Blau-Orbs fix hinter dem Content (kein Noise, weiche Verläufe).
- Fallback ohne `backdrop-filter`: `background: rgba(7,13,24,0.92)`.

## 5. Motion

| Moment | Rezept |
|---|---|
| Seiten-/Karten-Reveal | Stagger 50 ms/Karte, `translateY(12px)+opacity`, 500 ms, `cubic-bezier(0.22,1,0.36,1)` |
| Preis-Tick | 400 ms Micro-Glow (text-shadow-Puls) in pos/neg-Farbe, danach zurück |
| Hover/Press | federnd: `cubic-bezier(0.34,1.56,0.64,1)`, 200–250 ms |
| Login-Erfolg | „Dekryptierung": Überschrift scrambelt 500 ms zu „ZUGRIFF GEWÄHRT", dann Übergang |
| reduced-motion | alle Reveals sofort, Rain eingefroren (statisches, sehr dunkles Standbild) |

## 6. Signatur: Daten-Rain (`apps/web/src/components/MatrixRain.tsx`)

- **Ein** Fullscreen-`<canvas>` (fixed, `z-index:0`, `pointer-events:none`), Content ab `z-index:1`.
- `requestAnimationFrame`; Trail durch `fillRect` mit `rgba(5,8,16,0.08)` pro Frame.
- **Zeichenquelle = echte SSE-Ticks:** je Tick werden Tokens eingespeist — Symbol („BTC"),
  Preisziffern („61651.99"), Änderung („+2.97%"). Vor dem ersten Tick fallen nur Markenzeichen
  (GLADIATOR/BTC/ETH/SOL-Glyphen) — nie erfundene Zahlen.
- **3 Parallax-Ebenen:** Spalten bekommen Tiefe (Font 11/14/17px; Geschwindigkeit & Helligkeit
  skalieren mit Tiefe — nah = schneller/heller).
- Kopfzeichen fast weiß-blau mit `shadowBlur`-Glow, Schweif läuft dunkler aus.
- Spalten sind Symbolen zugeordnet: grüner/roter Tick → kurzes farbiges Aufblitzen der Spalte;
  **Hover auf Preis-Karte → Spalten dieses Symbols leuchten auf.**
- Canvas-Element-Opacity **0.22** (≤ 0.25 Pflicht). DPR-Cap 1.5. Tab unsichtbar → rAF pausiert automatisch.

## 7. Komponenten-Rezepte

- **Preis-Karte:** Label (Versalien) + große Mono-Zahl (tabular-nums) + 24h-Änderung (pos/neg)
  + Sparkline (Cyan-Verlauf, weicher Glow, Flächen-Fade nach unten).
- **Status-Pille:** Punkt + Text; verbunden = pos, getrennt = neg, wartend = warn. Immer ehrlich.
- **Tabellen:** Mono für Zahlen, rechtsbündig; Zeilentrenner `--color-line` in 50 % Opacity.
- **Buttons:** Primär = Blau-Fläche mit äußerem Glow bei Hover; Sekundär = Glas mit Licht-Kante.
- **Leerzustände:** gedämpft, klar benannt („nicht verbunden", „noch keine Daten"), nie dekoriert kaschiert.

## 8. Nicht verhandelbar

- Rain-Opacity ≤ 0.25; Text-Kontrast AA auf `--color-bg`.
- Keine Fake-Daten, auch nicht „nur fürs Design".
- Ein Canvas, ein rAF-Loop; keine Dauer-Animation ohne Datenbezug.
- Selbst gehostete Fonts (kein CDN/Tracking).
