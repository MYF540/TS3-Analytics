# TS3 Analytics – TODO

Aufgaben werden von oben nach unten abgearbeitet, jeweils eine pro Session. Eine Aufgabe darf erst begonnen werden, wenn alle unter „braucht“ genannten Aufgaben abgehakt sind.

**Rollen** zeigen, welcher Agent-Typ zuständig ist. Aufgaben verschiedener Rollen ohne gegenseitige Abhängigkeit können parallel laufen (z. B. Frontend-Grundgerüst parallel zum Watcher).

`Setup` · `DB` · `Watcher` · `Backend` · `Frontend` · `Security` · `Ops`

---

## Phase 0 – Projektgrundlage

- [x] **T0.1 Repo-Grundgerüst** · `Setup` · braucht: –
  - pnpm-Projekt, TypeScript strict, ESLint + Prettier, Vitest, Ordnerstruktur laut AGENTS.md
  - Scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `test`
  - Fertig wenn: alle Scripts laufen fehlerfrei auf einem leeren Projekt, `.gitignore` schließt `/data` und `.env` aus
  - Notiz: ESM (`"type": "module"`, `NodeNext`), strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; ESLint 10 Flat-Config mit `strictTypeChecked` + `eslint-config-prettier`; `lint` prüft ESLint und Prettier. TypeScript bewusst auf `~6.0` gepinnt, da typescript-eslint 8.x TS 7 noch nicht unterstützt. `build` nutzt `tsconfig.build.json` (nur `src`, ohne Tests) → `dist/`. `/web` ist aus der Backend-Config ausgeschlossen und wird in T3.3 eigenständig aufgesetzt. Tests: `src/**/*.test.ts` und `test/**/*.test.ts`. esbuild-Build-Skript in `pnpm-workspace.yaml` freigegeben. AGENTS.md/TODO.md sind von Prettier ausgenommen.

- [ ] **T0.2 Config-Modul** · `Setup` · braucht: T0.1
  - `.env` laden und mit zod validieren; `.env.example` anlegen
  - Werte: TS3-Host, SSH-Query-Port, Query-User/-Passwort, virtuelle Server-ID, Bot-Nickname, HMAC-Secret, Web-Host/-Port, Pfad GeoIP-DB, Pfad SQLite, IP-Aufbewahrung (Tage, Standard 90), Query-Rate-Limit
  - Fertig wenn: fehlendes oder zu kurzes HMAC-Secret (< 32 Zeichen) bricht den Start mit klarer Meldung ab; Tests für gültige und ungültige Config

- [ ] **T0.3 Logging** · `Setup` · braucht: T0.2
  - pino mit Konsolen- und Dateiausgabe, tägliche Rotation, Log-Level aus Config
  - Redaction für Passwörter, Secrets und IP-Felder
  - Fertig wenn: ein Test belegt, dass ein Feld `ip` oder `password` im Log redacted erscheint

## Phase 1 – Datenbank

- [ ] **T1.1 Schema & Migrationen** · `DB` · braucht: T0.2
  - Siehe Abschnitt „Datenumfang & Performance“ in AGENTS.md
  - `users`: interne Integer-ID als Primärschlüssel, UID (unique), dbid, first_seen, last_seen, platform, version, country. Alle anderen Tabellen referenzieren die Integer-ID, nie die UID-Zeichenkette
  - `nicknames` (user_id, nick, first_seen, last_seen) plus FTS5-Index für die Suche
  - `channels` (id, name, zuletzt gesehen)
  - `sessions` (user_id, join_at, leave_at, duration, source)
  - `activity_segments` (user_id, start, end, channel_id, state): eine Zeile pro zusammenhängendem Abschnitt mit gleichem Zustand und Channel, keine Minutenzeilen
  - `user_daily_stats` (user_id, day, online_s, active_s, idle_s, afk_s, unknown_s, sessions, longest_session_s), Primärschlüssel (user_id, day), WITHOUT ROWID
  - `user_totals` (user_id, online_s, active_s, sessions, longest_session_s, first_seen, last_seen): laufend gepflegter Cache für Allzeit-Werte
  - `server_minutely` (ts, online) für die letzten Tage, `server_hourly` (hour, avg_online, max_online, unique_users) dauerhaft
  - `ip_seen`, `settings` wie gehabt
  - Alle Tabellen STRICT, Zeitstempel als Integer (Unix-Sekunden, UTC)
  - Fertig wenn: Migration läuft auf leerer DB durch; PRAGMAs laut AGENTS.md werden beim Öffnen gesetzt

