# 10 · Sicherheit, Secrets & Compliance

Sicherheit ist in v2 ein **Pflichtpfad**, kein Add-on. Diese Datei ist verbindlich, bevor irgendeine Live-Order möglich wird.

---

## 1. SOFORT: kompromittierte Secrets rotieren

In den Alt-Dateien stehen echte Zugangsdaten im Klartext. **Vor** dem Neuaufbau widerrufen/neu erstellen:

| Secret | Wo (Alt) | Aktion |
|---|---|---|
| Telegram-Bot-Token `7544725601:AAF…` | `…/Desktop/GladiatorAI/*` (mehrere: auto_run, monitor_*, send_*, get_chat_id) | BotFather → Token **revoke** + neu |
| OpenAI-Key `sk-proj-…` | `devils_analyst.py`, `weekly_analyzer.py` | platform.openai.com → **revoke** + neu |
| OKX-Key/Secret/Passphrase | `generate_input.py` (ungenutzt) | OKX → **löschen** |
| Telegram-Chat-IDs Free/Pro/VIP | `Tel.GladiatorAI Routing…txt`, `telegram_router.json` | nicht geheim, aber neu zuordnen |

Zusätzlich: die `.env` des Node-Backends enthält reale Keys (OpenAI/OKX gesetzt) — bei Übernahme **rotieren** und nie ins Repo committen.

## 2. Secret-Management (Soll)

- **Kein** Klartext-Fallback mehr (`'secret'`, `'default-key-32-characters-long!'`). Fehlt ein Pflicht-Secret → **Boot-Abbruch** mit klarer Fehlermeldung.
- Secrets via **Vault/Doppler/SOPS** oder mindestens `.env` außerhalb des Repos + `.gitignore`.
- **Börsen-API-Keys** und **DEX-Wallet-Keys**: verschlüsselt at-rest (AES-256-GCM) mit Schlüssel aus dem Secret-Manager; idealerweise KMS/HSM. **Du** legst sie an; der Agent liest sie nur über den Vault, sieht sie nie im Klartext.
- Rotation dokumentiert; pro Umgebung (dev/paper/live) getrennte Secrets.

## 3. Authentifizierung & Autorisierung

- **JWT (kurzlebig) + Refresh-Token**; Pflicht-`JWT_SECRET`. Optional OAuth (Google) + **2FA/TOTP**.
- `protectedProcedure` erzwingt gültiges Token → **401** sonst (kein Demo-User-Fallback).
- `userId` **immer** aus `ctx.user`, nie aus Client-Input.
- **RBAC:** Rollen (user/pro/vip/admin); Admin-Mutationen serverseitig erzwungen.
- **Mandantentrennung:** jeder Datenzugriff scoped auf `ctx.user.id`.

## 4. Netzwerk & API-Härtung

- CORS mit **Origin-Whitelist**; `helmet`; **Rate-Limiting** (pro IP/User/Route).
- Eingaben strikt per **Zod** validieren; Output-Schemas.
- Webhook-Receiver (TradingView/Pine) nur mit **HMAC-Signatur** + bekannter `strategyId`; trotzdem Risk-Gate.
- Keine Secrets/PII in URLs/Query-Strings; keine sensiblen Daten in Logs.

## 5. Trading-Sicherheit (siehe auch `06_…`)

- **Risk-Engine als hartes Gate** vor jeder Order (Limits, Sizing, Margin, Kill-Switch).
- **Prohibited by design:** keine Auszahlungen/Transfers/Swaps durch den Agenten; DEX nur mit **nicht-auszahlungsfähigen** API-/Agent-Wallets.
- **Paper-Default**, Live nur nach expliziter Freigabe + grüner Reconciliation.
- **Audit-Log** (unveränderlich) für Orders, Limit-Änderungen, Logins, Key-Zugriffe.

## 5a. Konkrete Kill-Switch-Schwellen (SAFE-Regeln) — verbindlich

Aus deiner Vorarbeit (`F) Compliance & Safety`). Die Risk-Engine (`06_…`) implementiert diese als harte, konfigurierbare Defaults:

| ID | Auslöser | Aktion |
|---|---|---|
| SAFE-001 Drawdown | Tages > 3 % · Woche > 7 % · Monat > 15 % | HALT (neue Orders sperren; manueller Reset) |
| SAFE-002 Verlustserie | 5 Verluste in Folge | 4 h Pause + LLM-Judge-Review |
| SAFE-003 Volatilität | VIX > 40 · BTC-Intraday > 10 % · ETH > 15 % | keine neuen Positionen, Size −50 %, SL enger |
| SAFE-004 Latenz | Pipeline > 5 s | Execution pausieren (Circuit Breaker) |
| SAFE-005 Datenintegrität | Daten stale > 5 min · Preis-Z-Score > 5 | Signale „LOW CONFIDENCE" + manuelle Bestätigung |
| SAFE-006 Slippage | > 1 % einzeln · > 0,3 % Ø | nur Limit-Orders |
| SAFE-007 Regime-Unsicherheit | > 3 Regime-Wechsel / 24 h | Size −75 % |

