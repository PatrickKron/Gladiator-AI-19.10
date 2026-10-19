# Gladiator unterwegs (Handy als App)

Die Web-App ist eine installierbare PWA (`apps/web/public/manifest.webmanifest`,
Icons, Standalone-Modus, Shortcuts zu Signale / Trading / Marktlage).
Erreichbar bleibt sie **nur im Tailscale-Netz** — kein öffentlicher Port.

## Einmalig auf dem Server (HTTPS im Tailnet)

Browser installieren eine PWA nur über HTTPS. Tailscale liefert dafür ein
echtes Zertifikat für den Tailnet-Namen, ohne Port nach außen zu öffnen:

```bash
# auf 95.216.10.238 — API/Web läuft lokal auf Port 3010 (API_PORT, ggf. anpassen)
sudo tailscale serve --bg --https=443 http://127.0.0.1:3010
tailscale serve status   # zeigt https://<server>.<tailnet>.ts.net
```

Danach `CORS_ORIGINS` um `https://<server>.<tailnet>.ts.net` ergänzen und den
API-Dienst neu starten. Der bisherige HTTP-Zugang über die Tailscale-IP bleibt
unverändert nutzbar. **Nicht** `tailscale funnel` verwenden — das wäre öffentlich.

## Auf dem Handy

1. Tailscale-App installieren, im selben Tailnet anmelden.
2. `https://<server>.<tailnet>.ts.net` öffnen und einloggen.
3. iPhone: Teilen → „Zum Home-Bildschirm". Android/Chrome: Menü → „App installieren".

Bewusst **kein** Offline-Cache (Service Worker): Kurse, Positionen und Risiko
dürfen nie aus einem veralteten Zwischenspeicher kommen.