- [ ] **T1.2 Repository-Layer** · `DB` · braucht: T1.1
  - Typisierte Funktionen für alle Schreib- und Lesezugriffe des Watchers
  - Fertig wenn: Tests mit In-Memory-SQLite decken Upsert User, Nick-Wechsel, Session öffnen/schließen, Segment verlängern/abschließen ab

- [ ] **T1.3 Aggregations-Layer** · `DB` · braucht: T1.2
  - Funktionen, die beim Abschließen von Sessions und Segmenten `user_daily_stats`, `user_totals` und `server_hourly` inkrementell fortschreiben (Segmente über Mitternacht korrekt auf zwei Tage aufteilen, Tagesgrenze in `Europe/Berlin`)
  - Zusätzlich ein Befehl `pnpm stats:rebuild [--from] [--to]`, der alle Aggregate aus Sessions und Segmenten neu berechnet
  - Fertig wenn: Tests belegen, dass inkrementelle Fortschreibung und Rebuild identische Ergebnisse liefern (inkl. Sommer-/Winterzeitwechsel)

- [ ] **T1.4 Testdaten-Generator & Performance-Budget** · `DB` · braucht: T1.3
  - `pnpm seed:synthetic` erzeugt 6 Jahre Daten: ca. 500 Stammnutzer mit regelmäßigen Sessions, ca. 8.000 Gelegenheitsnutzer mit wenigen Sessions, realistische Tageszeiten
  - Benchmark-Script misst die Kernabfragen (Leaderboards aller Zeiträume, Nutzerdetail, Dashboard 30 Tage/1 Jahr/gesamt, Suche)
  - Fertig wenn: jede Kernabfrage < 100 ms; Ergebnis in `/docs/performance.md`. Spätere Tasks, die Abfragen ändern, führen den Benchmark erneut aus

## Phase 2 – Watcher

- [ ] **T2.1 TS3-Adapter & Verbindung** · `Watcher` · braucht: T0.3
  - Interface `Ts3Adapter` mit echter Implementierung (`ts3-nodejs-library`, SSH-Query) und Fake für Tests
  - Reconnect mit exponentiellem Backoff, Keepalive, zentrale Befehls-Queue mit Rate-Limit
  - Fertig wenn: Verbindungsabbruch im Fake führt zu Reconnect; Queue hält das Limit nachweislich ein (Test)

- [ ] **T2.2 Event-Tracking** · `Watcher` · braucht: T1.2, T2.1
  - Join, Leave und Channelwechsel verarbeiten → Users, Nicknames, Sessions
  - Query-Clients ignorieren
  - Fertig wenn: Test-Szenario (Join → Move → Nickwechsel → Leave) im Fake erzeugt korrekte DB-Einträge

- [ ] **T2.3 Aktivitäts-Polling** · `Watcher` · braucht: T2.2, T1.3
  - Alle 60 s (konfigurierbar) `clientlist` mit uid, times, groups, voice, away abfragen
  - Pro Client den Zustand bestimmen (Idle-Zeit, Away-Status, AFK-Channel). Bleiben Zustand und Channel gleich, wird das offene `activity_segment` nur verlängert; ändert sich etwas, wird es abgeschlossen (→ Aggregate fortschreiben) und ein neues begonnen
  - Offene Segmente im Speicher halten und höchstens alle paar Minuten gesammelt in einer Transaktion schreiben
  - Einen Wert in `server_minutely` schreiben
  - Idle-Schwelle und AFK-Channel-IDs aus `settings`
  - Fertig wenn: Tests für die Zustandsbestimmung (active/idle/afk) als reine Funktion in `/domain`

- [ ] **T2.4 Crash-Recovery** · `Watcher` · braucht: T2.3
  - Heartbeat-Timestamp in `settings`; beim Start offene Sessions am letzten Heartbeat schließen und mit aktueller `clientlist` neu eröffnen
  - Fertig wenn: simulierter Absturz im Test hinterlässt keine unendlich offenen Sessions

- [ ] **T2.5 IP-Verarbeitung** · `Watcher` `Security` · braucht: T2.2
  - Beim Join `connection_client_ip` per `clientinfo` holen, Land per GeoLite2 bestimmen, dann HMAC der vollen IP und des Subnetzes (/24, /64); `ip_seen` upserten
  - Klar-IP nur in einer lokalen Variable, nie persistiert oder geloggt
  - Fertig wenn: Tests für IPv4 und IPv6, gleiche IP → gleicher Hash, gleiches Subnetz → gleicher Subnetz-Hash; ein Test durchsucht die DB nach der Klar-IP und findet nichts

