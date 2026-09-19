# TS3 Analytics – Anleitung für Coding-Agents

## Session-Prompt

Diesen Text zu Beginn jeder Coding-Session einfügen. Optional die gewünschte Task-ID ergänzen.

```
Du arbeitest am Projekt „TS3 Analytics“, einem TeamSpeak-3-Watcher mit Statistiken,
Leaderboards, Admin-Funktionen und automatischem Rangsystem (ähnlich Plan Player
Analytics für Minecraft bzw. Tunaskills Ranking für Sinusbot).

1. Lies zuerst AGENTS.md (Kontext, Regeln, Konventionen) und TODO.md (Aufgaben).
2. Wähle die Aufgabe: [TASK-ID einsetzen] – oder, falls keine angegeben ist, die erste
   offene Aufgabe in TODO.md, deren Abhängigkeiten alle erledigt sind.
3. Nenne kurz deinen Plan (betroffene Dateien, Vorgehen, offene Fragen), dann setze um.
4. Bearbeite ausschließlich diese eine Aufgabe. Fällt dir etwas anderes auf, notiere es
   unter „Gefundene Punkte“ in TODO.md statt es direkt zu ändern.
5. Schreibe bzw. aktualisiere Tests. `pnpm lint`, `pnpm typecheck` und `pnpm test`
   müssen grün sein.
6. Hake die Aufgabe in TODO.md ab und ergänze eine Zeile „Notiz:“ mit dem Wichtigsten
   (Entscheidungen, Einschränkungen, Folgeaufgaben).
7. Schließe mit einer kurzen Zusammenfassung: was geändert wurde, wie getestet wurde,
   was offen ist, und ein Vorschlag für die Commit-Message.

Halte dich strikt an die „Harten Regeln“ in AGENTS.md. Wenn eine Anforderung unklar ist
oder gegen eine Regel verstößt, frag nach, statt zu raten.
```

## Projektziel

Ein eigenständiger Dienst, der sich per ServerQuery mit einem TeamSpeak-3-Server verbindet, Nutzeraktivität aufzeichnet und über ein lokales Webinterface bereitstellt:

- Statistiken pro Server und pro Nutzer (Spielzeit, Aktivität, Sessions, Channels, Nickverlauf)
- Leaderboards (gesamt, aktiv, Woche, Monat, längste Session)
- Admin-Funktionen (Alt-/Ban-Evasion-Erkennung, Notizen, Moderation, Audit-Log)
- Rangsystem: im Webinterface konfigurierbar, weist nach X Stunden automatisch Servergruppen zu

## Zielumgebung

- TeamSpeak 3 Server 3.13.8 auf Windows Server 2016 (Hetzner Dedicated)
- Der Dienst läuft auf derselben Maschine, als Windows-Dienst via NSSM
- Webinterface zunächst nur auf `127.0.0.1` (Zugriff per RDP oder SSH-Tunnel)
- Auf dem Server existiert ein Anti-Flood-Setup. Die Query-IP des Bots muss in `query_ip_allowlist.txt` stehen. Der Bot darf keine Befehlsflut erzeugen.

## Datenumfang & Performance

Das System muss von Beginn an für diese Größenordnung ausgelegt sein:

- Historie: mindestens 5 Jahre Serverlogs (mehrere GB), dazu die SQLite-DB des bisherigen Rankingsystems
- Nutzer: einige hundert regelmäßig aktive, mehrere tausend selten erschienene
- Ziel: Kernabfragen im Webinterface unter 100 ms, auch bei Zeitraum „gesamt“

Grundsätze:

