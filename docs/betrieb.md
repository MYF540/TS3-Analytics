# Betrieb auf dem Windows-Server

Kurzfassung für Installation, Dienst, Updates und Wartung. Sicherung und Wiederherstellung stehen in [backup.md](backup.md), Auskunft und Löschung in [datenschutz.md](datenschutz.md).

## Voraussetzungen

- Windows Server (getestet wird gegen Windows 11 / Server 2016), Node.js 22 LTS (64 Bit)
- pnpm über Corepack: `corepack enable`
- [NSSM](https://nssm.cc/) für den Dienst – `nssm.exe` in den PATH legen oder dem Setup-Skript mit `-Nssm <pfad>` nennen
- Zugriff auf den TeamSpeak-Server: ServerQuery über **SSH** (Standardport 10022)

## Installation

Alles Weitere erledigt das Setup-Skript. PowerShell **als Administrator** öffnen (einen Dienst anzulegen geht nicht ohne):

```
cd C:\apps\ts3-analytics
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 install
```

Das Skript prüft Node und NSSM, installiert die Abhängigkeiten, legt `.env` aus `.env.example` an, erzeugt ein `HMAC_SECRET`, baut die Anwendung und richtet den Dienst ein. Fehlen danach noch Werte in `.env` – Query-Benutzer und -Passwort –, sagt es das und startet den Dienst noch nicht.

| Befehl                     | Was passiert                                                 |
| -------------------------- | ------------------------------------------------------------ |
| `setup.ps1 install`        | Abhängigkeiten, `.env`, Build, Dienst einrichten und starten |
| `setup.ps1 update`         | Anhalten, sichern, neue Version holen, bauen, starten        |
| `setup.ps1 start` / `stop` | Dienst starten bzw. anhalten                                 |
| `setup.ps1 status`         | Dienst, `.env`, Datenbank und Health auf einen Blick         |
| `setup.ps1 uninstall`      | Dienst entfernen; Daten und `.env` bleiben erhalten          |

Optionen: `-ServiceName <name>` (Vorgabe `ts3-analytics`), `-Nssm <pfad>`, falls `nssm.exe` nicht im PATH liegt, `-Yes` ohne Rückfragen, `-SkipBackup` beim Update und `-PurgeData` beim Deinstallieren (löscht Datenbank, Logs und Sicherungen, fragt vorher zusätzlich nach).

Von Hand wären es diese Schritte:

```
pnpm install --frozen-lockfile
copy .env.example .env      # danach .env ausfüllen
pnpm build
```

`pnpm build` erzeugt den Server in `dist/` und die Weboberfläche in `web/dist/`. Gestartet wird mit `node dist/main.js` (Skript: `pnpm start`). Die Konfiguration kommt aus `.env` im Arbeitsverzeichnis; echte Umgebungsvariablen haben Vorrang.

Pflichtwerte in `.env`: `TS3_HOST`, `TS3_QUERY_PORT`, `TS3_QUERY_USER`, `TS3_QUERY_PASSWORD`, `HMAC_SECRET` (mindestens 32 Zeichen, einmalig erzeugen und **nie** ändern – sonst passen gespeicherte IP-Prüfsummen nicht mehr zusammen). Alle weiteren Werte sind in `.env.example` beschrieben.

Erstes Admin-Konto anlegen:

```
pnpm admin:user create <name>
```

Die Weboberfläche hört nur auf `127.0.0.1` (Standard-Port 8080, `WEB_PORT`). Zugriff also per Remotedesktop auf dem Server oder über einen SSH-Tunnel; nicht ins Internet veröffentlichen.

## Rechte des Query-Accounts

Der ServerQuery-Account braucht – je nach genutzten Funktionen – diese Rechte. Die genauen Namen und nötigen „Power“-Werte hängen von Serverversion und Gruppenhierarchie ab; die Power-Werte müssen über denen der betroffenen Spieler bzw. Gruppen liegen.

| Funktion                     | Benötigt                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Grundbetrieb (Zeiterfassung) | Login, virtuellen Server auswählen, Clientliste, Channelliste, Events abonnieren                 |
| Länder-Statistik (IP-Hashes) | IP-Adresse eines Clients sehen (`b_client_remoteaddress_view`)                                   |
| Banlisten-Spiegel (T5.1)     | Banliste lesen (`b_client_ban_list`)                                                             |
| Servergruppen-Überwachung    | Server-Log lesen (`b_virtualserver_log_view`), Gruppenliste (`b_virtualserver_servergroup_list`) |
| Moderation (T5.6)            | Kicken, Bannen, Anstupsen, Nachricht, Verschieben – jeweils mit passender Power                  |
| Rangsystem (Phase 6)         | Servergruppen zuweisen und entfernen (`i_group_member_add_power`, `i_group_member_remove_power`) |

Fehlt ein Recht, meldet der Dienst das als Warnung im Log; sie erscheint auf der Seite „Bot-Status“.

## Anti-Flood-Allowlist

Der Bot fragt regelmäßig Listen ab. Ohne Ausnahme sperrt der TeamSpeak-Server die Query-Verbindung („anti-flood“). Deshalb die IP des Bots in die Allowlist des TeamSpeak-Servers eintragen:

1. Datei `query_ip_allowlist.txt` im TeamSpeak-Verzeichnis öffnen (ältere Versionen: `query_ip_whitelist.txt`).
2. Eine Zeile mit der IP ergänzen, von der der Bot kommt – läuft er auf demselben Server, genügt `127.0.0.1`.
3. TeamSpeak-Server neu starten.

Der Dienst begrenzt seine Abfragen zusätzlich selbst (`TS3_QUERY_RATE_LIMIT`, Standard 5 Befehle pro Sekunde). Taucht im Log „anti-flood“ auf, ist der Eintrag in der Allowlist zu prüfen.

## Dienst mit NSSM

`setup.ps1 install` setzt genau diese Werte. Von Hand:

```
nssm install ts3-analytics "C:\Program Files\nodejs\node.exe" "C:\apps\ts3-analytics\dist\main.js"
nssm set ts3-analytics AppDirectory C:\apps\ts3-analytics
nssm set ts3-analytics Start SERVICE_AUTO_START
nssm set ts3-analytics AppStdout C:\apps\ts3-analytics\data\logs\service-out.log
nssm set ts3-analytics AppStderr C:\apps\ts3-analytics\data\logs\service-out.log
nssm set ts3-analytics AppExit Default Restart
nssm start ts3-analytics
```

- `AppDirectory` ist wichtig: Von dort werden `.env` und alle relativen Pfade (`./data`) gelesen.
- `service-out.log` enthält nur, was auf der Konsole landet. Die eigentlichen Logdateien schreibt der Dienst selbst nach `LOG_DIR`.
- Das Dienstkonto braucht Schreibrechte auf `data/` (Datenbank, Logs, Sicherungen).
- Stoppen mit `nssm stop ts3-analytics`. Der Dienst schließt dabei offene Sessions sauber ab; ein Neustart innerhalb von `SESSION_RESUME_GRACE_S` (Standard 300 s) setzt laufende Sessions fort.

## Logs

- Anwendungslog: `LOG_DIR` (Standard `./data/logs`), eine Datei pro Tag, `LOG_RETENTION_DAYS` Tage (Standard 14).
- Format: eine JSON-Zeile je Eintrag. Passwörter, Tokens und Webhook-URLs werden geschwärzt, IP-Adressen durch `[IP]` ersetzt.
- Die letzten Warnungen und Fehler stehen auch auf der Seite „Bot-Status“ – dort zuerst nachsehen.
- `LOG_LEVEL` (Standard `info`) vorübergehend auf `debug` setzen, wenn ein Problem eingegrenzt werden muss.

## Update

```
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 update
```

Das Skript hält den Dienst an, legt eine Sicherung an, holt die neue Version (`git pull --ff-only`), installiert, baut und startet wieder. Von Hand:

```
nssm stop ts3-analytics
pnpm backup                       # Sicherung vor dem Update
git pull                          # oder neue Dateien einspielen
pnpm install --frozen-lockfile
pnpm build
nssm start ts3-analytics
```

Migrationen laufen beim Start automatisch. Danach prüfen:

- `curl http://127.0.0.1:8080/api/health` → `status` ist `ok` (oder `degraded`, solange die TeamSpeak-Verbindung noch fehlt)
- Seite „Bot-Status“: Verbindung, letzter Heartbeat, Jobs, letzte Fehler

Geht etwas schief, hilft die Sicherung von vorhin – siehe [backup.md](backup.md).

## GeoLite2 aktualisieren

Die Länderzuordnung nutzt die Datei aus `GEOIP_DB_PATH` (Standard `./data/GeoLite2-Country.mmdb`). MaxMind aktualisiert sie mehrmals im Monat; ein bis zwei Aktualisierungen pro Jahr reichen für diesen Zweck.

1. Bei MaxMind anmelden und „GeoLite2 Country“ als `.mmdb` herunterladen.
2. Datei nach `data/GeoLite2-Country.mmdb` kopieren (vorherige Datei ersetzen).
3. Dienst neu starten – die Datei wird nur beim Start geladen.

Fehlt die Datei, läuft alles andere normal weiter; es werden dann nur keine Länder mehr zugeordnet (Warnung im Log).

## Regelmäßige Aufgaben

Diese Jobs laufen im Dienst selbst; ihr letzter Lauf steht auf der Seite „Bot-Status“.

| Wann            | Was                                                            |
| --------------- | -------------------------------------------------------------- |
| Alle 15 Minuten | Hinweis-Erkennung (`flag-detection`)                           |
| Stündlich       | Abgelaufene Logins entfernen (`expired-sessions`)              |
| Täglich         | Sicherung (`backup`), Aufbewahrung von IP-Daten (`retention`)  |
| Wöchentlich     | Datenbank-Wartung (`maintenance`: `optimize`, WAL verkleinern) |

Von Hand:

| Wann         | Was                                                                   |
| ------------ | --------------------------------------------------------------------- |
| Nach Updates | Health und Bot-Status prüfen                                          |
| Gelegentlich | GeoLite2 aktualisieren, Sicherungen stichprobenartig wiederherstellen |
