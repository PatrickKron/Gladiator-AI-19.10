# Gladiator v2 — Design-System v3 „Ruhe & Klarheit"

> Verbindlich für alle Seiten. Freigabe Patrick (2026-10-21): „die Sachen gleich direkt umsetzen",
> Referenzen: **Starlink-App** (ruhig, dunkel, viel Raum, große Zahlen, ein Akzent) und
> **Bitpanda** (eine Hauptaktion je Bildschirm, Komplexes aufklappbar, Spaß beim Benutzen).
> Der Daten-Regen bleibt als **Special-Effekt** (§6), nicht mehr als Dauer-Hintergrund.
> Vorgänger: v2 „Blue Matrix Premium / Neon-Dual" (Juli 2026) — ersetzt mit PR #68.

## 1. Prinzipien (gelten für jede Seite)

1. **Eine Zahl pro Bildschirm** — oben steht die eine Zahl, um die es geht (Vermögen, Kurs, Equity,
   Return), groß, mit Veränderung als farbigem Chip.
2. **Eine Hauptaktion pro Bildschirm** — genau ein blauer (oder grüner) Knopf. Alles Zweite ist
   ein stiller Textlink oder eine Sekundär-Fläche (`.btn`).
3. **Komplexes aufklappen, nicht entfernen** — Hebel, Börsenvergleich, Overrides, Walk-Forward
   bleiben, aber hinter „Erweitert".
4. **Vier Farben** — Schwarzblau, Weiß, Grau, Elektro-Blau. Grün und Rot nur für Geld und
   Richtung, Bernstein für Warnung/Demo. Keine Verläufe, kein Neon-Glow.
5. **Fläche statt Glas** — flache Karten mit feiner Linie, Trennung durch Abstand. Kein
   `backdrop-filter`, keine Schatten-Stapel.
6. **Ehrlichkeit** — jede Zahl ist echt oder der Zustand heißt sichtbar „nicht verbunden".
   Auch der Regen besteht nur aus echten Ticks.
7. **Eine Schrift** — Inter für alles inkl. Zahlen (`.num` = Tabellenziffern). Mono (`.mono`)
   nur für Adressen, Hashes, Protokoll, Code.
8. **Handy zuerst** — Tableiste mit fünf Bereichen, einzeiliger Kopf, Karten in Daumen-Größe.
9. **Spaß durch Momente, nicht durch Effekte** — Kurve zeichnet sich beim Öffnen, Ergebniskarte
   nach einem Trade, Regen-Impuls bei echten Ereignissen. Kein Dauer-Geflimmer;
   `prefers-reduced-motion` wird respektiert.

## 2. Farben (`@theme` in `apps/web/src/styles.css`)