- [ ] **T2.6 Retention & Wartung** · `Watcher` `DB` · braucht: T2.5, T1.3
  - Täglicher Job: `ip_seen` älter als Aufbewahrungsfrist löschen; `server_minutely` älter als 14 Tage löschen (steckt dann in `server_hourly`)
  - `activity_segments` älter als X Monate optional löschen (Standard: behalten; konfigurierbar). Tages- und Gesamtaggregate bleiben immer erhalten
  - Wöchentlich `PRAGMA optimize` und `wal_checkpoint(TRUNCATE)`
  - Fertig wenn: Tests belegen Löschung ohne Veränderung der Aggregate

## Phase 3 – API & Webinterface (lokal)

- [ ] **T3.1 Fastify-Server** · `Backend` · braucht: T1.2
  - Bindet an `127.0.0.1`, liefert das gebaute Frontend aus, einheitliches Fehlerformat, zod-Validierung
  - Fertig wenn: `/api/health` antwortet mit Status von DB und Query-Verbindung

- [ ] **T3.2 Statistik-Endpunkte** · `Backend` · braucht: T3.1, T2.3
  - Übersicht (online jetzt, Peak heute/Allzeit, Nutzer gesamt/neu), Online-Verlauf, Heatmap Wochentag × Stunde
  - Nutzerliste (Suche, Paginierung, Sortierung), Nutzerdetail (Spielzeit gesamt/aktiv, Sessions, Top-Channels, Nickverlauf, Länder)
  - Leaderboards: gesamt, aktiv, Woche, Monat, Jahr, frei wählbarer Zeitraum, längste Session
  - Alle Abfragen lesen aus `user_totals`, `user_daily_stats` und `server_hourly`, nie aus Rohdaten über lange Zeiträume
  - Zeitreihen werden serverseitig passend zum Zeitraum aufgelöst (Minute / Stunde / Tag / Woche), max. ca. 1.000 Punkte pro Antwort
  - Nutzerliste standardmäßig gefiltert auf Nutzer mit Mindestspielzeit (Gelegenheitsnutzer per Schalter einblendbar); Suche über FTS5 auf Nicknames und UID
  - Fertig wenn: Tests mit Seed-Daten prüfen die Berechnungen; Benchmark aus T1.4 bleibt im Budget

- [ ] **T3.3 Frontend-Grundgerüst** · `Frontend` · braucht: T0.1
  - Vite + React + TS, Router, Layout mit Navigation, Hell/Dunkel-Modus, API-Client, Übersetzungsdatei (de)
  - Fertig wenn: leere Seiten Dashboard, Spieler, Leaderboards sind erreichbar

- [ ] **T3.4 Dashboard-Seite** · `Frontend` · braucht: T3.2, T3.3
  - Kennzahlen-Kacheln, Online-Verlauf (24 h / 7 Tage / 30 Tage), Heatmap
  - Fertig wenn: Seite zeigt Seed-Daten korrekt und ist auf schmalen Bildschirmen nutzbar

- [ ] **T3.5 Spieler-Seiten** · `Frontend` · braucht: T3.2, T3.3
  - Liste mit Suche; Detailseite mit Spielzeit-Verlauf, Sessions, Channels, Nickverlauf

- [ ] **T3.6 Leaderboards-Seite** · `Frontend` · braucht: T3.2, T3.3
  - Tabs für alle Leaderboard-Arten, Link zur Spielerseite

## Phase 4 – Auth & Admin-Basis

- [ ] **T4.1 Login & Rollen** · `Backend` `Security` · braucht: T3.1
  - Tabelle `admin_users`, argon2-Hashes, Session-Cookie (httpOnly, sameSite=strict), Rollen `admin` / `moderator` / `viewer`
  - CLI-Befehl zum Anlegen des ersten Admins; Login-Seite im Frontend; Rechteprüfung pro Route
  - Fertig wenn: Tests prüfen Rollenrechte je Route; Login-Versuche sind gedrosselt

- [ ] **T4.2 Audit-Log** · `Backend` · braucht: T4.1
  - Tabelle `audit_log` (wer, was, Ziel, Details, wann), Middleware für alle schreibenden Routen, Seite mit Filter
  - Fertig wenn: jede schreibende Route erzeugt nachweislich einen Eintrag (Test)

