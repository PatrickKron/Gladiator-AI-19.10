# 07 · Pine-Scripts & Anweisungen → ausführbare Strategien

Ziel: Du kannst Strategien auf **drei** Wegen vorgeben, und alle münden in dasselbe kanonische Signal- und Risk-System:

1. **Pine-Script / TradingView** (du hast bereits funktionierende Pine-Indikatoren & ein SMC-Strategie-Script).
2. **Natürliche Anweisung** („Geh long BTC nur bei BOS im London-Open mit RSI < 50, max 5× Hebel").
3. **Eingebaute Strategien** der Engine (siehe `05_…`).

---

## 1. Weg A — TradingView-Pine via Webhook (empfohlen für bestehende Scripts)

Die robusteste, marktübliche Methode, Pine ohne Re-Implementierung zu nutzen:

```
Pine-Strategie/Indikator (alert_message = JSON)
  → TradingView-Alert "Once per bar close" → Webhook (HTTP POST, JSON)
  → Gladiator-Receiver (Signatur prüfen!) → in kanonisches Signal mappen
  → Risk-Gate → Order-Router (CEX/DEX)
```

- **JSON im Alert** selbst bauen (Pine hat keine JSON-Funktion): Platzhalter wie `{{ticker}}`, `{{close}}`, `{{strategy.order.action}}`, plus feste Felder (`strategyId`, `setupType`, `sl`, `tp`). Strings in **doppelten** Anführungszeichen.
- **Sicherheit:** Der Receiver akzeptiert nur Requests mit gültigem **Shared-Secret/HMAC** und bekannter `strategyId`. Jedes eingehende Signal durchläuft trotzdem das **Risk-Gate** (TradingView-Alerts werden nie blind ausgeführt).
- **„Once per bar close"** verwenden, um Doppel-Orders zu vermeiden; Zeitfenster-Regeln im Pine spiegeln die Live-Regeln.
- **Referenz-Implementierung:** `tradingview-alert-connector` (junta) zeigt das Mapping Alert→DEX bereits für dYdX/GMX/Hyperliquid/Bluefin. v2 baut einen eigenen, abgesicherten Receiver in `packages/api`.

## 2. Weg A2 — Pine im Repo verwalten (deine vorhandenen Scripts)

Lege deine Pine-Dateien versioniert ab (`/strategies/pine/`): `SmartMoney_BOS_CHOCH_Strategy.pine`, `new_clean_bos_choch.pine`, `test SMC_Indicator_Nachbau.pine` sowie die vier Indikatoren aus `Funktionierende strategien.txt` (FVG DGT, BOS/CHoCH LuxAlgo, HH/HL/LH/LL-Mod, Pivot-Replika). Jede Pine-Strategie bekommt einen Eintrag in der Strategie-Registry mit ihrer `strategyId`, damit eingehende Webhooks zugeordnet und ausgewertet werden können.

## 3. Weg B — Natürliche Anweisungen → Strategie-DSL

Damit du **proaktiv** und in Worten arbeiten kannst, gibt es eine kleine, typisierte **Strategie-DSL** (JSON/YAML), in die ein LLM deine Anweisung übersetzt — überprüfbar, nicht „Blackbox":

```yaml
# Beispiel: aus "Long BTC nur bei BOS im London-Open, RSI<50, max 5x, 1.5% Risiko"
id: btc-london-bos
symbol: BTC/USDT
venueType: cex
direction: long
when:
  session: london
  all:
    - signal: BOS
    - indicator: RSI
      lt: 50
    - trend: EMA200_up
entry: retest@EMA50
stopLoss: { type: ATR, mult: 1.5 }
takeProfits: [ {rr: 1}, {rr: 2} ]
risk: { maxLeveragePerTrade: 5, riskPctPerTrade: 1.5 }
```

Ablauf: **Anweisung → LLM erzeugt DSL-Entwurf → dir wird der Entwurf gezeigt (Diff/Vorschau) → du bestätigst → Strategie wird registriert.** Das LLM darf nie direkt scharf schalten; es schlägt nur DSL vor. Die DSL wird gegen ein Zod-Schema validiert und von derselben Engine ausgeführt wie die eingebauten Strategien (`05_…`).

## 4. Gemeinsamer Pfad — egal welcher Weg

Alle drei Wege erzeugen **dasselbe kanonische Signal** und durchlaufen denselben Ablauf: Agenten-Review (`08_…`) → Risk-Gate (`06_…`) → (Bestätigung) → Order. So gelten Sicherheit, Limits und Auswertung **immer**, unabhängig von der Quelle.

## 5. Pine-DSL-Konverter (optional, später)

Ein optionaler Konverter kann einfache Pine-`strategy()`-Logik in die DSL übersetzen (für Backtesting innerhalb von Gladiator). Für komplexe Pine-Scripts bleibt der Webhook-Weg (Weg A) die zuverlässige Lösung — Pine vollständig in TS nachzubauen ist fehleranfällig und unnötig.

## 6. Backtesten von Pine/DSL-Strategien

Jede registrierte Strategie (Pine-gemappt oder DSL) ist im Backtester (`08_…`) auf echten OHLCV testbar, **bevor** sie live geht. Pine-Webhook-Strategien können zusätzlich über TradingViews eigenen Strategy-Tester vorvalidiert werden; maßgeblich für die Freigabe ist aber der **interne, look-ahead-freie Backtest** auf echten Daten.

## Quellen

- [TradingView: Webhook-Alerts konfigurieren](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/) · [Pine-Alerts FAQ](https://www.tradingview.com/pine-script-docs/faq/alerts/)
- [tradingview-alert-connector](https://github.com/junta/tradingview-alert-connector)

➡️ Weiter mit **`08_AGENTEN_UND_SELBSTOPTIMIERUNG.md`**.