- **Rohdaten und Aggregate trennen.** Sessions und Aktivitätssegmente sind die Quelle; Leaderboards, Dashboard und Rang-Engine lesen ausschließlich aus Aggregattabellen (`user_totals`, `user_daily_stats`, `server_hourly`).
- **Segmente statt Minutenzeilen.** Aktivität wird als Abschnitt mit Start und Ende gespeichert, nicht als Zeile pro Minute und Nutzer.
- **Integer-Schlüssel.** Die UID steht nur in `users`; alle anderen Tabellen verwenden die interne Integer-ID.
- **SQLite-Einstellungen beim Öffnen:** `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `temp_store=MEMORY`, großzügiger `cache_size` und `mmap_size` (konfigurierbar).
- **Schreiben gebündelt** in Transaktionen, nie Einzel-Inserts in Schleifen.
- **Zeitreihen serverseitig downsamplen**, große Tabellen im Frontend paginieren bzw. virtualisieren.
- Änderungen an Kernabfragen werden gegen den synthetischen Datensatz aus T1.4 gemessen.

## Lokale Beispieldaten (`example data/`)

- Enthält Kopien echter Datensätze (DBs, Logs) mit personenbezogenen Daten (u. a. IPs). Nur lokal, in `.gitignore` und allen Tool-Configs ausgeschlossen, darf nie committet werden.
- Dient Agents ausschließlich zum Verifizieren und manuellen Testen (z. B. Formate prüfen, Parser gegen echte Zeilen laufen lassen).
- Kein Ersatz für `/data/import`: Importe und Regel 11 bleiben unverändert.
- Inhalte daraus nie in Tests, Fixtures, Doku, Logs oder Commits übernehmen. Beispiele in Doku und Tests sind anonymisiert bzw. synthetisch.

## Tech-Stack

| Bereich | Wahl |
|---|---|
| Runtime | Node.js 22 LTS, TypeScript (strict) |
| Paketmanager | pnpm |
| TS3-Anbindung | `ts3-nodejs-library` über SSH-Query (Port 10022) |
| Datenbank | SQLite via `better-sqlite3`, Schema und Migrationen mit Drizzle ORM |
| Backend/API | Fastify |
| Frontend | Vite + React + TypeScript, Charts mit ECharts |
| Validierung | zod (Config, API-Eingaben) |
| Logging | pino, Dateiausgabe mit Rotation |
| Tests | Vitest |
| GeoIP | MaxMind GeoLite2-Country (lokale `.mmdb`, npm `maxmind`) |
| Passwörter | argon2 |

## Projektstruktur (Ziel)

```
/src
  /config        Laden und Validieren der .env
  /db            Drizzle-Schema, Migrationen, Repositories
  /ts3           Query-Adapter (Interface + echte Implementierung + Fake für Tests)
  /watcher       Events, Polling, Session-Tracking, IP-Verarbeitung
  /jobs          Periodische Jobs (Ränge, Retention, Backup, Banlist-Sync)
  /api           Fastify-Routen, Auth, Audit-Middleware
  /domain        Reine Logik ohne I/O (Rang-Engine, Alt-Erkennung, Statistik)
  main.ts        Startet alles in einem Prozess
/web             Frontend (Vite)
/data            SQLite-Datei, Backups, GeoIP-DB (nicht im Git)
/docs            Betriebsdoku
```

## Harte Regeln

Diese Regeln gelten immer und dürfen von keiner Aufgabe verletzt werden.

1. **Keine Klar-IP speichern oder loggen.** IPs werden nur im Speicher verarbeitet: erst Land bestimmen, dann HMAC-SHA256 der vollen IP und des Subnetzes (/24 bei IPv4, /64 bei IPv6) mit dem Secret aus der Config. Danach wird die Klar-IP verworfen. Kein einfacher SHA-Hash.
2. **Keine Secrets in Code, Logs oder Git.** Query-Passwort, HMAC-Secret usw. kommen nur aus `.env`. Es wird eine `.env.example` gepflegt.
3. **Nutzer werden über die UID identifiziert**, nie über den Nickname.
4. **Query-Clients ignorieren** (`client_type = 1`), inklusive des Bots selbst.
5. **Query-Befehle drosseln.** Alle Befehle laufen über eine zentrale Queue mit Rate-Limit (Standard: max. 5 Befehle/s, konfigurierbar).
6. **Nur verwaltete Servergruppen anfassen.** Der Rang-Job darf ausschließlich Gruppen zuweisen oder entfernen, die in der Tabelle `ranks` hinterlegt sind. Admin- oder andere Gruppen werden niemals verändert.
7. **Dry-Run ist Standard.** Neue Automatiken, die auf dem Server etwas verändern (Ränge, Moderation), starten im Dry-Run und müssen explizit aktiviert werden.
8. **Webserver bindet an `127.0.0.1`**, solange keine Aufgabe ausdrücklich etwas anderes vorsieht.
9. **Tests laufen nie gegen den echten Server.** Tests nutzen den Fake-Adapter aus `/src/ts3`.
10. **Jede Schreibaktion im Dashboard** (Moderation, Rang-Konfig, Notizen, Overrides) wird ins Audit-Log geschrieben.
11. **Quelldaten nur lesen.** Alte Logs, `ts3server.sqlitedb` und die Alt-Ranking-DB werden nie verändert. Importe arbeiten immer auf Kopien unter `/data/import`.
12. **Keine Doppelzählung.** Für Ränge zählt Alt-Ranking-Zeit bis zum `legacy_cutoff` plus Live-Zeit danach. Aus Logs rekonstruierte Zeit dient nur der Statistik.

## Konventionen

- Code und Bezeichner auf Englisch, UI-Texte auf Deutsch (zentral in einer Übersetzungsdatei, damit später mehrsprachig möglich)
- Zeiten in der DB als UTC-Unix-Timestamp (Sekunden), Anzeige in `Europe/Berlin`
- Dauern in Sekunden speichern, erst im Frontend formatieren
- Geschäftslogik als reine Funktionen in `/domain`, damit sie ohne DB und Server testbar ist
- Schemaänderungen nur über Drizzle-Migrationen, nie manuell
- Kleine, fokussierte Commits im Stil `feat(watcher): ...`, `fix(api): ...`

## Definition of Done (jede Aufgabe)

- Die Akzeptanzkriterien der Aufgabe in TODO.md sind erfüllt
- `pnpm lint`, `pnpm typecheck` und `pnpm test` sind grün
- Neue Logik hat Tests, neue Config-Werte stehen in `.env.example`
- TODO.md ist aktualisiert (Checkbox + Notiz)
- Keine der Harten Regeln ist verletzt