## 5b. MiFID II Art. 17 / RTS 6, Market Abuse & Business Continuity

Auch wenn Krypto formal nicht direkt reguliert ist — als verbindliche technische Governance (und Voraussetzung, falls je klassische Instrumente/Drittnutzer dazukommen):

- **SAFE-008 (Art. 17 / RTS 6):** Pre-Trade-Controls (Order-Size **max 5 %**, **Price-Collar 2 %**, **max 10 Orders/min**); Post-Trade (Reconciliation **< 1 h**, Echtzeit-PnL); **Kill-Functionality** (Sofort-Halt + Cancel-all); **Audit-Trail** mit Timestamp (ms), OrderID, Signal-ID, Liste bestandener Risk-Checks; Testing-Gate: Backtest → **min. 30 Tage Paper** → Stress-Test, bevor Live.
- **SAFE-009 Business Continuity:** Failover-Kaskade (z. B. Binance → Bybit → Manuell), **RTO 4 h / RPO 1 h**, vierteljährliche Failover-Tests.
- **SAFE-010 Market Abuse (MAR):** Wash-Trading-/Spoofing-/Layering-Prävention — Opposite-Trade-Cooldown 5 min, Cancel-Rate < 50 %, max 3 offene Orders je Asset.

Diese Schwellen sind Defaults; jede Änderung ist auditiert und (für Lockerungen) durch den Nutzer zu bestätigen.

## 6. Recht, Daten & Compliance

**⚠️ Erlaubnispflicht (BaFin/MiCA) — vor Monetarisierung klären.** Solange du Gladiator AI **nur für dich selbst** nutzt, ist das i. d. R. unkritisch. Sobald du aber **Signale gegen Geld verkaufst** (Free/Pro/VIP) oder **Trades im Namen Dritter ausführst**, kann das in DE/EU eine **erlaubnispflichtige Finanzdienstleistung** sein (Anlageberatung/-vermittlung/Finanzportfolioverwaltung nach KWG/WpIG; für Krypto zusätzlich **MiCA**). Das ist **kein** rein technisches Thema — vor dem kommerziellen Launch **Rechtsberatung** einholen. Im Blueprint ist Monetarisierung deshalb bewusst nach hinten gelegt.

**Steuer-/Trade-Reporting (DE).** Ein handelndes System muss steuerlich auswertbar sein: §23 EStG, FIFO, Haltefristen. Pflicht:
- Datenmodell-Felder für jeden Trade: Entry/Exit-Zeit, Menge, Preis, Gebühren, Funding, realisierter PnL, Asset, Börse.
- **Export-Funktion** (CSV/Steuersoftware-Format) im UI (unter „Trading & Börsen" oder „Profile").
- Unveränderliches Audit-Log als Beleggrundlage.

**Datenschutz & Betrieb.**
- DSGVO: User-Daten minimal, löschbar; Datenschutz-/AGB-Zustimmung beim Register (war vorgesehen).
- Klartrennung personenbezogener Daten von Marktdaten; keine PII in Logs/URLs.
- **Backups (DB) verschlüsselt; Restore regelmäßig getestet** (als Schritt im Bauplan verankert, `11_…` Phase 7).
- **Disclaimer** im UI: Trading-Signale sind keine Anlageberatung.
- **Datenquellen-Lizenzen** beachten (Yahoo nicht kommerziell etc., siehe `04_…` §8).

## 7. Sicherheits-Checkliste (Abnahme)

- [ ] Alle Alt-Secrets rotiert/gelöscht.
- [ ] Keine Klartext-Fallbacks; Boot bricht ohne Pflicht-Secrets ab.
- [ ] Echte Auth + RBAC + Tenant-Scoping; kein `MOCK_AUTH`, kein Demo-User.
- [ ] tRPC/REST tragen Auth-Header; 401 bei fehlendem Token.
- [ ] CORS-Whitelist, helmet, Rate-Limit aktiv.
- [ ] Börsen-/Wallet-Keys verschlüsselt im Vault; nur Trade-Rechte, kein Withdraw.
- [ ] Risk-Engine blockt nachweislich (Tests) Orders über Limit.
- [ ] Audit-Log vollständig; Webhooks signiert.
- [ ] Disclaimer im UI.

➡️ Weiter mit **`11_BUILD_PLAN_CLAUDE_CODE.md`**.