- [ ] **T4.3 Notizen & Tags** · `Backend` `Frontend` · braucht: T4.2
  - Notizen mit Verlauf und Autor, frei definierbare Tags, Anzeige auf der Spielerseite

- [ ] **T4.4 Bot-Status-Seite** · `Backend` `Frontend` · braucht: T4.1
  - Query-Verbindung, letzter Heartbeat, Uptime, DB-Größe, letzte Fehler aus dem Log

## Phase 5 – Sicherheit & Moderation

- [ ] **T5.1 Banlist-Sync** · `Watcher` · braucht: T2.5
  - Banliste periodisch vom Server lesen und lokal spiegeln (inkl. UID, falls vorhanden)

- [ ] **T5.2 Alt- & Evasion-Erkennung** · `Security` · braucht: T5.1, T4.2
  - Reine Funktion in `/domain`, die Flags erzeugt: gleicher IP-Hash wie gebannte UID → hoch; gleicher Subnetz-Hash wie gebannte UID → mittel; gleicher IP-Hash wie andere UID → info
  - Tabelle `flags` mit Status offen / verknüpft / ignoriert; Seite mit Aktionen
  - Fertig wenn: Tests für alle Flag-Stufen; ignorierte Paare werden nicht erneut geflaggt

- [ ] **T5.3 UID-Verknüpfung** · `DB` `Backend` · braucht: T5.2
  - Tabelle `persons`; mehrere UIDs einer Person zuordnen; Statistiken und Leaderboards rechnen auf Personenebene zusammen

- [ ] **T5.4 Discord-Alerts** · `Backend` · braucht: T5.2
  - Webhook-URL und Ereignistypen im Webinterface konfigurierbar; Versand gedrosselt

- [ ] **T5.5 Join-Spike-Erkennung** · `Watcher` `Security` · braucht: T5.4
  - Alarm, wenn neue UIDs in Zeitfenster X über Schwelle Y liegen (beides konfigurierbar)

- [ ] **T5.6 Moderationsaktionen** · `Backend` `Frontend` · braucht: T4.2
  - Kick, Ban (Vorlagen für Grund und Dauer), Poke, Nachricht, Move – je nach Rolle
  - Fertig wenn: jede Aktion läuft über die Query-Queue und landet im Audit-Log

- [ ] **T5.7 Servergruppen-Überwachung** · `Watcher` `Security` · braucht: T5.4
  - Serverlog per `logview` auf Gruppenzuweisungen auswerten; Alarm bei als „geschützt“ markierten Gruppen

## Phase 6 – Rangsystem

- [ ] **T6.1 Rang-Schema** · `DB` · braucht: T1.1
  - Tabellen `ranks` (Name, Reihenfolge, benötigte Stunden, Servergruppen-ID), `rank_history`, `rank_overrides`
  - Settings: Zählmodus (online / nur aktiv), ausgeschlossene Servergruppen, Dry-Run an/aus (Standard: an)

- [ ] **T6.2 Rang-Engine** · `Backend` · braucht: T6.1, T2.3
  - Reine Funktion: aus Spielzeit, Overrides und Rangliste den Soll-Rang bestimmen
  - Vorschau-Endpunkt: wer steigt beim nächsten Lauf auf oder ab
  - Fertig wenn: Tests für Grenzwerte, Ausschlüsse, eingefrorene Ränge, Bonusstunden

- [ ] **T6.3 Rang-Job** · `Watcher` · braucht: T6.2, T4.2
  - Läuft alle X Minuten; weist neue Rang-Gruppe zu und entfernt die vorherige
  - Prüft nur Nutzer, die seit dem letzten Lauf online waren oder deren Overrides/Rangkonfiguration sich geändert haben; ein Voll-Lauf über alle Nutzer nur nach Konfigurationsänderung
  - Gruppen können nur bei Online-Nutzern sicher geprüft werden; für Offline-Nutzer wird die Änderung vorgemerkt oder per `servergroupaddclient` über die DB-ID gesetzt (Verhalten dokumentieren)
  - Fasst ausschließlich Gruppen aus `ranks` an; im Dry-Run nur Protokoll
  - Fertig wenn: Test belegt, dass nicht verwaltete Gruppen nie verändert werden

- [ ] **T6.4 Rang-Konfiguration im Webinterface** · `Frontend` · braucht: T6.2, T4.1
  - Ränge anlegen, sortieren, bearbeiten; Servergruppen-Auswahl aus `servergrouplist`; Vorschau vor dem Speichern; Dry-Run-Schalter (nur Admin)

