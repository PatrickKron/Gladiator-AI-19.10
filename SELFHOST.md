# Gladiator selbst hosten

Gladiator läuft komplett auf deinem eigenen Rechner oder Server. Echte Marktdaten kommen von öffentlichen Börsen-Schnittstellen, gehandelt wird standardmäßig im Paper-Modus (echte Kurse, simulierte Ausführung). Echtes Geld bewegt Gladiator erst nach deiner ausdrücklichen Freigabe pro Börse.

## Voraussetzungen

- Linux-Server oder -Rechner mit Docker (inkl. `docker compose`)
- Node.js ≥ 22 und npm
- Internetzugang zu den Börsen-APIs (Binance wird bei Standortsperre automatisch über den offiziellen Marktdaten-Spiegel `data-api.binance.vision` erreicht)

## Installation

```bash
git clone https://github.com/PatrickKron/Gladiator-AI-19.10.git gladiator
cd gladiator
npm ci

# 1. .env mit zufälligen Geheimnissen + Web-Push-Schlüsseln anlegen (überschreibt nie eine vorhandene)
npm run setup:env

# 2. Datenbank (TimescaleDB, Port 5433) und Redis (Port 6380) starten
docker compose --env-file .env up -d

# 3. Tabellen anlegen
npm run db:migrate

# 4. Echte Startdaten: Kern-Strategie + Kerzen der Basis-Symbole (dauert ein paar Minuten)
npm run setup:data

# 5. Oberfläche bauen und starten (API + Worker in einem Prozess)
npm run build:web
npx tsx packages/api/src/start.ts
```

Danach auf dem Server im Browser `http://127.0.0.1:3010` öffnen. Die API lauscht bewusst nur lokal. Für den Zugriff von anderen Geräten gibt es zwei Wege:
- **Empfohlen:** Tailscale (privat, verschlüsselt, ohne offenen Port), siehe `deploy/MOBILE.md`.
- `API_HOSTS=127.0.0.1,<Tailscale-IP>` in der `.env`. Die API nie ungeschützt ins offene Internet stellen.

Der erste Benutzer, der sich registriert, wird Besitzer der Instanz. Weitere Registrierungen sind danach gesperrt.

## Alternative: alles als Container

Wer Node nicht auf dem Server installieren will, braucht nur Docker. Die `.env` wird einmalig erzeugt (dafür einmal Node, z. B. auf dem eigenen Rechner, oder die `.env.example` von Hand ausfüllen):

```bash
npm ci && npm run setup:env          # .env mit zufälligen Geheimnissen
docker compose --env-file .env --profile app up -d --build
docker compose --env-file .env --profile app run --rm app setup-data   # echte Startdaten (einmalig)
```

Der App-Container legt beim Start die Tabellen an, liefert Oberfläche + API auf `http://127.0.0.1:3010` aus und läuft als normaler Benutzer (nicht root). Er läuft im Host-Netz und nutzt dieselbe `.env` unverändert (Datenbank 127.0.0.1:5433, Redis 6380, Oberfläche nur lokal) — Auto-Login aus dem Tailnet und alles andere verhalten sich wie ohne Container. Docker auf Linux vorausgesetzt (Host-Netz; Docker Desktop auf Windows/macOS unterstützt das nur eingeschränkt — dort den Weg ohne Container nehmen). Passwort zurücksetzen: `docker compose --env-file .env --profile app run --rm app set-password <email>`. Ohne `--profile app` startet Compose wie bisher nur Datenbank und Redis. Die CI startet genau diesen Container bei jedem Push und prüft `/health`.

## Dauerbetrieb (systemd)

Für den Dauerbetrieb Webserver und Worker getrennt laufen lassen, damit rechenintensive Jobs die Oberfläche nicht ausbremsen. Vorlage und Schritte stehen in `deploy/gladiator-worker.service` (Webserver mit `ROLE=web`, Worker mit `ROLE=worker`).

## Auf dem Handy

- Gladiator als App auf den Startbildschirm legen und sicher über Tailscale erreichen: `deploy/MOBILE.md`.
- Push-Benachrichtigungen: in der App oben auf die Glocke → „Push auf diesem Gerät aktivieren“. Die Schlüssel dafür hat `setup:env` schon gesetzt (sonst: `npm run push:keys`). Auf dem iPhone muss Gladiator dafür vorher zum Home-Bildschirm hinzugefügt sein. Browser erlauben Push nur über **HTTPS** (oder auf dem Server selbst über localhost). `tailscale serve` aus `deploy/MOBILE.md` liefert dieses HTTPS automatisch, eine reine `http://100.x…`-Adresse reicht nicht.

## Optionale Zugänge (in die `.env`)

