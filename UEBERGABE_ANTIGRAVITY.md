# Übergabe an Antigravity + Claude Code (Stand 2026-10-27)

Diese Datei ist der Einstieg, um die Arbeit lückenlos in **Antigravity mit Claude Code** (Patricks Rechner, lokale Arbeitskopie) fortzusetzen. Reihenfolge beim Start: `CLAUDE.md` → **diese Datei** → `OFFENER_PLAN.md` (Abschnitte 0e, 0d, 0c, 1, 2) → bei Bedarf `WORKOVER.md`, `apps/web/CLAUDE.md` und die `CLAUDE.md` des Pakets, das du anfasst.

---

## 1 · Wo wir stehen

| Was | Stand |
|---|---|
| GitHub `main` | `218318c` (Merge PR #94). Alle GitHub-Prüfungen grün (`ci`, `ui-smoke`, `selfhost-docker`). |
| Server | Läuft auf `218318c` seit 2026-10-25 16:30 (Server-CI grün, `gladiator` + `gladiator-worker` neu gestartet, `/health` ok). |
| Auto-Deploy | systemd-Timer `gladiator-github-sync` auf dem Server, alle 2 min: holt GitHub `main`, pusht ins Server-Repo, post-receive-Hook → `scripts/ci.sh` → Neustart **nur bei grüner Server-CI**. Der GitHub-Workflow `deploy.yml` tut ohne Secret `DEPLOY_SSH_KEY` bewusst nichts. |
| App | `http://100.72.94.1:3010` (nur mit Tailscale). |

Zuletzt gebaut (Details in `OFFENER_PLAN.md` 0d/0e und `WORKOVER.md`):
- **PR #91** (andere Sitzung): v2-Optik „Blue Matrix“ zurück, Profi-Modus Standard.
- **PR #92**: v2-Bedienung zurück — Seitenleiste mit jeder Seite, „Traden“ öffnet das Agenten-Konto, Chart mit Ein-Klick-Schaltern, Übernahme der v2-Indikatoren aus dem Browser.
- **PR #93**: Chart-Reiter Analyse/Makro/Risiko **je Asset** (COT nur des eigenen Markts, explizite Aliase, 16 CFTC-Märkte per Echtdaten-Test belegt), Derivate je Krypto-Favorit, **Heatmap** (`#/heatmap`: Performance + Korrelation).
- **PR #94**: **Asset-Register** — jedes Binance-Paar und jedes Yahoo-Asset hinzufügen (`product.addAsset`, „+ Markt hinzufügen“), Kerzen-Refresh-Job alle 15 min, Kerzen als Upsert, Frische-Prüfung, Preis-Alarme/Demo-Kurse/News/Kalender/Live-Feed für jedes Asset. Migration `0043`.

---

## 2 · Einmalig einrichten (lokal, Windows)

1. In Antigravity den Ordner `C:\Users\Patrick\Antigravity Gladiator AI versuch 1\gladiator-v2` öffnen und im integrierten Terminal `claude` starten (Claude Code liest `CLAUDE.md` automatisch).
2. **Arbeitskopie sichern und auf GitHub-Stand bringen** — die lokale Kopie kann deutlich älter sein:
   ```bash
   git status                      # lokale Änderungen? Dann NICHT verwerfen: git stash push -m "lokal vor Übergabe" (oder eigenen Branch committen) und Patrick fragen
   git fetch origin
   git checkout main
   git pull --ff-only origin main  # muss auf 218318c (oder neuer) landen
   npm ci
   ```
3. **GitHub CLI** für Pull Requests: `gh auth status`. Fehlt sie: `winget install GitHub.cli`, dann `gh auth login` (einmal, Patrick bestätigt im Browser).
4. **SSH zum Server** (nur lesend zur Kontrolle): `ssh root@95.216.10.238 "cd /opt/gladiator-v2/app && git log -1 --oneline"` muss antworten.
5. Optional für DB-Tests lokal: Docker Desktop, dann `docker compose --env-file .env up -d` (TimescaleDB 127.0.0.1:5433, Redis 127.0.0.1:6380) und `DATABASE_URL` in der lokalen `.env`. Ohne DB werden DB-Tests übersprungen — maßgeblich sind GitHub-CI und Server-CI.

---

## 3 · Arbeitsweise (verbindlich)

1. **Eine Aufgabe = ein Branch** von aktuellem `main` (`git checkout -b feat/<kurz>`), TDD: erst Tests, dann Code.
2. **Vor jedem Push**: `npm run lint && npm run typecheck && npx vitest run <geänderte Pakete>`; bei UI-Änderungen zusätzlich `npm run build:web`.
3. **Pull Request**: `git push -u origin <branch>` → `gh pr create --fill` (Beschreibung: Warum / Was / Geprüft) → `gh pr checks --watch` → bei Grün `gh pr merge --merge`. Rot ⇒ Ursache beheben, nie Tests überspringen oder abschalten.
4. **Deploy passiert automatisch** nach dem Merge (Timer ≤ 2 min, Server-CI 10–20 min). **Nie mehr `git push server main` direkt**: hat der Server Commits, die auf GitHub fehlen, stoppt der Auto-Deploy (Schutz vor Überschreiben).
5. **Kontrolle nach dem Merge** (nur lesen):
   ```bash
   ssh root@95.216.10.238 "cd /opt/gladiator-v2/app && git log -1 --oneline; systemctl show gladiator -p ExecMainStartTimestamp; curl -s http://127.0.0.1:3010/health; journalctl -u gladiator-github-sync -n 20 --no-pager; tail -n 40 /opt/gladiator-v2/ci.log"
   ```
   Server-CI rot ⇒ Fehler aus `ci.log` lesen, **im Code** beheben, neuer PR. Auf dem Server nie etwas reparieren, nie Dienste von Hand neu starten, `.env` nicht anfassen, CHAMÆLIEN (Ports 5432/6379, eigene Container) nie anfassen, nie `--force`.
6. **Nach jeder Aufgabe**: `OFFENER_PLAN.md` abhaken (`[x]` + PR-Nummer), kurzer Eintrag in `WORKOVER.md`.

**Stolpersteine, die schon Zeit gekostet haben:**
- Echtdaten-Tests (Binance, Yahoo, CFTC, EZB, RPCs) laufen nur mit Netz — lokal meist ok, in der Cloud nicht. Nie ausklammern.
- Server-IP: KyberSwap drosselt die **IPv6**-Adresse; deshalb `dns.setDefaultResultOrder('ipv4first')` in `packages/api/src/start.ts` und `scripts/vitest-setup.ts`. Yahoo kann die Server-IP mit 429 drosseln.
- UI-Smoke (`apps/web/e2e/smoke.ts`) besucht jede Registry-Route in Einfach/Profi/Handy (390 px): kein Überlauf, kein `undefined`/`NaN`, ≥ 40 Zeichen Text.
- i18n: jeder Text als Key in **allen fünf** Dateien `apps/web/src/i18n/{de,en,it,es,fr}.ts` (`catalog.test.ts` prüft Gleichheit). Zahlen/Daten nur über `appLocale()`.
- Navigation nur über `apps/web/src/lib/navigation.ts` (+ `App.tsx`). Migrationen über drizzle (`npm run db:generate`), nächste Nummer **0044**.
- `.env`, Seed-Daten (`packages/db/seed/data/`) und Secrets nie committen.

---

## 4 · Offene Punkte — in dieser Reihenfolge

### A · Signal-Scan und KI-Pipelines je Quelle (Hauptaufgabe, in drei PRs)
Hinzugefügte Aktien/ETF/Forex/Rohstoffe erscheinen in Chart, Screener, Heatmap, Alarmen — aber der **Signal-Scan und die KI-Pipelines rechnen nur Krypto (Binance)**. Befund aus dem Register-Umbau (Zeilen vorher prüfen):

**A1 · Scan je Quelle** — ✅ erledigt (PR #96)
- `signals` hat keine Kerzenquelle → Migration 0044: `signals.venue` (Standard `binance`).
- `packages/jobs/src/signal-scan.ts` (Universum über `scanUniverse`, `getOhlcv` ohne venue, `assetClass: 'crypto'` fest), `dsl-scan.ts` (gleich) → Universum aus `registeredAssets()` (`packages/jobs/src/asset-register.ts`, liefert `{symbol, venue, assetType, name}`), Kerzen mit venue, `assetClass` aus dem Register, `persistCandidate` setzt venue (heute `venueType: 'cex'` fest).
- `SCAN_TIMEFRAMES` enthält 4h, `HIGHER_TF` braucht 4h — Yahoo liefert kein 4h, im Code gibt es keinen Aggregations-Helfer → reinen, getesteten Helfer 1h → 4h bauen (UTC-4h-Buckets; nur vollständige Buckets; Lücken außerhalb der Börsenzeiten ehrlich behandeln).
- Börsenzeiten/Wochenenden: keine Signale auf veralteten Kerzen (Frische-Helfer `packages/market-data/src/freshness.ts` nutzen).
- Erwartung: echte Signale für registrierte Nicht-Krypto-Assets, Tests mit Fixture-Kerzen, kein Fake.

**A2 · Lebenszyklus, Review, Ausführung** — ✅ erledigt (siehe OFFENER_PLAN 0e)
- `packages/jobs/src/signal-lifecycle.ts` (`getOhlcv` ohne venue; `priceOf = venue.markPrice` = Binance) und `review.ts` (`venue.marketRules(symbol)` Binance) → Preis-Resolver: Binance live, sonst frischester Kerzenschluss (wie `latestFreshClose` in den Alarmen), veraltet ⇒ nichts tun und protokollieren.
- Bestätigen eines Nicht-Krypto-Signals im Agenten-Konto (Paper): Ausführung zum letzten echten Schlusskurs, ehrlich als „Schlusskurs-Ausführung“ beschriftet (Vorbild `packages/api/src/demo/candle-book-source.ts`), **Risk-Engine bleibt hartes Gate**.
- `packages/api/src/routers/signals.ts` (~111): Favoritenfilter erkennt nur Krypto-Paare → `favoriteSymbols` mit venue nutzen.

**A3 · Pipelines und Links** — Teil 1 erledigt (ML-Beschriftung + Chart-Links je Quelle), Rest siehe OFFENER_PLAN 0e
- `ml-pipeline.ts`, `self-improve-pipeline.ts`, `rl-pipeline.ts`, `sub-agent-runner.ts` (`assetClassFor` immer `crypto`), `backtest/src/hindsight.ts`, `backtest/src/lab.ts`, `api/src/webhook/pine.ts`: Kerzen mit venue.
- Telegram-/Benachrichtigungs- und Signal-Links bauen Chart-URLs ohne `venue` → `buildChartUrl` mit venue.

### B · Kleine Oberflächen-Punkte (OFFENER_PLAN 0d)
- Handy: Einfach/Profi, Sprache, Abmelden nur unter Profil → in der Kopfzeile erreichbar machen (ohne Überlauf bei 390 px).
- Workshop-Tab unter Strategien ohne eigene Überschrift/Untertitel.
- Chart-Kopf: Knopf „Analyse“ doppelt zum Reiter Analyse → einen davon sinnvoll umwidmen (nichts entfernen, was Patrick nutzt; im Zweifel fragen).

### C · Kleinere technische Punkte
- `product.addAsset` kennt Binance + Yahoo; Twelve Data nur über Einstellungen (Prüfung bräuchte den Key) → optional ergänzen, wenn ein Key gesetzt ist.
- Auf dem Server prüfen, ob Yahoo 15m mit `range=60d` liefert (sonst greift der 1mo-Fallback) — nach dem ersten hinzugefügten Yahoo-Asset in `ohlcv` nachsehen.
- `packages/api/src/auth.test.ts` erzeugt unter Last eine „Unhandled Rejection“ (vorbestehend) → Test robust machen.
- `TEST_DATABASE_URL` in der Server-`.env` (Server-CI migriert die Live-DB dann erst nach grünen Tests) — **nur nach Patricks OK**, Werte nie ausgeben.

### D · Braucht Patrick (nicht selbstständig umsetzen)
- **Strategien nach seiner Vorstellung** (Mängelliste Punkt 10) — erst sein Bild einholen.
- **Grundsatzpunkt**: v3 „sehr weit weg vom Ziel“ — sein Zielbild einholen, dann Plan vorschlagen.
- **Live-Order-Pfad** (OFFENER_PLAN 2): erst nach ausdrücklicher Freigabe je Börse.
- Seine Handgriffe (OFFENER_PLAN 1): `ANTHROPIC_API_KEY` in der App, v1-Alt-Secrets widerrufen, Repo auf privat, optional Telegram-Bot, Börse verbinden (API-Key ohne Auszahlrecht), PineTS-Lizenz.

---

## 5 · Startprompt für Claude Code in Antigravity

Diesen Text als erste Nachricht in Claude Code (im Ordner `gladiator-v2`) einfügen:

```text
Du arbeitest an Gladiator AI im Repo PatrickKron/Gladiator-AI-19.10 (lokale Arbeitskopie auf meinem PC).
Lies zuerst CLAUDE.md, dann UEBERGABE_ANTIGRAVITY.md vollständig, dann OFFENER_PLAN.md (0e, 0d, 0c, 1, 2).

1. Richte die Arbeitskopie nach UEBERGABE_ANTIGRAVITY.md Abschnitt 2 ein. Lokale, nicht committete
   Änderungen niemals verwerfen — sichern und mir sagen, was du gefunden hast.
2. Prüfe per SSH (nur lesend), welcher Stand auf dem Server läuft (Abschnitt 3, Punkt 5), und sag es mir in einem Satz.
3. Arbeite dann die offenen Punkte aus Abschnitt 4 in der angegebenen Reihenfolge ab, beginnend mit A1.
   Je Teilaufgabe: eigener Branch, TDD, lint/typecheck/Tests grün, Pull Request mit gh, CI abwarten,
   bei Grün mergen, Deploy-Kontrolle per SSH, dann OFFENER_PLAN.md und WORKOVER.md aktualisieren.
4. Halte dich an die eisernen Regeln aus CLAUDE.md (kein Fake, Paper-Default, Risk-Engine als Gate,
   keine Auszahlungen, nichts Funktionierendes beschädigen) und an Abschnitt 3 dieser Übergabe
   (nie direkt auf den Server pushen, auf dem Server nichts reparieren, CHAMÆLIEN nie anfassen).
5. Punkte aus Abschnitt 4 D setzt du nicht selbst um — dort fragst du mich.
Melde dich nach jedem gemergten Pull Request kurz auf Deutsch: was live ist, was als Nächstes kommt.
```