- [ ] **T6.5 Overrides** · `Backend` `Frontend` · braucht: T6.4
  - Rang einfrieren, Bonusstunden vergeben, vom Ranking ausschließen – auf der Spielerseite

- [ ] **T6.6 Saisons & Inaktivität (optional)** · `Backend` · braucht: T6.5
  - Saison-Leaderboards mit Reset; optionaler Abstieg nach X Wochen Inaktivität

## Phase 7 – Betrieb

- [ ] **T7.1 Backups** · `Ops` · braucht: T1.1
  - Tägliches SQLite-Online-Backup nach `/data/backups`, Rotation (z. B. 14 Stück)

- [ ] **T7.2 DSGVO-Funktionen** · `Backend` · braucht: T4.2
  - Alle Daten einer UID exportieren (JSON) oder löschen

- [ ] **T7.3 Windows-Dienst & Doku** · `Ops` · braucht: T3.1
  - NSSM-Einrichtung, Logs, Update-Ablauf, Allowlist-Eintrag, GeoLite2-Update in `/docs` beschreiben

- [ ] **T7.4 Channel-Statistik** · `Backend` `Frontend` · braucht: T3.2
  - Nutzung pro Channel, ungenutzte Channels der letzten X Tage

## Phase 8 – Import historischer Daten

Ziel: Historie aus mehreren GB alter TS3-Serverlogs und der Datenbank des bisherigen Rankingsystems übernehmen, ohne Doppelzählung und ohne Klar-IPs zu speichern. Importe laufen als eigene CLI-Befehle, nicht im Bot-Prozess.

- [ ] **T8.1 Log-Format-Analyse** · `Watcher` · braucht: T0.1
  - Beispiel-Logs aus `/data/import/samples` untersuchen, alle relevanten Ereignisse erfassen (Connect, Disconnect inkl. Grund, Serverstart/-stopp, Bans, Gruppenänderungen)
  - Ergebnis: `/docs/import-logs.md` mit Zeilenformaten, Regex je Ereignis, Sonderfällen und einer Liste, was die Logs **nicht** enthalten (z. B. Channelwechsel, Idle)
  - Fertig wenn: das Dokument deckt alle Zeilentypen der Samples ab; unbekannte Zeilen sind aufgelistet

- [ ] **T8.2 Schema-Erweiterung Import** · `DB` · braucht: T1.1, T6.1
  - `sessions.source` (`live` / `import`), Aktivitätszustand `unknown` für importierte Zeiten
  - Tabelle `import_runs` (Quelle, Datei, Byte-Offset, Status, Zähler) für Fortsetzen und Idempotenz
  - `users.legacy_seconds`, `users.legacy_rank`, globale Einstellung `legacy_cutoff` (Zeitpunkt der Umstellung)

- [ ] **T8.3 DB-ID → UID-Mapping** · `DB` · braucht: T8.2
  - Logs enthalten nur Client-DB-IDs. Mapping aus einer **Kopie** von `ts3server.sqlitedb` (Tabelle `clients`) lesen, Fallback `clientdblist` per Query
  - Nicht auflösbare DB-IDs als Platzhalter-User anlegen (später verknüpfbar über T5.3)
  - Fertig wenn: Test mit Beispiel-DB; Bericht über Anzahl nicht auflösbarer IDs

- [ ] **T8.4 Streaming-Log-Parser** · `Watcher` · braucht: T8.1
  - Reine Parser-Funktion pro Zeile plus Datei-Reader, der zeilenweise streamt (kein Laden ganzer Dateien), Dateien chronologisch sortiert, Encoding-Fehler toleriert
  - Fertig wenn: Unit-Tests für jeden Zeilentyp aus T8.1; ein Test mit 1 Mio. generierten Zeilen bleibt unter 200 MB RAM

- [ ] **T8.5 Session-Rekonstruktion** · `Watcher` · braucht: T8.4
  - Reine Funktion in `/domain`: Connect/Disconnect paaren
  - Sonderfälle: Serverneustart oder -absturz schließt alle offenen Sessions (am letzten Log-Zeitstempel davor), doppelter Connect, Disconnect ohne Connect, konfigurierbare Maximaldauer einer Session
  - Fertig wenn: Tests für alle Sonderfälle; jede verworfene oder gekappte Session wird mit Grund gezählt

