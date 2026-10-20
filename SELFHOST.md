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
| `WALLET_KEYS_ENABLED=1` | eigene Trading-Wallets mit Schlüssel für Spot-Swaps erlauben (nur beim Selbsthosten; Schlüssel verschlüsselt, keine Überweisungen/Abhebungen) |
| `RPC_URL_SOLANA`, `RPC_URL_ETHEREUM`, `RPC_URL_BASE`, `RPC_URL_ARBITRUM`, `RPC_URL_BSC` | eigene RPC-Endpunkte statt der öffentlichen |

Börsen- und Wallet-Zugänge trägst du nicht in die `.env` ein, sondern in der App unter Einstellungen › Börsen. Sie werden dort verschlüsselt gespeichert. Gladiator nimmt nie Abhebe-Rechte an.

## Wallet-Trading (Spot-Swaps)

Unter Handel & Vermögen › Wallet-Trading: Token-Adresse einfügen → Preis, Liquidität, Marktkapitalisierung (DexScreener) → Schnellkauf/-verkauf → echte Route über Jupiter (Solana) bzw. KyberSwap (Ethereum, Base, Arbitrum, BSC). Jeder Swap läuft durch das Swap-Gate mit den Grenzen der Wallet (Betrag, Slippage, Preis-Einfluss, Mindest-Liquidität — Profile von Vorsichtig bis Meme-Coins, frei änderbar). Paper-Wallets handeln virtuell zum echten Angebot inkl. Gebühren.

## Tests

`npm test` läuft gegen die Datenbank aus `DATABASE_URL` und holt die echten Marktdaten, die einzelne Tests brauchen, selbst. Eine Test-Datenbank getrennt vom Betrieb: `TEST_DATABASE_URL` setzen und `scripts/ci.sh` verwenden.
