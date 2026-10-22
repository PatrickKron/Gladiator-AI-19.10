/**
 * Läuft vor jeder Testdatei (vitest.config.ts → setupFiles). Spiegelt den Boot in
 * packages/api/src/start.ts: ausgehende Verbindungen zuerst über IPv4. Grund: KyberSwap
 * (Cloudflare) deckelt die IPv6-Adresse des Hetzner-Servers auf 1 Anfrage je 180 s, über IPv4
 * gilt das normale Kontingent (Server-CI 2026-10-22, per curl -4/-6 belegt); Node würde sonst
 * die AAAA-Antwort zuerst nehmen. Echte Daten bleiben Pflicht — nur der Weg dorthin ändert sich.
 */
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');