| Variable | Wofür |
|---|---|
| `ANTHROPIC_API_KEY` | KI-Funktionen: Strategie-Workshop, Pine-Analyse, Signal-Erklärungen, Makro-/Shadow-Agent |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Benachrichtigungen zusätzlich per Telegram |
| `FRED_API_KEY` | weitere Makro-Datenreihen |
| `HEALTHCHECKS_URL` | externer Ausfall-Alarm (Dead-Man-Switch) |
| `MEV_PROTECT=0` | Live-Swaps auf Ethereum NICHT privat über Flashbots Protect senden (Standard: privat, Schutz vor Sandwich-Angriffen); eigener Endpunkt: `MEV_PROTECT_RPC_ETHEREUM` |
| `WALLET_KEYS_ENABLED=1` | eigene Trading-Wallets mit Schlüssel für Spot-Swaps erlauben (nur beim Selbsthosten; Schlüssel verschlüsselt, keine Überweisungen/Abhebungen) |
| `RPC_URL_SOLANA`, `RPC_URL_ETHEREUM`, `RPC_URL_BASE`, `RPC_URL_ARBITRUM`, `RPC_URL_BSC` | eigene RPC-Endpunkte statt der öffentlichen |
| `RPC_URL_LOGS_ETHEREUM`, `RPC_URL_LOGS_BASE`, `RPC_URL_LOGS_ARBITRUM`, `RPC_URL_LOGS_BSC` | eigener Knoten für „Wallets beobachten“ auf EVM (braucht `eth_getLogs` ohne Vertragsadresse); ohne Angabe probiert Gladiator eine Liste öffentlicher Knoten |

Börsen- und Wallet-Zugänge trägst du nicht in die `.env` ein, sondern in der App unter Einstellungen › Börsen. Sie werden dort verschlüsselt gespeichert. Gladiator nimmt nie Abhebe-Rechte an.

## Wallet-Trading (Spot-Swaps)

Unter Handel & Vermögen › Wallet-Trading: Token-Adresse einfügen → Preis, Liquidität, Marktkapitalisierung (DexScreener) → Schnellkauf/-verkauf → echte Route über Jupiter (Solana) bzw. KyberSwap (Ethereum, Base, Arbitrum, BSC). Jeder Swap läuft durch das Swap-Gate mit den Grenzen der Wallet (Betrag, Slippage, Preis-Einfluss, Mindest-Liquidität — Profile von Vorsichtig bis Meme-Coins, frei änderbar). Paper-Wallets handeln virtuell zum echten Angebot inkl. Gebühren. Vor jedem Kauf prüft Gladiator den Token (Solana: Mint-/Freeze-Recht und Token-2022-Risiken direkt von der Kette; EVM: Honeypot und Steuern über GoPlus). Unter „Limit-Orders & Auto-Sell“ legst du Take-Profit, Stop-Loss, Trailing-Stop oder Limit-Kauf an; der Worker prüft jede Minute.

**Eigene Trading-Wallet (echte Swaps)** — nur wenn du als Betreiber `WALLET_KEYS_ENABLED=1` in die `.env` setzt:
1. Wallet-Trading › „Eigene Wallet (live)“ → **Neue Wallet erzeugen** (empfohlen) oder eine eigens fürs Trading angelegte Wallet importieren. Nie die Haupt-Wallet.
2. Den angezeigten Schlüssel **sofort sichern** — er erscheint nur einmal. Mit ihm öffnest du die Wallet jederzeit in Phantom/MetaMask und holst Guthaben selbst heraus; Gladiator kann nie überweisen.
3. Etwas SOL/ETH/BNB an die Adresse senden (Käufe + Netzwerkgebühren).
4. „FREIGEBEN“ eintippen → Live freigegeben. Jeder Swap wird danach noch einzeln bestätigt.

Der Schlüssel liegt nur verschlüsselt in der Datenbank (AES-256-GCM mit `ENCRYPTION_KEY`). Gebaut werden ausschließlich Aggregator-Swaps mit der eigenen Adresse als Empfänger (Solana: Jupiter, eigene Wallet muss alleiniger Gebührenzahler sein; EVM: nur der offizielle KyberSwap-Router, `approve` exakt in Verkaufshöhe). Vor dem Signieren prüft Gladiator jede vom Aggregator gelieferte Transaktion selbst: Solana-Anweisungen gegen eine Positivliste (nur Swap-Bausteine für die eigene Wallet, Ziel-Konto, Menge, Mindestmenge und Gebühren der Jupiter-Route dekodiert), KyberSwap-Aufrufdaten dekodiert (Empfänger, Tokens, Menge, Mindestmenge, keine Fremdgebühren). Live wird der Wert des Angebots zusätzlich unabhängig über DexScreener-Kurse nachgerechnet. Bricht die Verbindung nach dem Senden ab, steht der Swap als „Ausgang unklar“ in der Historie — dann nicht erneut ausführen, sondern im Explorer nachsehen. „Wallet entfernen“ löscht den gespeicherten Schlüssel.

## Tests

`npm test` läuft gegen die Datenbank aus `DATABASE_URL` und holt die echten Marktdaten, die einzelne Tests brauchen, selbst. Eine Test-Datenbank getrennt vom Betrieb: `TEST_DATABASE_URL` setzen und `scripts/ci.sh` verwenden.