- [ ] **T8.6 Import-CLI für Logs** · `Watcher` `DB` · braucht: T8.3, T8.5, T2.5
  - `pnpm import:logs <ordner> [--dry-run] [--from] [--to]`
  - Ausgelegt auf mindestens 5 Jahre Logs im Umfang mehrerer GB
  - Nur Logs des relevanten virtuellen Servers verarbeiten; Dateien nach Zeitstempel im Dateinamen sortieren
  - Schneller Vorfilter per String-Suche (nur relevante Zeilentypen), Regex erst danach
  - Bulk-Modus: eigene Verbindung mit `synchronous=OFF`, großen Transaktionen (z. B. 50.000 Zeilen), Sekundärindizes der Importtabellen erst nach dem Laden anlegen, anschließend `ANALYZE`
  - Import läuft bei gestopptem Bot oder in eine separate DB-Datei, die danach übernommen wird
  - Fortschrittsanzeige (Dateien, Zeilen/s, geschätzte Restzeit), fortsetzbar über `import_runs`, erneuter Lauf erzeugt keine Duplikate
  - Nur Zeiten **vor** `legacy_cutoff` bzw. vor dem ersten Live-Tracking importieren
  - IPs mit derselben HMAC-Funktion wie T2.5 verarbeiten; nur Einträge innerhalb der IP-Aufbewahrungsfrist übernehmen
  - Dry-Run gibt einen Bericht aus: Zeitraum, Sessions, Nutzer, verworfene Zeilen, nicht auflösbare IDs
  - Fertig wenn: Testlauf auf Samples ist idempotent; Klar-IP-Suche in der DB findet nichts; synthetischer Test mit 5 GB generierter Logzeilen läuft mit konstantem Speicherverbrauch durch und der Durchsatz ist in `/docs/performance.md` dokumentiert

- [ ] **T8.7 Historische Aggregation** · `DB` · braucht: T8.6, T1.3
  - Nach dem Import `pnpm stats:rebuild` für den Importzeitraum: importierte Sessions landen in `user_daily_stats` als `online_s` und `unknown_s`, `server_hourly` wird aus Session-Überlappungen berechnet
  - Frontend kennzeichnet Zeiträume mit Importdaten („nur Online-Zeit, keine Aktivitätsdaten“); Leaderboards „aktiv“ weisen darauf hin, dass sie erst ab Live-Tracking gelten
  - Fertig wenn: Benchmark aus T1.4 bleibt mit den echten Importdaten im Budget

- [ ] **T8.8 Analyse Alt-Ranking-DB** · `DB` · braucht: T0.1
  - Die Alt-DB ist SQLite. Eine Kopie unter `/data/import` mit `sqlite3` bzw. `better-sqlite3` read-only öffnen, Schema, Tabellen und Beispielwerte untersuchen; Bedeutung der Felder klären (Zeit online/aktiv, Einheit, Rang, Gruppen-IDs, Zeitstempel, UID oder DB-ID)
  - Ergebnis: `/docs/import-legacy-ranking.md` mit Feld-Mapping auf das neue Schema

- [ ] **T8.9 Import-CLI Alt-Ranking** · `DB` `Backend` · braucht: T8.8, T8.2
  - `pnpm import:ranking <pfad> [--dry-run]`
  - Pro UID `legacy_seconds` und `legacy_rank` setzen; `legacy_cutoff` festlegen
  - Rang-Engine (T6.2) rechnet: `legacy_seconds` + live erfasste Zeit **nach** dem Cutoff. Aus Logs importierte Zeit fließt nur in Statistiken, nicht in Ränge → keine Doppelzählung
  - Alte Rang-Gruppen-IDs den neuen Rängen zuordnen (Mapping-Datei), damit beim ersten Rang-Lauf niemand unerwartet absteigt

- [ ] **T8.10 Plausibilitätsbericht** · `Backend` `Frontend` · braucht: T8.7, T8.9
  - Pro Nutzer Vergleich: Zeit laut Logs vs. Zeit laut Alt-Ranking; größte Abweichungen zuerst
  - Admin kann pro Nutzer entscheiden, welcher Wert gilt (landet im Audit-Log)

---

## Gefundene Punkte

Hier tragen Agents Auffälligkeiten ein, die nicht zur aktuellen Aufgabe gehören.

- (T0.1) Auf dem Entwicklungsrechner ist pnpm nicht global installiert; aktuell per `corepack pnpm …` genutzt (Version über `packageManager` in package.json fixiert). Lokal läuft Node 24, Zielumgebung ist Node 22 LTS – `engines` steht auf `>=22`, `@types/node` auf 22.
