# Version 3 sichtbar machen (Deploy GitHub → Server)

**Warum du v3 nicht siehst:** Alles bis PR #87 (Design-System v3, Chat, Mängelliste 1–12) liegt auf
GitHub `main` — der Server `95.216.10.238` läuft aber noch auf dem Stand `92f1133` (vor Session 9).
Unter `http://100.72.94.1:3010` erscheint deshalb weiter die alte Oberfläche („Version 2“).
Cloud-Sitzungen (aus GitHub geklont) haben weder SSH zum Server noch Tailscale und können nicht
ausrollen. Das muss einmal von dir angestoßen werden — danach läuft es automatisch.

## Weg 0 (am wenigsten Tipparbeit): lokale Claude-Sitzung auf deinem PC

Eine Sitzung, die direkt in der Claude-App auf deinem Windows-PC läuft (nicht in der Cloud), hat
deinen SSH-Zugang zum Server und den Browser. Neue Unterhaltung für den Ordner `gladiator-v2`
starten und eingeben:

> Deploye GitHub main auf den Hetzner-Server: im Ordner gladiator-v2 `git fetch origin main` und
> `git push server origin/main:refs/heads/main`. Warte die Hook-Ausgabe bis „CI GRUEN“ ab und prüfe
> im Browser, dass http://100.72.94.1:3010 die neue Oberfläche mit dem Knopf „Chat“ zeigt.

Danach ist v3 live. Damit es künftig von allein passiert, zusätzlich Weg A einmal ausführen
(oder PR #88 mergen und das Secret `DEPLOY_SSH_KEY` setzen — beide Wege sind gleichwertig,
Weg A braucht keinen privaten Schlüssel bei GitHub).

## Weg A (empfohlen für den Dauerbetrieb, einmalig): Auto-Deploy auf dem Server einschalten

Auf dem Server als root (per SSH von deinem PC: `ssh root@95.216.10.238`):

```bash
curl -fsSL https://raw.githubusercontent.com/PatrickKron/Gladiator-AI-19.10/main/deploy/install-github-sync.sh | bash
systemctl start gladiator-github-sync          # erster Lauf sofort statt in 2 Minuten
journalctl -u gladiator-github-sync -f         # zuschauen; Strg+C beendet nur das Zuschauen
```

Was passiert: Das Skript findet das Server-Repo (Ziel von `git push server main`), holt GitHub `main`
und pusht es dorthin. Der bestehende post-receive-Hook führt `scripts/ci.sh` aus (npm ci, Lint,
Typecheck, Migrationen 0019–0042, Tests, Web-Build) und startet `gladiator` + `gladiator-worker`
**nur bei grüner CI** neu. Das dauert einige Minuten. Danach alle 2 Minuten automatisch: jeder
Merge auf GitHub `main` ist kurz darauf live. Das Repo ist öffentlich → kein Deploy-Key nötig.

Fertig-Kontrolle: `systemctl status gladiator gladiator-worker` und im Browser
`http://100.72.94.1:3010` (Tailscale muss auf dem PC laufen) — Login-Seite mit Regen-Effekt, danach
fünf Bereiche Heute · Markt · Traden · Strategien · Mehr und oben rechts der Knopf „Chat“.

## Weg B (einmalig, von deinem Windows-PC, ohne Server-Login)

Im lokalen Repo-Ordner (`Antigravity Gladiator AI versuch 1\gladiator-v2`). Deine lokale
Arbeitskopie wird dabei NICHT verändert — es wird direkt GitHub-main an den Server gepusht:

```bash
git fetch origin main
git push server origin/main:refs/heads/main
```

Der Hook macht dann dasselbe wie oben (CI, dann Neustart). Fehlermeldung „non-fast-forward“ hieße,
dass auf dem Server Commits liegen, die auf GitHub fehlen — dann NICHT erzwingen, sondern melden.

## Wenn es nicht erscheint

- `journalctl -u gladiator-github-sync -n 50 --no-pager` (Weg A) bzw. die Ausgabe des Push (Weg B)
  zeigt den CI-Schritt, der rot wurde. Bei rot bleibt die alte Version weiterlaufen — nichts kaputt.
- Browser: Strg+F5 (alte Oberfläche im Cache).
- `http://100.72.94.1:3010` geht nur mit eingeschaltetem Tailscale; der öffentliche Port ist
  absichtlich geschlossen.
- Anschließend in der App: Einstellungen → API-Keys → `ANTHROPIC_API_KEY`, sonst zeigen Chat,
  KI-Urteil und Workshop ehrlich „nicht verbunden“.