| Token | Wert | Verwendung |
|---|---|---|
| `--color-bg` | `#0b0d12` | Grundfläche (tiefes Schwarzblau) |
| `--color-bg2` | `#12151c` | Karten |
| `--color-bg3` | `#1a1e27` | Sekundär-Flächen, Schalter aus |
| `--color-line` | `rgba(255,255,255,.08)` | Linien |
| `--color-line2` | `rgba(255,255,255,.14)` | Linien aktiv/hover |
| `--color-ink` | `#f2f4f8` | Text |
| `--color-mut` | `#8a93a6` | Sekundärtext, Labels |
| `--color-blue` | `#3b82f6` | Akzent: Aktion, aktiver Zustand |
| `--color-cyan` | `#60a5fa` | helleres Akzentblau (Alias, Icons aktiv, Links) |
| `--color-violet` | `#94a3b8` | neutrales Grau-Blau (Alias für „sekundär/nicht verbunden") |
| `--color-magenta` | `#f59e0b` | Bernstein (Alias: Demo-Kennzeichen, Hinweise) |
| `--color-pos` | `#22c55e` | Gewinn / Long |
| `--color-neg` | `#ef4444` | Verlust / Short / Notfall |
| `--color-warn` | `#f59e0b` | Warnung |

Die Alias-Namen `cyan`/`violet`/`magenta` bleiben aus Kompatibilität (viele Aufrufer); neue
Stellen nutzen `blue`, `mut`, `warn`. Hartkodierte Alt-Farben wurden auf diese Werte abgebildet.

## 3. Typografie

- **Inter Variable** (selbst gehostet, kein CDN). Hero-Zahlen 40–56 px (`text-5xl`/`text-6xl`,
  `font-bold`, `tracking-tight`), Überschriften 22–28 px, Text 14–16 px, Labels 12 px.
- `.num`: Inter + `tabular-nums`. `.mono`: JetBrains Mono (Adressen, Protokoll, Code).
- `.label`: 12 px, Gewicht 500, Farbe `mut`, **keine** Versalien, keine Sperrung.
- Wortmarke `.wordmark`: Versalien, `letter-spacing .16em`, ohne Verlauf/Glow.

## 4. Flächen und Bausteine

```css
.glass   { background: var(--color-bg2); border: 1px solid var(--color-line); border-radius: .875rem }
.btn-primary { background: var(--color-blue); color: #fff; border-radius: .75rem; font-weight: 600 }
.btn     { background: var(--color-bg3); border: 1px solid var(--color-line); border-radius: .75rem }
.field   { background: var(--color-bg); border: 1px solid var(--color-line); focus: blauer Ring }
.chip    { Pille; Varianten --pos --neg --acc --warn --mut }
```

Alle eigenen Klassen liegen in `@layer components`, damit Tailwind-Utilities (`hidden`,
`lg:hidden`, `flex`) sie wie erwartet überschreiben.

## 5. Navigation (Shell)

- **Fünf Bereiche** aus der Registry (`lib/navigation.ts`, `AREAS` mit `hash` + `icon`):
  Heute · Markt · Traden · Strategie · Mehr. Desktop: Seitenleiste `.areanav`; Handy: `.tabbar`
  unten (Sicherheitsbereich eingerechnet).
- **Unterseiten als Segmente** `.subnav` über dem Inhalt (nur wenn der Bereich mehr als eine
  Seite hat). Kein Link ändert sich; `resolveRedirect()` bleibt.
- Kopfzeile einzeilig: Kennzeichen (Paper, Demo, Kill-Switch), Suche ⌘K, Benachrichtigungen,
  Feed-Status. Einfach/Profi, Session, Sprache, Abmelden nur auf dem Desktop; auf dem Handy im
  Profil (Ansicht, Sprache, Sitzung).

## 6. Special-Effekt: der Daten-Regen (`lib/effects.ts`, `components/RainLayer.tsx`)

Der Regen (Canvas, rAF, drei Parallax-Ebenen, Zeichen = echte Ticks) tritt an vier Stellen auf —
alle im Profil → Effekte schaltbar (`gladiator.effects`, Ansicht zurücksetzen löscht sie):

| Stelle | Standard | Sichtbarkeit | Auslöser |
|---|---|---|---|
| **Login** | an | 0,25 | nicht angemeldet |
| **Ereignis-Impuls** | an | Anstieg bis 0,55, Abklingen über 2,8 s | neue Benachrichtigung: Signal/Preis-Alarm blau, Notfall/Kill-Switch rot (`burstToneFor`) |
| **Bildschirmschoner** | an | 0,9 + Overlay (Uhr, Live-Kurse) | 3 min ohne Eingabe (`useIdle`), nie im verborgenen Tab, nie bei reduzierter Bewegung |
| **Matrix-Modus** | aus | 0,18 dauerhaft | Profil-Schalter oder Kürzel `g m` |

Reihenfolge der Regeln (`rainIntensity`, getestet): Bildschirmschoner > Login > Impuls >
Matrix-Modus > aus. Die Sichtbarkeit wird weich nachgeführt; bei 0 wird nicht gezeichnet
(keine Last im Normalbetrieb). Bei `prefers-reduced-motion` nur ein Standbild ≤ 0,25.
Hover auf einer Markt-Karte hebt weiterhin die Spalten des Symbols hervor.

## 7. Motion

| Moment | Rezept |
|---|---|
| Karten-Reveal | Stagger 40 ms, `translateY(8px)+opacity`, 420 ms |
| Preis-Tick | 420 ms Farbimpuls (grün/rot), kein Glow |
| Regen | siehe §6 |
| reduced-motion | Reveals sofort, Ticks ohne Animation, Regen als Standbild |

## 8. Wellen (Umsetzungsplan, je ein PR)

- [x] **A · Fundament** (PR #68): Tokens, Flächen, Typo, Shell mit fünf Bereichen + Tableiste,
      Regen als Effekt-System, Profil → Ansicht/Effekte.
- [x] **B · Heute & Vermögen** (PR #69): Hero mit Kurve aus Momentaufnahmen, drei Aktionen,
      „Heute wichtig" (Signale, Termine, Ereignisse, Vorschläge), Details aufklappbar;
      Vermögen mit Zeitfenster, Kurve, Aufteilung, Kontenliste mit nächstem Schritt.
- [x] **C · Markt** (PR #70): Chart mit kompaktem Kopf und mehr Höhe, EINE Werkzeugzeile
      (Zeitrahmen · Ansicht ▾ · Smart Money · Bibliothek · Zeichnen ▾ · Replay), ruhige
      Standardansicht (EMA, Volumen, Signale), Ansicht bleibt im Browser; Screener-Treffer
      als Karten; Marktlage mit Lagebild-Streifen (Regime-Score als Ampel).
- [x] **D · Traden & Signale** (PR #71): Kauf-Flow Betrag → Richtung → Vorschau → ein Knopf,
      alles Weitere unter „Erweitert"; Signalkarten mit Bild von Anfang an, Gründe und Risiko in
      Worten, eine Primäraktion; Ergebniskarte mit echtem Netto-Ergebnis beim Schließen.
- [ ] **E · Strategie & Mehr**: Labor-Archiv, Agenten + Werkstatt als eine Seite,
      Einstellungen als Gruppen mit Status-Chips.
- [ ] **F · Spaß & Feinschliff**: Kurven-Animation, Erfolgsmomente, Einrichtungs-Fortschritt,
      Leer-Zustände mit nächstem Schritt, Kontrast-Audit.
