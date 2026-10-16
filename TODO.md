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

- [x] **T0.2 Config-Modul** · `Setup` · braucht: T0.1
  - `.env` laden und mit zod validieren; `.env.example` anlegen
  - Werte: TS3-Host, SSH-Query-Port, Query-User/-Passwort, virtuelle Server-ID, Bot-Nickname, HMAC-Secret, Web-Host/-Port, Pfad GeoIP-DB, Pfad SQLite, IP-Aufbewahrung (Tage, Standard 90), Query-Rate-Limit
  - Fertig wenn: fehlendes oder zu kurzes HMAC-Secret (< 32 Zeichen) bricht den Start mit klarer Meldung ab; Tests für gültige und ungültige Config
  - Notiz: `src/config/config.ts` – `parseConfig(env)` (rein, zod 4) und `loadConfig()` (liest `.env` per `node:util.parseEnv`, kein dotenv; echte Umgebungsvariablen haben Vorrang, fehlende `.env` ist ok). Ergebnis ist ein verschachteltes, eingefrorenes `Config`-Objekt (`ts3`, `security`, `web`, `paths`, `retention`). Leere Werte (`KEY=`) gelten als nicht gesetzt. `ConfigError` listet alle Probleme auf einmal und nennt nur Variablennamen, nie Werte (keine Secret-Leaks). `WEB_HOST` akzeptiert nur Loopback (`127.0.0.1`, `::1`, `localhost`) gemäß Regel 8 – muss gelockert werden, sobald eine Aufgabe Fernzugriff vorsieht. Pflicht: `TS3_QUERY_USER`, `TS3_QUERY_PASSWORD`, `HMAC_SECRET`. `pnpm start` braucht damit eine gültige `.env`. Log-Level folgt in T0.3, SQLite-`cache_size`/`mmap_size` in T1.1.

- [x] **T0.3 Logging** · `Setup` · braucht: T0.2
  - pino mit Konsolen- und Dateiausgabe, tägliche Rotation, Log-Level aus Config
  - Redaction für Passwörter, Secrets und IP-Felder
  - Fertig wenn: ein Test belegt, dass ein Feld `ip` oder `password` im Log redacted erscheint
  - Notiz: `src/logging/logger.ts` (neuer Ordner `/src/logging`). `createLogger(config.logging)` schreibt über pino-Transports (Worker-Thread) auf die Konsole (pino-pretty bei TTY bzw. `LOG_PRETTY=true`, sonst JSON) und in `LOG_DIR/ts3-analytics.<yyyy-MM-dd>.<n>.log` (pino-roll, täglich, `LOG_RETENTION_DAYS` Dateien, `removeOtherLogFiles` damit auch nach Neustarts aufgeräumt wird). Zeitstempel ISO/UTC. Doppelte Absicherung für Regel 1/2: (a) pino-`redact` für Schlüssel wie `password`, `secret`, `hmacSecret`, `token`, `cookie`, `ip`, `connection_client_ip`, `remoteAddress` bis 3 Ebenen tief (`REDACTED_KEYS`); (b) `scrubIps()` ersetzt IPv4/IPv6-Adressen in Meldungstexten, Format-Argumenten, String-Feldern und Error-Message/-Stack durch `[IP]` (Kandidaten per Regex, Prüfung mit `net.isIP`). Einschränkung: vierteilige Versionsnummern wie `1.2.3.4` werden ebenfalls maskiert. `createStreamLogger()` für Tests/Tools. Neue Config: `LOG_LEVEL`, `LOG_DIR`, `LOG_RETENTION_DAYS`, `LOG_PRETTY`.

## Phase 1 – Datenbank

- [x] **T1.1 Schema & Migrationen** · `DB` · braucht: T0.2
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
  - Notiz: Schema in `src/db/schema.ts`, Verbindung/Migration in `src/db/client.ts` (`openDatabase`, `runMigrations`, läuft beim Start). Migration `drizzle/0000_init.sql` von drizzle-kit erzeugt und von Hand um `STRICT`, `WITHOUT ROWID` (`user_daily_stats`, `ip_seen`, `settings`) und FTS5 (`nicknames_fts`, Trigram-Tokenizer, externe Content-Tabelle + 3 Trigger) ergänzt; `schema.test.ts` sichert ab, dass DB und Drizzle-Schema übereinstimmen. Ablauf für Schemaänderungen in `docs/database.md`. Entscheidungen: `day` = YYYYMMDD (Berlin) als Integer; Segment-Spalten `start_at`/`end_at` statt `start`/`end`; zusätzlich `activity_segments.session_id` und `is_open` (offene Segmente werden periodisch geflusht, T2.3/T2.4); `ip_seen` = (user_id, ip_hash BLOB, subnet_hash BLOB, country, first_seen, last_seen, seen_count); `settings` = (key, value JSON, updated_at); CHECK-Constraints für `source`, `state`, Zeitbereiche. `sessions.source` existiert damit bereits (T8.2 muss nur noch `import_runs`/Legacy-Felder ergänzen). better-sqlite3 auf `^12.11` gepinnt: v13 liefert keine Prebuilds und bräuchte Visual-Studio-Build-Tools inkl. Windows SDK. Neue Config: `SQLITE_CACHE_SIZE_MB`, `SQLITE_MMAP_SIZE_MB`; `paths.sqlite` → `database.path`. Scripts: `db:generate`, `db:check`.

- [x] **T1.2 Repository-Layer** · `DB` · braucht: T1.1
  - Typisierte Funktionen für alle Schreib- und Lesezugriffe des Watchers
  - Fertig wenn: Tests mit In-Memory-SQLite decken Upsert User, Nick-Wechsel, Session öffnen/schließen, Segment verlängern/abschließen ab
  - Notiz: `src/db/repositories/` (Export über `index.ts`). Alle Funktionen nehmen `DbExecutor` (DB oder Transaktion) als ersten Parameter und explizite Zeitpunkte → Aufrufer bündeln Schreibvorgänge per `db.transaction((tx) => …)`. Enthalten: `upsertUser` (per UID, `first_seen`/`last_seen` nur erweiternd, unbekannte Felder behalten alten Wert), `recordNickname`/`getNicknames`/`getCurrentNickname`, `upsertChannels`, `openSession`/`closeSession` (klemmt `leave_at` ≥ `join_at`, gibt `ClosedSession` für die Aggregation zurück)/`getOpenSessions`, `openSegment`/`extendSegments` (nie verkürzend)/`closeSegment`/`getOpenSegments`, `getSetting` (zod-validiert, `InvalidSettingError`)/`setSetting`, `recordServerMinute`, `upsertIpSeen`. Test-Helfer `createTestDatabase()` in `src/db/testing.ts`. Achtung: Drizzle typisiert `.returning().get()` als immer vorhanden – bei UPDATE ohne Treffer ist es `undefined`, daher explizit `as T | undefined`.

- [x] **T1.3 Aggregations-Layer** · `DB` · braucht: T1.2
  - Funktionen, die beim Abschließen von Sessions und Segmenten `user_daily_stats`, `user_totals` und `server_hourly` inkrementell fortschreiben (Segmente über Mitternacht korrekt auf zwei Tage aufteilen, Tagesgrenze in `Europe/Berlin`)
  - Zusätzlich ein Befehl `pnpm stats:rebuild [--from] [--to]`, der alle Aggregate aus Sessions und Segmenten neu berechnet
  - Fertig wenn: Tests belegen, dass inkrementelle Fortschreibung und Rebuild identische Ergebnisse liefern (inkl. Sommer-/Winterzeitwechsel)
  - Notiz: Reine Regeln in `src/domain/time.ts` (Berlin-Kalender ohne Library, Offset-Cache pro UTC-Stunde) und `src/domain/aggregation.ts`; DB-Teil in `src/db/aggregates.ts`. Watcher muss Sessions/Segmente über `finalizeSession`/`finalizeSegment` schließen (nicht direkt über das Repository), sonst fehlen sie in den Aggregaten. Beide Pfade nutzen dieselben Funktionen; Test mit 3 Zufallsszenarien (DST-Tage, Mitternacht, Importe, Null-Längen, Überlappungen, zufällige Schließreihenfolge) plus Bereichs-Rebuild. **Schemaänderung (Migration 0001):** `server_hourly.avg_online` (REAL) → `online_s` (INTEGER, Summe Session-Sekunden; Ø = `online_s/3600`), damit inkrementell und Rebuild bitgenau gleich sind; neuer Index `sessions_leave_idx`. `max_online` = max. gleichzeitige Sessions (nicht Nutzer), aus Sessions berechnet (nicht aus `server_minutely`, das nach 14 Tagen gelöscht wird). Offene Sessions/Segmente zählen erst ab dem Schließen – sehr lange Sessions tauchen also erst beim Leave in den Tageswerten auf (API muss laufende Sessions für „heute“ ggf. addieren). CLI `pnpm stats:rebuild [--from] [--to]` (`src/cli/stats-rebuild.ts`); `loadConfigOrExit()` für Entry-Points. drizzle-kit fragt bei Spalten-Umbenennung interaktiv → in Nicht-TTY-Umgebungen in zwei Schritten generieren und zusammenführen (siehe Commit).

- [x] **T1.4 Testdaten-Generator & Performance-Budget** · `DB` · braucht: T1.3
  - `pnpm seed:synthetic` erzeugt 6 Jahre Daten: ca. 500 Stammnutzer mit regelmäßigen Sessions, ca. 8.000 Gelegenheitsnutzer mit wenigen Sessions, realistische Tageszeiten
  - Benchmark-Script misst die Kernabfragen (Leaderboards aller Zeiträume, Nutzerdetail, Dashboard 30 Tage/1 Jahr/gesamt, Suche)
  - Fertig wenn: jede Kernabfrage < 100 ms; Ergebnis in `/docs/performance.md`. Spätere Tasks, die Abfragen ändern, führen den Benchmark erneut aus
  - Notiz: Generator `src/db/synthetic.ts` + CLI `pnpm seed:synthetic` (schreibt nur in `data/synthetic.sqlite`, überschreibt nur mit `--force`). Kernabfragen als wiederverwendbares Modul `src/db/queries/stats.ts` (Leaderboards gesamt/Zeitraum inkl. Paginierung, Nutzerdetail, Kennzahlen, Online-Verlauf mit automatischer Auflösung ≤ 1000 Punkte, Heatmap Wochentag × Stunde in Berliner Zeit, Suche per Trigram-FTS/Präfix/UID) – T3.2 muss sie nur noch an Routen hängen. `pnpm bench` misst alle 20 Abfragen: alle < 25 ms (p95) auf i9-14900K, Details in `docs/performance.md`. Dabei gefunden und behoben: Rebuild 240 s → 15,5 s (korrelierte Unterabfrage im Totals-INSERT). Offen: Benchmark auf dem Zielserver wiederholen (voraussichtlich langsamer).

## Phase 2 – Watcher

- [x] **T2.1 TS3-Adapter & Verbindung** · `Watcher` · braucht: T0.3
  - Interface `Ts3Adapter` mit echter Implementierung (`ts3-nodejs-library`, SSH-Query) und Fake für Tests
  - Reconnect mit exponentiellem Backoff, Keepalive, zentrale Befehls-Queue mit Rate-Limit
  - Fertig wenn: Verbindungsabbruch im Fake führt zu Reconnect; Queue hält das Limit nachweislich ein (Test)
  - Notiz: `src/ts3/`: `Ts3Transport`-Interface (eine physische Verbindung) mit `RealTs3Transport` (ts3-nodejs-library, SSH, `useBySid` + Nickname, Events `server` und `channel 0`) und `FakeTs3Server`/`FakeTs3Transport` (simulierter Server: join/leave/move/update/dropConnection, failConnects, failPing, Befehlsprotokoll mit Zeitstempeln). `CommandQueue`: seriell, max. `floor(TS3_QUERY_RATE_LIMIT)` Starts pro gleitendem 1-s-Fenster (bei < 1/s entsprechend längeres Fenster), `clear()` verwirft wartende Befehle. `Ts3Connection`: Reconnect mit exponentiellem Backoff (1 s → max. 60 s, 20 % Jitter, Reset nach Erfolg), eigener Keepalive (`whoami` alle 60 s über die Queue; Fehlschlag erzwingt Reconnect), filtert Query-Clients (Regel 4), alle Befehle über `connection.command()`/Queue. Die Bibliotheks-eigenen Keepalives sind aus, `ignoreQueries` an. `Ts3Client` enthält bewusst keine IP (die Library liefert sie bei `clientlist` mit; wird beim Mapping verworfen) – T2.5 holt sie gezielt. main.ts startet die Verbindung und fährt bei SIGINT/SIGTERM sauber herunter. Wichtig: Die Library führt bei jedem Join intern ein komplettes `clientlist` (inkl. IPs) und bei jedem Move `clientlist`+`channellist` aus – an der Queue vorbei. `attachNotificationHandlers()` ersetzt diese Handler durch eigene, die nur die Notification-Daten nutzen (Test belegt: keine Zusatzbefehle). Keine High-Level-Events der Library abonnieren (`teamspeak.on('clientconnect')` o. ä.), sonst registriert/fetcht sie selbst. Belegter Bot-Nickname: siehe T2.10. ssh2/cpu-features-Buildskripte bewusst deaktiviert (reines JS reicht).

- [x] **T2.2 Event-Tracking** · `Watcher` · braucht: T1.2, T2.1
  - Join, Leave und Channelwechsel verarbeiten → Users, Nicknames, Sessions
  - Query-Clients ignorieren
  - Fertig wenn: Test-Szenario (Join → Move → Nickwechsel → Leave) im Fake erzeugt korrekte DB-Einträge
  - Notiz: `src/watcher/tracker.ts` (`SessionTracker`: clid → OnlineClient; join = User-Upsert + Nick + Session in einer Transaktion, leave = `finalizeSession` inkl. Aggregate, move = Channel im Speicher; Listener-Hooks `onJoined`/`onMoved`/`onLeaving` für T2.3/T2.5) und `src/watcher/watcher.ts` (verdrahtet `Ts3Connection`-Events, Sync bei jedem (Re-)Connect: Channelnamen + Clientliste). Nickwechsel meldet TS3 der Query nicht als Event → Erkennung über `sync()` (T2.3 ruft das bei jedem Poll). Sessions von Clients, die während eines Query-Verbindungsausfalls gegangen sind, enden zum Zeitpunkt des Verbindungsverlusts (nicht beim Reconnect). Race-Schutz: Clients mit Events während des Abrufs der Clientliste werden beim Abgleich übersprungen (Test schlägt ohne Fix fehl). Wiederverwendete clid mit anderer UID = alter Client weg, neuer da. Beim Herunterfahren werden alle offenen Sessions geschlossen (Sessions werden beim Neustart also getrennt; T2.4 behandelt Abstürze). `FakeTs3Server.afterSnapshot` simuliert Races.

- [x] **T2.3 Aktivitäts-Polling** · `Watcher` · braucht: T2.2, T1.3
  - Alle 60 s (konfigurierbar) `clientlist` mit uid, times, groups, voice, away abfragen
  - Pro Client den Zustand bestimmen (Idle-Zeit, Away-Status, AFK-Channel). Bleiben Zustand und Channel gleich, wird das offene `activity_segment` nur verlängert; ändert sich etwas, wird es abgeschlossen (→ Aggregate fortschreiben) und ein neues begonnen
  - Offene Segmente im Speicher halten und höchstens alle paar Minuten gesammelt in einer Transaktion schreiben
  - Einen Wert in `server_minutely` schreiben
  - Idle-Schwelle und AFK-Channel-IDs aus `settings`
  - Fertig wenn: Tests für die Zustandsbestimmung (active/idle/afk) als reine Funktion in `/domain`
  - Notiz: `determineState()` in `src/domain/activity.ts`: afk (AFK-Channel, Away-Status, Lautsprecher stumm – letztere zwei abschaltbar) > idle (`client_idle_time` ≥ Schwelle, Standard 600 s) > active; Mikro-Stumm zählt nicht. Einstellungen in `settings['activity']` (`src/watcher/settings.ts`, zod mit Defaults, werden bei jedem Poll gelesen). `ActivityTracker` (`src/watcher/activity.ts`) hängt als Listener am `SessionTracker`: Join/Move/Leave zwischen Polls wirken sofort (Move splittet zum Move-Zeitpunkt), Polls verlängern bzw. splitten zum Poll-Zeitpunkt. Segmente liegen im Speicher und werden alle `SEGMENT_FLUSH_INTERVAL_S` (300 s) und beim Stop in einer Transaktion geschrieben: offene als `is_open=1` (für T2.4), abgeschlossene via `finalizeSegment`/`recordClosedSegment` inkl. Aggregate. Test belegt: Segmente decken die Session lückenlos ab. Poll (`Watcher.sync`, alle `POLL_INTERVAL_S`=60 s + bei Reconnect) = channellist + clientlist → Channels, Sessions/Nicks, Segmente, `server_minutely`. Unbekannte Channel-IDs bekommen Platzhalter „Channel <id>“ (FK). Einschränkung: Zustandswechsel werden auf Poll-Genauigkeit (±60 s) erfasst; Idle-Beginn könnte später aus `client_idle_time` zurückdatiert werden. Bei Absturz gehen max. 5 min Segmentdaten verloren (Sessions nicht).

- [x] **T2.4 Crash-Recovery** · `Watcher` · braucht: T2.3
  - Heartbeat-Timestamp in `settings`; beim Start offene Sessions am letzten Heartbeat schließen und mit aktueller `clientlist` neu eröffnen
  - Fertig wenn: simulierter Absturz im Test hinterlässt keine unendlich offenen Sessions
  - Notiz: `src/watcher/recovery.ts`. Heartbeat (`settings['watcher.heartbeat']`) wird nach jedem erfolgreichen Poll geschrieben – während eines Query-Ausfalls also nicht (dann gilt der letzte verlässliche Stand). `recoverOpenSessions()` läuft in `Watcher.start()` vor allem anderen: offene Segmente enden am Heartbeat (nie vor ihrem bisherigen `end_at`, d. h. Zustand der letzten ≤ 5 min wird fortgeschrieben), offene Sessions am Heartbeat bzw. am letzten Segmentende; ohne Heartbeat am letzten bekannten Zeitpunkt. Alles über `finalizeSession`/`finalizeSegment` → Aggregate konsistent (Test vergleicht mit Rebuild). Noch online befindliche Clients bekommen per normalem Sync eine neue Session (Sessions werden bei Absturz/Neustart also geteilt). Neue Watcher-Option `autoPoll` (Tests).

- [x] **T2.5 IP-Verarbeitung** · `Watcher` `Security` · braucht: T2.2
  - Beim Join `connection_client_ip` per `clientinfo` holen, Land per GeoLite2 bestimmen, dann HMAC der vollen IP und des Subnetzes (/24, /64); `ip_seen` upserten
  - Klar-IP nur in einer lokalen Variable, nie persistiert oder geloggt
  - Fertig wenn: Tests für IPv4 und IPv6, gleiche IP → gleicher Hash, gleiches Subnetz → gleicher Subnetz-Hash; ein Test durchsucht die DB nach der Klar-IP und findet nichts
  - Notiz: `src/domain/ip.ts`: `normalizeIp` (IPv6 voll ausgeschrieben/kleingeschrieben, Zonen-ID entfernt, IPv4-mapped → IPv4, Subnetz /24 bzw. /64) und `hashIp` (HMAC-SHA256 mit `HMAC_SECRET`, Präfixe `ip:`/`net:` trennen die Hash-Räume). `src/geoip/country-lookup.ts`: MaxMind-Reader mit `watchForUpdates` (GeoLite2-Update ohne Neustart); fehlende/defekte `.mmdb` → Warnung, Dienst läuft ohne Länder. `IpProcessor` (Listener am SessionTracker) holt beim Join `clientinfo` über die Queue, schreibt `ip_seen` und `users.country`. Test durchsucht alle Tabellen (inkl. FTS-Schattentabellen, Text und BLOB-Bytes) und die komplette Log-Ausgabe (Level trace) nach allen Klar-IPs; per Mutation geprüft, dass ein DB-Leck erkannt wird (ein Log-Leck maskiert der Logger bereits selbst). `Ts3Transport.clientIp()` neu. Hinweis: Beim Start mit N Online-Clients entstehen N `clientinfo`-Befehle (bei 5/s z. B. 200 Clients ≈ 40 s Queue); Optimierung möglich über ein einzelnes `clientlist -ip` beim Sync. `main` ist jetzt async (GeoIP wird beim Start geladen).

- [x] **T2.6 Retention & Wartung** · `Watcher` `DB` · braucht: T2.5, T1.3
  - Täglicher Job: `ip_seen` älter als Aufbewahrungsfrist löschen; `server_minutely` älter als 14 Tage löschen (steckt dann in `server_hourly`)
  - `activity_segments` älter als X Monate optional löschen (Standard: behalten; konfigurierbar). Tages- und Gesamtaggregate bleiben immer erhalten
  - Wöchentlich `PRAGMA optimize` und `wal_checkpoint(TRUNCATE)`
  - Fertig wenn: Tests belegen Löschung ohne Veränderung der Aggregate
  - Notiz: `src/jobs/runner.ts` (`JobRunner`: prüft alle 10 min, letzte Läufe in `settings['jobs.<name>.lastRun']`, übersteht Neustarts; fehlgeschlagene Jobs werden geloggt und erst im nächsten Intervall wiederholt) und `src/jobs/retention.ts`: täglich `ip_seen` (`last_seen` älter als `IP_RETENTION_DAYS`), `server_minutely` > 14 Tage (in 10k-Blöcken), optional abgeschlossene Segmente älter als `SEGMENT_RETENTION_MONTHS` (Standard 0 = behalten); wöchentlich `PRAGMA optimize` + `wal_checkpoint(TRUNCATE)`. Beim Segment-Löschen wird `retention.segmentsPrunedBefore` gesetzt; `rebuildAggregates` wirft dann `PrunedRangeError` für Zeiträume davor (sonst fiele `active_s` dort auf 0), `stats:rebuild` startet ohne `--from` automatisch danach, `--force` erzwingt. Beide Jobs laufen direkt beim Start, wenn fällig.

- [x] **T2.7 Sessions über kurze Neustarts fortführen** · `Watcher` · braucht: T2.4
  - Bei sauberem Stop bleiben Sessions offen (Segmente geschrieben, Heartbeat gesetzt). Liegt der letzte Heartbeat beim Start höchstens `SESSION_RESUME_GRACE_S` (Standard 300 s) zurück, werden offene Sessions beim ersten Sync per UID den noch verbundenen Clients zugeordnet und laufen weiter; alle anderen enden am Heartbeat
  - Fertig wenn: Tests für kurzen Neustart, langen Neustart und verspätet erreichbaren TS3-Server
  - Notiz: `recoverOpenSessions` liefert bei kurzem Neustart Kandidaten, `resolveResume` entscheidet beim ersten Sync (kommt der erst nach Ablauf der Frist, wird nichts fortgesetzt). Alte offene Segmente fortgesetzter Sessions enden beim Resume (Zustand während der Downtime wird als unverändert angenommen), danach beginnt ein neues Segment (`onResumed`). Gilt auch nach Absturz (Heartbeat ≤ 60 s alt). `SESSION_RESUME_GRACE_S=0` = altes Verhalten (Stop schließt alles). Nebenbei: `users.last_seen` wird jetzt auch beim Leave aktualisiert (vorher nur beim Join). Verlässt jemand während der Downtime den Server, endet seine Session am letzten Heartbeat.

- [x] **T2.8 Idle-Beginn zurückdatieren** · `Watcher` · braucht: T2.3
  - Wechsel aktiv → idle nicht auf den Poll-Zeitpunkt legen, sondern auf `jetzt − client_idle_time + Idle-Schwelle` (nie vor Segmentbeginn/letztem Poll); idle → aktiv analog auf `jetzt − client_idle_time`
  - Fertig wenn: Tests zeigen minutengenaue statt poll-genaue Übergänge; Segmente decken die Session weiterhin lückenlos ab
  - Notiz: Reine Funktion `transitionTime()` in `src/domain/activity.ts`; nur bei Poll-Beobachtungen ohne Channelwechsel angewendet, begrenzt auf `[letzte Beobachtung, Poll]`. Übergänge von/zu AFK bleiben am Poll-Zeitpunkt (kein Zeitstempel verfügbar). Ergebnis sekundengenau (Test).

- [x] **T2.9 IPs beim Start gebündelt holen** · `Watcher` `Security` · braucht: T2.5
  - Beim (Re-)Connect-Sync die IPs aller Clients mit einem `clientlist -ip` holen statt N × `clientinfo`; Einzel-Joins weiter per `clientinfo`
  - Klar-IPs weiterhin nur lokal (Regel 1); Test zählt die Query-Befehle beim Start
  - Notiz: `Ts3Transport.clientIps()` (`clientlist -ip`). `IpProcessor.beginBatch/endBatch` umklammert `tracker.sync()` im Watcher: ≥ 2 dort entdeckte Clients → ein Befehl, 1 Client → `clientinfo`, Events außerhalb → `clientinfo`. Die IP-Map lebt nur innerhalb von `processMany` und wird danach geleert.

- [x] **T2.10 Bot-Nickname-Kollision** · `Watcher` · braucht: T2.1
  - Ist der Nickname belegt (Fehler 513), mit Suffix erneut versuchen (z. B. `TS3 Analytics (2)`), statt in den Backoff zu laufen
  - Notiz: `src/ts3/nickname.ts` (`useWithFreeNickname`, max. 10 Versuche, Basis wird gekürzt, damit der Suffix in 30 Zeichen passt). Andere Fehler (z. B. fehlende Rechte) gehen unverändert in den Backoff. Verwendeter Alternativname wird als Warnung geloggt.

## Phase 3 – API & Webinterface (lokal)

- [x] **T3.1 Fastify-Server** · `Backend` · braucht: T1.2
  - Bindet an `127.0.0.1`, liefert das gebaute Frontend aus, einheitliches Fehlerformat, zod-Validierung
  - Fertig wenn: `/api/health` antwortet mit Status von DB und Query-Verbindung
  - Notiz: `src/api/server.ts` (`buildServer` für Tests via `inject`, `startServer` bindet an `WEB_HOST`, das per Config nur Loopback erlaubt), Routen unter `/api` als Plugins mit `ApiContext` (`src/api/context.ts`). zod über `fastify-type-provider-zod` (Validierung + Response-Serialisierung). Einheitliches Fehlerformat `{ error: { code, message, details? } }` (`src/api/errors.ts`, `ApiError` für erwartete Fehler; 500 ohne Interna). `GET /api/health`: `ok` / `degraded` (TS3 nicht verbunden) mit 200, `down` (DB) mit 503. Frontend aus `web/dist` (wenn vorhanden) mit SPA-Fallback, API-404 bleibt JSON. Sicherheits-Header (nosniff, DENY, no-referrer). Request-Logs nur auf debug. Codes statt deutscher Texte in der API; Übersetzung im Frontend.

- [x] **T3.2 Statistik-Endpunkte** · `Backend` · braucht: T3.1, T2.3
  - Übersicht (online jetzt, Peak heute/Allzeit, Nutzer gesamt/neu), Online-Verlauf, Heatmap Wochentag × Stunde
  - Nutzerliste (Suche, Paginierung, Sortierung), Nutzerdetail (Spielzeit gesamt/aktiv, Sessions, Top-Channels, Nickverlauf, Länder)
  - Leaderboards: gesamt, aktiv, Woche, Monat, Jahr, frei wählbarer Zeitraum, längste Session
  - Alle Abfragen lesen aus `user_totals`, `user_daily_stats` und `server_hourly`, nie aus Rohdaten über lange Zeiträume
  - Zeitreihen werden serverseitig passend zum Zeitraum aufgelöst (Minute / Stunde / Tag / Woche), max. ca. 1.000 Punkte pro Antwort
  - Nutzerliste standardmäßig gefiltert auf Nutzer mit Mindestspielzeit (Gelegenheitsnutzer per Schalter einblendbar); Suche über FTS5 auf Nicknames und UID
  - Fertig wenn: Tests mit Seed-Daten prüfen die Berechnungen; Benchmark aus T1.4 bleibt im Budget
  - Notiz: Routen in `src/api/routes/` (`stats.ts`, `users.ts`, `leaderboards.ts`), gemeinsame Schemas in `src/api/schemas.ts`, Zeiträume als reine Funktionen in `src/domain/periods.ts`. Endpunkte: `GET /api/stats/overview|online|heatmap?range=24h|7d|30d|1y|all` (online auch mit `from`/`to` in Unix-Sekunden), `GET /api/users?search&sort=online|active|sessions|lastSeen|firstSeen|nickname&order&page&pageSize&includeCasual`, `GET /api/users/:id?days=`, `GET /api/leaderboards?period=all|week|month|year|custom&metric=online|active|longestSession&from&to&page&pageSize` (from/to als YYYY-MM-DD). Entscheidungen: Woche/Monat/Jahr rollierend (7/30/365 Tage inkl. heute); „Gelegenheitsnutzer“ = < 1 h Gesamtzeit (`CASUAL_THRESHOLD_S`); „Peak heute“ und „online jetzt“ berücksichtigen Live-Werte (offene Sessions, `server_minutely`), da Stundenaggregate erst beim Leave entstehen. `onlineSeries` fällt auf Stundenwerte zurück, wenn Minutenwerte den Zeitraum nicht abdecken (älter als 14 Tage), und liefert die tatsächliche Auflösung. Response-Schemas werden beim Serialisieren validiert. Benchmark erneut gelaufen, alles < 35 ms (docs/performance.md).

- [x] **T3.3 Frontend-Grundgerüst** · `Frontend` · braucht: T0.1
  - Vite + React + TS, Router, Layout mit Navigation, Hell/Dunkel-Modus, API-Client, Übersetzungsdatei (de)
  - Fertig wenn: leere Seiten Dashboard, Spieler, Leaderboards sind erreichbar
  - Notiz: `web/` ist ein eigenes Paket im pnpm-Workspace (Vite 8, React 19, React Router 8, TS strict). Routen deutsch: `/`, `/spieler`, `/spieler/:id`, `/leaderboards` (+ 404/Fehlerseite), Layout mit Navigation, TS3-Statusanzeige (`/api/health`, alle 30 s) und Hell/Dunkel (System-Standard, Wahl in localStorage, vor dem ersten Render gesetzt). UI-Texte ausschließlich in `web/src/i18n/de.ts` (`t()`, Formatierer für Dauer/Datum in Europe/Berlin). API-Client `web/src/api/client.ts` übersetzt Fehler-Codes. API-Typen `web/src/api/types.ts` ohne Abhängigkeiten; `src/api/contract.test.ts` prüft beim Typecheck exakte Gleichheit mit den zod-Schemas (per Mutation geprüft). Keine UI-Bibliothek, eigenes CSS mit Design-Tokens, responsiv. Root-Scripts decken beide Teile ab (`build`, `typecheck`, `test`, `lint`; `dev:web` mit Proxy auf :8080) und rufen Tools direkt auf statt `pnpm --filter`, da pnpm lokal nicht global installiert ist. Frontend-Tests: Vitest + jsdom + Testing Library.

- [x] **T3.4 Dashboard-Seite** · `Frontend` · braucht: T3.2, T3.3
  - Kennzahlen-Kacheln, Online-Verlauf (24 h / 7 Tage / 30 Tage), Heatmap
  - Fertig wenn: Seite zeigt Seed-Daten korrekt und ist auf schmalen Bildschirmen nutzbar
  - Notiz: `web/src/pages/DashboardPage.tsx`: 6 Kennzahlen-Kacheln, Zeitraum-Umschalter (24 h/7 T/30 T) für Kacheln + Verlauf, Liniendiagramm Ø online / max. gleichzeitig (eine Achse, Legende, Fadenkreuz-Tooltip, Berliner Zeit, Auflösungsangabe), Heatmap Wochentag × Stunde mit eigenem Zeitraum (30 T/1 J/gesamt); beide Diagramme zusätzlich als aufklappbare Tabelle. ECharts nur mit benötigten Modulen (`web/src/charts/EChart.tsx`), Optionen als reine Funktionen (`charts/options.ts`), Farben aus der validierten Referenzpalette (hell + dunkel geprüft, `charts/palette.ts`), Charts folgen dem Theme. Mit synthetischen Daten per Edge-Headless-Screenshot geprüft (hell, dunkel, ~500 px). Dabei gefunden und im Backend behoben: Stunden ohne Sessions fehlten im Verlauf (Zeitachse verzerrt) → `onlineSeries` füllt Stunden-/Tages-/Wochen-Buckets mit 0; Wochen-Buckets rechneten fest mit 168 h statt der echten Länge in DST-Wochen. `useApi` leitet `loading` aus dem Anfrageschlüssel ab (kein synchrones setState im Effect). Tests mocken ECharts (jsdom hat kein Canvas).

- [x] **T3.5 Spieler-Seiten** · `Frontend` · braucht: T3.2, T3.3
  - Liste mit Suche; Detailseite mit Spielzeit-Verlauf, Sessions, Channels, Nickverlauf
  - Notiz: `web/src/pages/PlayersPage.tsx`: Suche (300 ms verzögert), Sortierung per Spaltenkopf (aria-sort), Gelegenheitsspieler-Schalter, Paginierung (50/Seite); gesamter Zustand in der URL (`q`, `sort`, `order`, `page`, `casual`). `PlayerPage.tsx`: Kopf mit Online-Status und UID, 6 Kennzahlen, gestapelte Tagesbalken aktiv/idle/AFK/unbekannt (30 Tage/1 Jahr, fehlende Tage als leere Balken, Tabellenansicht), letzte Sessions (laufend/importiert markiert), Top-Channels als Balkenliste, Nickverlauf, Länder mit Hinweis auf IP-Aufbewahrung. Farben: Kategorie-Slots 1–4 der Referenzpalette (validiert; Aqua/Gelb im Hellmodus < 3:1 → Legende + Tabelle). Dauern ab 100 h ohne Minuten. Per Screenshot mit synthetischen Daten geprüft. Nachtrag (auf Wunsch): Die Karte „Wann ist dieser Spieler online?“ zeigt dasselbe Wochentag-×-Stunde-Raster wie das Dashboard, aber je Person – der Wert ist der Anteil der jeweiligen Stunde, in der der Spieler verbunden war (30 Tage / 1 Jahr / gesamt, `GET /api/users/:id/heatmap`). Gezählt werden alle verknüpften Accounts und auch importierte Zeiten; überlappende Accounts werden bei 100 % gekappt. Dashboard und Spielerseite teilen sich dafür jetzt die Komponente `HeatmapCard`. Laufzeit beim aktivsten Nutzer: 1,6 ms für ein Jahr, 6,1 ms für den gesamten Zeitraum.

- [x] **T3.6 Leaderboards-Seite** · `Frontend` · braucht: T3.2, T3.3
  - Tabs für alle Leaderboard-Arten, Link zur Spielerseite
  - Notiz: `web/src/pages/LeaderboardsPage.tsx`: Reiter Gesamt, Aktiv, Woche, Monat, Jahr, Längste Session, Zeitraum (Datumsfelder) als ARIA-Tablist; bei Woche/Monat/Jahr/Zeitraum Umschalter Spielzeit/Aktivzeit; Rang (Podium hervorgehoben), Spieler-Link, Wert + Balken relativ zu Platz 1, ausgewerteter Zeitraum, Paginierung (25). Zustand in der URL mit deutschen Parametern (`art`, `wertung`, `von`, `bis`, `page`). Hinweis bei Aktivzeit, dass diese erst ab Live-Erfassung existiert (T8.7 präzisiert das für Importe). Per Screenshot geprüft.

- [x] **T3.7 „Wer ist gerade online“** · `Backend` `Frontend` · braucht: T3.4, T2.3
  - Liste der aktuell verbundenen Spieler auf dem Dashboard: Nickname (Link zur Spielerseite), Channel, Zustand (aktiv/idle/AFK), online seit
  - Daten live aus dem Watcher (nicht aus den gepufferten Segmenten), Endpunkt `GET /api/online`
  - Fertig wenn: Tests für Endpunkt und Anzeige; ohne Query-Verbindung klarer Hinweis statt veralteter Liste
  - Notiz: `Watcher.liveClients()` (Tracker + aktueller Zustand aus `ActivityTracker.stateOf`), im `ApiContext` als `live`. `GET /api/online` liefert `{ connected, items }` sortiert nach Channel und Nickname; ohne Verbindung `connected: false` und leere Liste. Dashboard-Karte `web/src/components/OnlineNow.tsx`, aktualisiert alle 30 s, Zustand mit Text + Punkt (nicht nur Farbe).

- [x] **T3.8 CSV-Export** · `Backend` `Frontend` · braucht: T3.5, T3.6
  - Export der Spielerliste (mit aktueller Suche/Sortierung/Filter) und der Leaderboards (aktuelle Auswahl) als CSV
  - Excel-freundlich für deutsche Systeme: UTF-8 mit BOM, Semikolon als Trenner, Dauern in Stunden mit Dezimalkomma sowie in Sekunden
  - Fertig wenn: Tests prüfen Inhalt, Escaping (Semikolon, Anführungszeichen, Zeilenumbrüche in Nicknames) und Schutz vor CSV-Formel-Injection
  - Notiz: Reine Funktion `toCsv` in `src/domain/csv.ts` (BOM, `;`, CRLF, Dezimalkomma, Quoting, Zellen mit `= + - @ Tab CR` am Anfang bekommen ein `'`). Endpunkte `GET /api/users/export.csv` (Filter/Sortierung wie Liste, ohne Paginierung) und `GET /api/leaderboards/export.csv` (gleiche Auswahl wie Leaderboard, komplette Rangliste); Spaltenköpfe deutsch in `src/api/csv.ts`; Zeiten als `YYYY-MM-DD HH:MM` Berliner Zeit, Dauern in h und s. Export-Link auf Spieler- und Leaderboard-Seite übernimmt die aktuelle Auswahl.

## Phase 4 – Auth & Admin-Basis

- [x] **T4.1 Login & Rollen** · `Backend` `Security` · braucht: T3.1
  - Tabelle `admin_users`, argon2-Hashes, Session-Cookie (httpOnly, sameSite=strict), Rollen `admin` / `moderator` / `viewer`
  - CLI-Befehl zum Anlegen des ersten Admins; Login-Seite im Frontend; Rechteprüfung pro Route
  - Fertig wenn: Tests prüfen Rollenrechte je Route; Login-Versuche sind gedrosselt
  - Notiz: Entscheidung (2026-09-19): gesamtes Webinterface nur mit Login; öffentlich sind nur `POST /api/auth/login`, `POST /api/auth/logout` und `GET /api/health` (Betriebsstatus ohne personenbezogene Daten, für Monitoring). Migration 0002: `admin_users` (Benutzername klein geschrieben, argon2id, Rolle viewer/moderator/admin, gesperrt), `admin_sessions` (nur SHA-256 des 256-bit-Tokens, gleitende Gültigkeit `SESSION_TTL_HOURS`, Standard 12 h). Plugin `src/api/auth/plugin.ts`: jede `/api`-Route ist standardmäßig viewer-geschützt, `config: { auth: 'public' | Rolle }` pro Route; unbekannte API-Routen liefern ohne Login 401 statt 404; Cookie `ts3a_session` HttpOnly + SameSite=Strict (+ Secure per `WEB_COOKIE_SECURE`); Origin-Prüfung für nicht-GET (CSRF). `app.apiRoutes` listet alle Routen mit Schutzstufe – der Test prüft jede Route anonym und als viewer, neue Routen sind automatisch abgedeckt. Drosselung (`src/domain/login-throttle.ts`): 5 Fehlversuche/15 min pro Name → 15 min Sperre, global max. 30 Fehlversuche/min; unbekannte Namen kosten gleich viel Rechenzeit. Passwort ändern/Konto sperren beendet alle Sitzungen. CLI `pnpm admin:user create|password|disable|enable|list` (Passwort verdeckt oder per stdin). Abgelaufene Sitzungen löscht ein stündlicher Job. Frontend: Login-Seite mit Rücksprung (`?weiter=`, nur interne Pfade), Umleitung bei 401, Nutzer + Abmelden im Kopf. Ende-zu-Ende mit curl geprüft.

- [x] **T4.2 Audit-Log** · `Backend` · braucht: T4.1
  - Tabelle `audit_log` (wer, was, Ziel, Details, wann), Middleware für alle schreibenden Routen, Seite mit Filter
  - Fertig wenn: jede schreibende Route erzeugt nachweislich einen Eintrag (Test)
  - Notiz: Migration 0003 `audit_log` (Zeit, Person-ID + Name als Snapshot, Aktion, Ziel-Typ/-ID, Details-JSON, HTTP-Status). `src/api/audit/plugin.ts` schreibt nach **jeder** nicht-GET-Anfrage unter `/api` einen Eintrag (auch abgelehnte/anonyme); Handler präzisieren per `request.audit({ action, targetType, targetId, details })`, sonst `METHOD /route`. Request-Bodies werden nie automatisch übernommen (keine Passwörter; Test prüft das). Aktionen bisher: `auth.login`, `auth.login_failed` (mit Benutzername), `auth.login_blocked`, `auth.logout`; CLI `admin:user` schreibt `admin_user.*` mit Person „cli“. `GET /api/audit` + `/api/audit/filters` nur für Admins (Filter Person/Aktion/Zeitraum, Paginierung). Seite „Protokoll“ (`/protokoll`) nur für Admins in der Navigation, sonst „Keine Berechtigung“; Aktionsnamen deutsch über `audit.action.*` in der Übersetzungsdatei, unbekannte Codes roh. Neue Aktionen künftiger Tasks brauchen nur einen Übersetzungseintrag. Test iteriert alle schreibenden Routen (`app.apiRoutes`).

- [x] **T4.3 Notizen & Tags** · `Backend` `Frontend` · braucht: T4.2
  - Notizen mit Verlauf und Autor, frei definierbare Tags, Anzeige auf der Spielerseite
  - Notiz: Tabellen `player_notes`, `player_note_revisions`, `tags`, `user_tags` (Migration 0004). Rechte: Betrachter lesen; Moderator schreibt Notizen, legt Tags an und vergibt sie, ändert/löscht eigene Notizen; Admin ändert/löscht alle Notizen, benennt Tags um und löscht sie. Bearbeiten und Löschen legen die alte Fassung im Verlauf ab (Löschen ist weich, der Text bleibt im Verlauf). Das Audit-Log speichert nur IDs, nie den Notiztext. Tag-Namen sind ohne Groß-/Kleinschreibung eindeutig; 6 feste Farben. Umbenennen gibt es bisher nur per API (`PATCH /api/tags/:id`), noch nicht in der Oberfläche.

- [x] **T4.5 Aktivitäts-Einstellungen im Webinterface** · `Backend` `Frontend` · braucht: T4.2, T2.3
  - Idle-Schwelle, AFK-Channels (Auswahl aus Channelliste), „Away = AFK“, „Lautsprecher stumm = AFK“ bearbeiten (nur Admin); Speichern über `saveActivitySettings`, Eintrag im Audit-Log
  - Hinweis im UI, dass Änderungen nur für künftige Zeiten gelten (bestehende Segmente bleiben)
  - Notiz: `GET/PUT /api/settings/activity` (nur Admin), Seite „Einstellungen“ (`/einstellungen`). Der Watcher liest die Regeln bei jedem Ereignis, Änderungen wirken also ohne Neustart. Das Audit-Log speichert nur die geänderten Felder (`{feld: {from, to}}`). Die Channel-Liste enthält auch Channels, die es auf dem Server nicht mehr gibt (Hinweis „zuletzt gesehen“); ausgewählte, unbekannte Channel-IDs bleiben sichtbar und lassen sich abwählen. Die Idle-Schwelle wird in Minuten eingegeben (1–1440) und in Sekunden gespeichert.

- [x] **T4.4 Bot-Status-Seite** · `Backend` `Frontend` · braucht: T4.1
  - Query-Verbindung, letzter Heartbeat, Uptime, DB-Größe, letzte Fehler aus dem Log
  - Notiz: `GET /api/status` (nur Admin), Seite „Bot-Status“ (`/status`), aktualisiert sich alle 30 s. Die Verbindung liefert Zustand, Zeitpunkt seit wann, Fehlversuche, letzte Verbindung, letzten Fehler (IP-bereinigt) und Warteschlange (`Ts3Connection.status()`); der JobRunner liefert letzten/nächsten Lauf und den letzten Fehler (`JobRunner.status()`). Die letzten 20 Warnungen und Fehler werden aus dem Ende der neuesten 3 Logdateien gelesen (`src/logging/recent.ts`), gleiche Meldungen direkt hintereinander werden mit Zähler zusammengefasst; so sind auch Fehler vor einem Absturz sichtbar. Relative Zeiten nutzen die Serveruhr. Warnung bei einem Heartbeat, der älter als 15 Minuten ist.

## Phase 5 – Sicherheit & Moderation

- [x] **T5.1 Banlist-Sync** · `Watcher` · braucht: T2.5
  - Banliste periodisch vom Server lesen und lokal spiegeln (inkl. UID, falls vorhanden)
  - Notiz: Tabelle `bans` (Migration 0005). `BanSync` liest die Liste nach jedem (Wieder-)Verbinden und dann alle `BAN_SYNC_INTERVAL_S` (Standard 600 s) über die Query-Queue, seitenweise; Fehler 1281 („empty result set“) gilt als leere Liste. Einzelne IP-Adressen werden wie in `ip_seen` nur als HMAC von IP und Subnetz gespeichert; IP-Regeln, die Muster sind, werden nur markiert (`ip_pattern`), ihr Text wird nicht gespeichert. Die UID wird, wenn bekannt, mit `users` verknüpft. Bans, die nicht mehr auf dem Server stehen, bekommen `removed_at` (bei erneutem Auftauchen wieder aktiv). Schlägt das Lesen fehl, wird nichts als entfernt markiert. Die Retention löscht die IP-Hashes aufgehobener Bans nach `IP_RETENTION_DAYS`. Der Query-Account braucht das Recht `b_client_ban_list`.

- [x] **T5.2 Alt- & Evasion-Erkennung** · `Security` · braucht: T5.1, T4.2
  - Reine Funktion in `/domain`, die Flags erzeugt: gleicher IP-Hash wie gebannte UID → hoch; gleicher Subnetz-Hash wie gebannte UID → mittel; gleicher IP-Hash wie andere UID → info
  - Tabelle `flags` mit Status offen / verknüpft / ignoriert; Seite mit Aktionen
  - Fertig wenn: Tests für alle Flag-Stufen; ignorierte Paare werden nicht erneut geflaggt
  - Notiz: `detectFlags` in `src/domain/flags.ts` (rein, arbeitet nur mit Hashes). Pro Paar wird nur die stärkste Stufe gemeldet; gebannte Nutzer werden nie selbst geflaggt; mehrere Bans derselben UID zählen als eine Identität; IP-Bans ohne bekannte UID werden über ihre eigenen Hashes verglichen. IPs, die mehr als 10 UIDs teilen (NAT, öffentliche Netze), erzeugen keine Info-Paare, Bans greifen dort aber weiterhin. Tabelle `flags` (Migration 0006) mit eindeutigem `pair_key`: erneutes Erkennen aktualisiert nur Stufe, Belege (Anzahl gemeinsamer IPs/Subnetze, nie Hashes) und `last_detected`, der Status bleibt. Die Erkennung läuft als Job alle 15 Minuten und zusätzlich direkt nach einem Ban-Sync mit Änderungen. Seite „Hinweise“ (`/hinweise`, Moderator und Admin) mit Status-Tabs, Stufenfilter, Spielerfilter (`?spieler=`), Aktionen Verknüpfen / Ignorieren / Wieder öffnen (Audit `flag.status`). Nicht mehr zutreffende Hinweise (z. B. Ban aufgehoben) werden markiert. Die Spielerseite zeigt Moderatoren die Zahl offener Hinweise mit Link. „Verknüpfen“ setzt vorerst nur den Status; das Zusammenrechnen folgt mit T5.3.

- [x] **T5.3 UID-Verknüpfung** · `DB` `Backend` · braucht: T5.2
  - Tabelle `persons`; mehrere UIDs einer Person zuordnen; Statistiken und Leaderboards rechnen auf Personenebene zusammen
  - Entscheidung (19.09.2026): Leaderboards und Statistiken fassen verknüpfte UIDs zu einer Person zusammen; die Spielerseite zeigt alle UIDs der Person.
  - Notiz: Tabellen `persons` (mit Haupt-Account `primary_user_id`) und `person_members` (Migration 0007). Leaderboards (inkl. CSV-Spalte „Verknüpfte Accounts“) gruppieren nach Haupt-Account: Zeiten werden summiert, die längste Session ist das Maximum; Einträge zeigen „+N“. Die Spielerseite rechnet Kennzahlen, Tagesdiagramm, Channels und den Online-Status über alle verknüpften Accounts; Nicknames, Sessions und Länder bleiben pro UID. Verknüpfen per Suche auf der Spielerseite oder per „Verknüpfen“ bei einem Hinweis (dann wird der zuerst gesehene Account Haupt-Account); zwei Personen werden dabei zusammengeführt. Entfernen des Haupt-Accounts macht das älteste verbleibende Mitglied zum Haupt-Account, eine Person mit nur noch einem Mitglied wird aufgelöst. Moderator und Admin, Audit `person.link` / `person.unlink` / `person.primary`. Einschränkung: Waren zwei verknüpfte UIDs gleichzeitig online, zählt diese Zeit doppelt (wird auf der Spielerseite erklärt). Das Rangsystem (Phase 6) soll ebenfalls pro Person rechnen. Beim Löschen eines Nutzers (DSGVO, T7.x) muss er vorher aus seiner Person entfernt werden (`primary_user_id` ist `RESTRICT`).

- [x] **T5.4 Discord-Alerts** · `Backend` · braucht: T5.2
  - Webhook-URL und Ereignistypen im Webinterface konfigurierbar; Versand gedrosselt
  - Entscheidung (19.09.2026): Die Webhook-URL wird vom Admin im Webinterface eingetragen und in der DB gespeichert; danach nie mehr im Klartext angezeigt, geloggt oder ins Audit-Log geschrieben (nur maskiert, z. B. „…abcd“). Test-Button zum Prüfen.
  - Notiz: Einstellungen in `settings['alerts']`, Karte „Discord-Benachrichtigungen“ auf der Einstellungsseite (`GET/PUT /api/settings/alerts`, `POST /api/settings/alerts/test`, nur Admin). Nur echte Discord-Webhook-URLs werden angenommen (keine beliebigen ausgehenden Requests). Log-Text wird zusätzlich von Webhook-URLs bereinigt (`[WEBHOOK]`), `webhookUrl` steht auf der Schwärzungsliste. `AlertNotifier`: höchstens N Meldungen pro Minute (Standard 10, einstellbar 1–30), der Rest wird in der letzten freien Nachricht zusammengefasst; bei HTTP 429 wird Discords `retry_after` abgewartet. Mentions sind abgeschaltet (`allowed_mentions`), Markdown in Nicknames wird escaped. Ereignisse: neuer Hinweis „hoch“/„mittel“, neuer Ban, Bot länger als 2 Minuten ohne Verbindung (plus Meldung, wenn er wieder verbunden ist). Der erste Ban-Abgleich und die erste Hinweis-Erkennung melden nichts (sonst würde der Bestand gemeldet). Nachrichten enthalten Nicknames/UIDs, nie IPs oder Hashes. Neue Ereignistypen (T5.5, T5.7) werden in `ALERT_EVENTS` ergänzt.

- [x] **T5.5 Join-Spike-Erkennung** · `Watcher` `Security` · braucht: T5.4
  - Alarm, wenn neue UIDs in Zeitfenster X über Schwelle Y liegen (beides konfigurierbar)
  - Notiz: `JoinSpikeDetector` hängt als Listener am SessionTracker. „Neu“ ist eine UID, die beim Join zum ersten Mal gesehen wird. Joins aus einem Clientlisten-Abgleich (Start, verpasste Events) zählen nicht; dafür gibt es die neuen Listener-Hooks `onSyncStart`/`onSyncEnd`. Schwelle (2–1000) und Zeitfenster (1–240 min, Standard 10 in 10 min) stehen bei den Discord-Einstellungen, Ereignis `join.spike`. Pro Zeitfenster höchstens eine Meldung; sie nennt bis zu 10 Nicknames. Zusätzlich eine Warnung im Log (erscheint auf der Bot-Status-Seite).

- [x] **T5.6 Moderationsaktionen** · `Backend` `Frontend` · braucht: T4.2
  - Kick, Ban (Vorlagen für Grund und Dauer), Poke, Nachricht, Move – je nach Rolle
  - Fertig wenn: jede Aktion läuft über die Query-Queue und landet im Audit-Log
  - Entscheidung (19.09.2026): Alle Aktionen nur für Admins. Globaler Schalter „Moderationsaktionen erlauben“ in den Einstellungen, standardmäßig aus; solange er aus ist, lehnt die API die Aktionen ab und die Buttons sind deaktiviert.
  - Notiz: `POST /api/users/:id/moderation` mit `poke` (max. 100 Zeichen), `message` (1024), `kick` (Server oder Channel, Grund max. 40), `move`, `ban` (Vorlage oder eigener Grund/Dauer). Aktionen gelten für alle Verbindungen des Spielers. Ban standardmäßig per `banadd uid=` (nur UID, auch offline möglich) plus Kick; optional „auch IP sperren“ per `banclient` (nur online, trifft alle mit derselben Adresse). Die UID wird laut ServerQuery-Handbuch unverändert übergeben (`uid={clientUID}`); das sollte beim ersten echten Einsatz geprüft werden. Schalter und Ban-Vorlagen auf der Einstellungsseite (`GET/PUT /api/settings/moderation`), Karte „Moderation“ auf der Spielerseite (nur Admin, Bestätigung bei Kick und Ban). Audit: `moderation.<aktion>` inklusive Grund/Dauer/Text (gekürzt), auch bei Ablehnung. Fehler: ausgeschaltet 409, offline 409, keine Verbindung 503, vom Server abgelehnt 502 (Details nur im Log). Neue Bans erscheinen spätestens mit dem nächsten Ban-Abgleich im Spiegel.

- [x] **T5.7 Servergruppen-Überwachung** · `Watcher` `Security` · braucht: T5.4
  - Serverlog per `logview` auf Gruppenzuweisungen auswerten; Alarm bei als „geschützt“ markierten Gruppen
  - Notiz: `GroupWatch` liest alle `GROUP_LOG_INTERVAL_S` (Standard 30 s) die neuesten 100 Log-Zeilen (`logview reverse=1`, direkt aufgerufen, weil die Bibliothek immer `begin_pos=0` sendet). Der Parser (`src/domain/group-log.ts`) erkennt nur „client … was added to / removed from servergroup …“ (mit und ohne Nickname); Rohzeilen werden nie gespeichert oder geloggt. Verarbeitet wird nur, was neuer ist als die zuletzt gesehene Log-Position (Zeitstempel des Servers, daher unabhängig von der Uhr des Bots). Der erste Lauf übernimmt den sichtbaren Verlauf ohne Meldungen. Tabelle `group_changes` (Migration 0008), Spieler werden über die Client-Datenbank-ID zugeordnet. Geschützte Gruppen und Verlauf auf der Einstellungsseite, Ereignis `group.protected` bei den Discord-Meldungen (Hinzufügen und Entfernen). Einschränkung: mehr als 100 Log-Zeilen zwischen zwei Abrufen → mögliche Lücke, dann Warnung im Log (Bot-Status-Seite). Rechte: `b_virtualserver_log_view`, für die Gruppenliste `b_virtualserver_servergroup_list`.

## Phase 6 – Rangsystem

Entscheidungen (19.09.2026):

- Zählmodus standardmäßig **Online-Zeit** (wie das bisherige Ranking, damit Legacy-Zeiten vergleichbar bleiben); im Webinterface auf „nur aktiv“ umschaltbar.
- Offline-Spieler: Rangänderungen werden **vorgemerkt und beim nächsten Join gesetzt** (keine Änderungen an Offline-Accounts per DB-ID).
- Verknüpfte Accounts: Rang aus der **zusammengerechneten Zeit der Person**, gesetzt auf **allen UIDs** der Person.
- Aufstieg: **private TS3-Textnachricht** an den Spieler (Text anpassbar, abschaltbar), optional zusätzlich Discord.

- [x] **T6.1 Rang-Schema** · `DB` · braucht: T1.1
  - Tabellen `ranks` (Name, Reihenfolge, benötigte Stunden, Servergruppen-ID), `rank_history`, `rank_overrides`
  - Settings: Zählmodus (online / nur aktiv), ausgeschlossene Servergruppen, Dry-Run an/aus (Standard: an)
  - Notiz: Migration 0009 mit `ranks` (benötigte Zeit in Sekunden, Servergruppe und Reihenfolge eindeutig), `rank_overrides`, `rank_history` (Ergebnis `applied`/`pending`/`dry_run`/`failed`) und zusätzlich `rank_state` (Soll-Rang je Nutzer, `pending` bis zum nächsten Join). `replaceRanks` ersetzt die Leiter als Ganzes, behält IDs bestehender Ränge und verlangt streng steigende Zeiten. Einstellungen in `settings["ranks"]`: Zählmodus (Standard online), ausgeschlossene Gruppen, Dry-Run (Standard an), Intervall, Aufstiegsnachricht, Discord. Rangzeit laut Regel 12: Modus „online“ = `online_s − unknown_s` (importierte Zeit zählt nicht), Modus „aktiv“ = `active_s`, plus Legacy-Zeit ab Phase 8.

- [x] **T6.2 Rang-Engine** · `Backend` · braucht: T6.1, T2.3
  - Reine Funktion: aus Spielzeit, Overrides und Rangliste den Soll-Rang bestimmen
  - Vorschau-Endpunkt: wer steigt beim nächsten Lauf auf oder ab
  - Fertig wenn: Tests für Grenzwerte, Ausschlüsse, eingefrorene Ränge, Bonusstunden
  - Notiz: `decideRank`/`mergeOverrides` in `src/domain/ranks.ts` (rein). Höchster erreichter Rang, genaues Erreichen der Schwelle zählt; ohne erreichten Rang keine Ranggruppe; Bonus darf negativ sein (nie unter 0); eingefrorener Rang gilt, solange er in der Leiter existiert; ausgeschlossen (Override oder Mitglied einer ausgeschlossenen Gruppe) = der Job fasst den Spieler nicht an. Verknüpfte Accounts: Zeiten und Boni werden addiert, ein Ausschluss eines Accounts gilt für alle, der eingefrorene Rang des Haupt-Accounts hat Vorrang. `planRanks` (`src/ranks/planner.ts`) liest Rangzeit (`online_s − unknown_s` bzw. `active_s` ab dem Legacy-Cutoff `settings["legacy.cutoff"]`, Tagesgenauigkeit), Overrides, bisherige Entscheidungen (`rank_state`) und die zuletzt gesehenen Servergruppen (neue Spalte `users.server_groups`, Migration 0010, bei jedem Join gesetzt). `GET /api/ranks/preview` (nur Admin) zeigt Auf- und Abstiege des nächsten Laufs.

- [x] **T6.3 Rang-Job** · `Watcher` · braucht: T6.2, T4.2
  - Läuft alle X Minuten; weist neue Rang-Gruppe zu und entfernt die vorherige
  - Prüft nur Nutzer, die seit dem letzten Lauf online waren oder deren Overrides/Rangkonfiguration sich geändert haben; ein Voll-Lauf über alle Nutzer nur nach Konfigurationsänderung
  - Gruppen können nur bei Online-Nutzern sicher geprüft werden; für Offline-Nutzer wird die Änderung vorgemerkt oder per `servergroupaddclient` über die DB-ID gesetzt (Verhalten dokumentieren)
  - Fasst ausschließlich Gruppen aus `ranks` an; im Dry-Run nur Protokoll
  - Fertig wenn: Test belegt, dass nicht verwaltete Gruppen nie verändert werden
  - Notiz: `RankJob` (`src/ranks/job.ts`) läuft alle `intervalMinutes` (Standard 10) aus den Rang-Einstellungen. Ein Fingerabdruck aus Leiter, Zählmodus, ausgeschlossenen Gruppen, Dry-Run, Overrides und Verknüpfungen entscheidet über den Voll-Lauf; sonst werden nur Spieler geprüft, die gerade online sind oder seit dem letzten Lauf online waren. Pro Lauf eine `clientlist` für die Live-Gruppen (aktualisiert auch `users.server_groups`). `groupDiff` (`src/domain/rank-groups.ts`) berechnet Änderungen nur innerhalb der Ranggruppen, `assertManaged` prüft vor jedem Befehl noch einmal; ein Test prüft alle Kombinationen aus verwalteten und fremden Gruppen. Verhalten: Online-Accounts werden sofort per `servergroupaddclient`/`servergroupdelclient` (DB-ID) angepasst, nur die Differenz. Offline-Accounts werden in `rank_state` als `pending` vorgemerkt und beim nächsten Join mit den Gruppen aus dem Join-Event angepasst (keine Änderungen an Offline-Accounts). Dry-Run (Standard): Entscheidungen und Verlauf (`dry_run`) werden gespeichert, kein Serverbefehl. Beim Ausschalten des Dry-Run gibt es einen Voll-Lauf, der die tatsächlichen Gruppen abgleicht. Aufstieg: private Textnachricht (Text in den Einstellungen) und Discord-Ereignis `rank.promoted`. Achtung beim ersten echten Lauf mit einer neuen Leiter: Alle Online-Spieler, deren Gruppen noch nicht passen, bekommen die Aufstiegsnachricht.

- [x] **T6.4 Rang-Konfiguration im Webinterface** · `Frontend` · braucht: T6.2, T4.1
  - Ränge anlegen, sortieren, bearbeiten; Servergruppen-Auswahl aus `servergrouplist`; Vorschau vor dem Speichern; Dry-Run-Schalter (nur Admin)
  - Notiz: Seite „Ränge“ (`/raenge`, nur Admin). Die Reihenfolge ergibt sich automatisch aus der benötigten Zeit (Stunden, auch mit Komma); Servergruppen aus der gespeicherten Gruppenliste der Servergruppen-Überwachung. `PUT /api/ranks` speichert Leiter und Einstellungen zusammen. `POST /api/ranks/preview` rechnet einen Entwurf in einer Transaktion und rollt sie danach zurück (nichts wird gespeichert); die Vorschau liefert Rangnamen mit, auch für neue Entwurfsränge. `POST /api/ranks/run` startet einen Voll-Lauf (bei ausgeschaltetem Dry-Run mit Rückfrage), `GET /api/ranks/history` zeigt den Verlauf. Audit: `ranks.update` (inkl. Dry-Run-Wechsel), `ranks.run`. Vorschau über 8.500 Spieler: ca. 100 ms.

- [x] **T6.5 Overrides** · `Backend` `Frontend` · braucht: T6.4
  - Rang einfrieren, Bonusstunden vergeben, vom Ranking ausschließen – auf der Spielerseite
  - Notiz: Karte „Rang“ auf der Spielerseite für alle Rollen (Soll-Rang laut Spielzeit, Rangzeit, Zeit bis zum nächsten Rang, Hinweise „eingefroren“, „wird beim nächsten Beitritt gesetzt“, „Dry-Run“). Admins bearbeiten dort die Ausnahme: Rang einfrieren, Bonusstunden (auch negativ, mit Komma), ausschließen, interner Grund (`PUT /api/users/:id/rank-override`, Audit `rank.override`). Die Ausnahme wird am angezeigten Account gespeichert und gilt für die ganze Person. `GET /api/users/:id/rank` liefert Override-Details nur an Admins. `planRanks` rechnet bei eingeschränktem Umfang nur die Rangzeiten der betroffenen Personen (Spielerseite, Teil-Läufe des Jobs).

- [ ] **T6.6 Saisons & Inaktivität (optional)** · `Backend` · braucht: T6.5
  - Saison-Leaderboards mit Reset; optionaler Abstieg nach X Wochen Inaktivität

## Phase 7 – Betrieb

Entscheidungen (20.09.2026):

- DSGVO: **Anonymisieren** statt Löschen – UID (ersetzt durch zufällige Kennung), Nicknames, IP-Hashes, Notizen, Tags, Hinweise, Verknüpfungen und Rang-Daten werden entfernt, Personenbezug in Ban-Spiegel und Gruppenverlauf gelöscht; Spielzeiten bleiben als anonymer Eintrag in den Statistiken. Anonymisierte Einträge erscheinen nicht in Leaderboards, Spielerliste, Suche und Rängen. Kommt dieselbe UID wieder, entsteht ein neuer Spieler.
- Export und Anonymisierung **nur für Admins**, Anonymisierung mit Bestätigung durch Eintippen der UID.
- T7.5 (öffentliches Leaderboard) und T6.6 (Saisons) **später / nach Bedarf**.

- [x] **T7.1 Backups** · `Ops` · braucht: T1.1
  - Tägliches SQLite-Online-Backup nach `/data/backups`, Rotation (z. B. 14 Stück)
  - Notiz: Job „backup“ (täglich) und `pnpm backup` (manuell), `src/jobs/backup.ts`. SQLite-Online-Backup in eine `.partial`-Datei, Umstellung auf `journal_mode=DELETE` (eine eigenständige Datei), `quick_check`, erst dann Umbenennen; Rotation behält die neuesten `BACKUP_KEEP` (Standard 14) in `BACKUP_DIR` (Standard `./data/backups`). Der JobRunner kann jetzt asynchrone Jobs (nie doppelt parallel, Fehler auf der Bot-Status-Seite). 240-MB-Datenbank: ca. 2 s. Wiederherstellung in `docs/backup.md`.

- [x] **T7.2 DSGVO-Funktionen** · `Backend` · braucht: T4.2
  - Alle Daten einer UID exportieren (JSON) oder löschen
  - Notiz: Karte „Datenschutz“ auf der Spielerseite (nur Admin). `GET /api/users/:id/export` liefert alles zur UID als JSON-Download (ohne IP-Prüfsummen, nur Anzahl/Länder/Zeiträume). `POST /api/users/:id/anonymize` verlangt die UID als Bestätigung und wird abgelehnt, solange der Spieler online ist. Neue Spalte `users.anonymized_at` (Migration 0011); anonymisierte Spieler sind aus Leaderboards, Spielerliste, Suche und Rangberechnung ausgeblendet, die Spielerseite antwortet 410 `USER_ANONYMIZED`. Audit ohne UID. Grenzen (Server-Ban, Protokoll, ältere Sicherungen) stehen in `docs/datenschutz.md`.

- [x] **T7.3 Windows-Dienst & Doku** · `Ops` · braucht: T3.1
  - NSSM-Einrichtung, Logs, Update-Ablauf, Allowlist-Eintrag, GeoLite2-Update in `/docs` beschreiben
  - Notiz: `docs/betrieb.md` – Voraussetzungen, Installation (`pnpm build` → `dist/` + `web/dist/`, Start `node dist/main.js`), Rechte des Query-Accounts als Tabelle, Anti-Flood-Allowlist, NSSM-Dienst (`AppDirectory` ist Pflicht, sonst wird `.env` und `./data` nicht gefunden), Logs, Update-Ablauf, GeoLite2-Update, Liste der automatischen Jobs mit ihren Intervallen. Der Produktionspfad wurde einmal durchgespielt: Build, `node dist/main.js`, `/api/health` und die ausgelieferte Weboberfläche antworten. Offen bis zur Installation auf dem Server: die genauen Rechtenamen der Query-Gruppe und ob NSSM `AppExit Default Restart` hier wie gewünscht wirkt. Nachtrag: `scripts/setup.ps1` automatisiert das Ganze (`install`, `update`, `start`, `stop`, `uninstall`, `status`) – es prüft Node 22+ und NSSM, erzeugt `.env` samt `HMAC_SECRET`, richtet den Dienst mit NSSM ein und startet erst, wenn die Pflichtwerte gesetzt sind; `uninstall` lässt Daten und `.env` stehen, `-PurgeData` löscht sie nach zusätzlicher Rückfrage. Die Datei braucht ein UTF-8-BOM, sonst liest Windows PowerShell 5.1 sie als ANSI und die Umlaute zerlegen die Strings.

- [x] **T7.4 Channel-Statistik** · `Backend` `Frontend` · braucht: T3.2
  - Nutzung pro Channel, ungenutzte Channels der letzten X Tage
  - Notiz: Seite „Channels“ (alle angemeldeten Rollen) mit zwei Karten. „Zeit je Channel“ (`GET /api/channels/usage`) summiert die Aktivitätssegmente je Channel: Zeit, Anteil, Spieler (verknüpfte UIDs als eine Person), Besuche, zuletzt genutzt; Channels, die nicht mehr in der Channelliste stehen, sind als solche markiert. „Ungenutzte Channels“ (`GET /api/channels/unused?days=7|14|30|60|90`) listet Channels, die es noch gibt, in denen aber niemand war. Es gibt bewusst kein Aggregat je Channel: Die Abfragen lesen `activity_segments` direkt, deshalb nur 24 h / 7 / 30 Tage – ein Jahr lag bei 351 ms gegen das Budget von 100 ms (Messwerte in `docs/performance.md`). Offene Segmente zählen mit, sonst sähe ein gerade besetzter Channel ungenutzt aus. Wie weit zurückgeschaut werden kann, hängt an `SEGMENT_RETENTION_MONTHS`.

- [ ] **T7.5 Öffentliche Leaderboard-Seite (optional)** · `Backend` `Frontend` `Security` · braucht: T4.1, T3.6
  - Eigener, getrennter HTTP-Listener (eigener Host/Port in der Config, Standard: aus), der ausschließlich eine schreibgeschützte Leaderboard-Ansicht ausliefert – ohne Login, ohne UIDs, ohne Links auf Spielerdetails
  - Bewusste Ausnahme von Regel 8, nur für diesen Listener; das Admin-Webinterface bleibt auf 127.0.0.1
  - Konfigurierbar, welche Leaderboards öffentlich sind; Spieler können per Override ausgeblendet werden (T6.5)
  - Fertig wenn: Test belegt, dass über den öffentlichen Listener keine andere API-Route erreichbar ist

## Phase 8 – Import historischer Daten

Ziel: Historie aus mehreren GB alter TS3-Serverlogs und der Datenbank des bisherigen Rankingsystems übernehmen, ohne Doppelzählung und ohne Klar-IPs zu speichern. Importe laufen als eigene CLI-Befehle, nicht im Bot-Prozess.

- [x] **T8.1 Log-Format-Analyse** · `Watcher` · braucht: T0.1
  - Beispiel-Logs aus `/data/import/samples` untersuchen, alle relevanten Ereignisse erfassen (Connect, Disconnect inkl. Grund, Serverstart/-stopp, Bans, Gruppenänderungen)
  - Ergebnis: `/docs/import-logs.md` mit Zeilenformaten, Regex je Ereignis, Sonderfällen und einer Liste, was die Logs **nicht** enthalten (z. B. Channelwechsel, Idle)
  - Fertig wenn: das Dokument deckt alle Zeilentypen der Samples ab; unbekannte Zeilen sind aufgelistet
  - Notiz: `docs/import-logs.md`. Ausgewertet wurde die vorhandene Beispieldatei (214.279 Zeilen, Sep–Nov 2019) mit Wegwerf-Skripten; jeder Zeilentyp ist zugeordnet, die drei unbekannten Formen sind aufgelistet. Wichtigste Punkte: Die ID in den Zeilen ist die **Client-Datenbank-ID**, keine UID (deshalb T8.3); Nicknames enthalten `|` (307-mal) und `'`, die Zeile darf also nicht an `|` zerlegt werden; 95 % der Zeilen sind Query-Clients und werden per Vorfilter übersprungen; Logs enthalten keinen Channel, keine Aktivität und keine Bans; im Sample 9 doppelte Verbindungen desselben Accounts, 25 Sitzungen über 24 h (längste 52 Tage), 2 beschädigte Zeilen. Offen: Die Zeitzone der Logs ist nicht notiert – die Tagesverteilung spricht für UTC, der Import bekommt dafür eine Option und der Dry-Run zeigt die Verteilung je Stunde. Die Beispieldaten selbst bleiben lokal, im Dokument stehen nur nachgebaute Zeilen.

- [x] **T8.2 Schema-Erweiterung Import** · `DB` · braucht: T1.1, T6.1
  - `sessions.source` (`live` / `import`), Aktivitätszustand `unknown` für importierte Zeiten
  - Tabelle `import_runs` (Quelle, Datei, Byte-Offset, Status, Zähler) für Fortsetzen und Idempotenz
  - `users.legacy_seconds`, `users.legacy_rank`, globale Einstellung `legacy_cutoff` (Zeitpunkt der Umstellung)
  - Notiz: `sessions.source` und der Zustand `unknown` gab es schon seit T1.1. Neu (Migration 0012): Tabelle `import_runs` mit Byte-Offset, Status und Zählern je Datei – eindeutig über (Quelle, Datei); eine gewachsene Datei wird fortgesetzt, eine geschrumpfte oder abgebrochene von vorn gelesen (`startImportRun`, `isImportDone` in `src/db/repositories/imports.ts`). Dazu `users.legacy_seconds` (Standard 0) und `users.legacy_rank` (alte Servergruppen-ID) sowie der Stichtag in der Einstellung `legacy.cutoff`, die die Rang-Engine schon kannte (gesetzt vom Import in T8.9). Ein CHECK verhindert einen Offset größer als die Datei.

- [x] **T8.3 DB-ID → UID-Mapping** · `DB` · braucht: T8.2
  - Logs enthalten nur Client-DB-IDs. Mapping aus einer **Kopie** von `ts3server.sqlitedb` (Tabelle `clients`) lesen, Fallback `clientdblist` per Query
  - Nicht auflösbare DB-IDs als Platzhalter-User anlegen (später verknüpfbar über T5.3)
  - Fertig wenn: Test mit Beispiel-DB; Bericht über Anzahl nicht auflösbarer IDs
  - Notiz: `src/import/client-map.ts`. `readClientMap` liest `clients` einer Kopie von `ts3server.sqlitedb` read-only (`client_id` ist genau die ID aus den Logzeilen, gefiltert auf den virtuellen Server, ohne Query-Konten). `DbidResolver` legt Nutzer beim ersten Auftreten an und merkt sie sich im Speicher, damit ein Lauf über Millionen Zeilen die Datenbank einmal je Spieler anfasst; unbekannte IDs bekommen die UID `unknown-dbid-<id>` und stehen im Bericht. **Wichtiger Befund:** Von den 326 Datenbank-IDs im Beispiel-Log von 2019 stehen nur 190 noch in der Serverdatenbank – 41,7 % sind nicht auflösbar, weil TeamSpeak inaktive Accounts aus seiner Datenbank räumt. Über mehrere Jahre Logs entstehen damit sehr viele Platzhalter-Spieler; wie sie in Spielerliste und Leaderboards behandelt werden, ist in T8.6 zu klären. Der Query-Fallback `clientdblist` ist noch offen – er hilft nur bei IDs, die der Server noch kennt, also genau nicht bei den gelöschten.

- [x] **T8.4 Streaming-Log-Parser** · `Watcher` · braucht: T8.1
  - Reine Parser-Funktion pro Zeile plus Datei-Reader, der zeilenweise streamt (kein Laden ganzer Dateien), Dateien chronologisch sortiert, Encoding-Fehler toleriert
  - Fertig wenn: Unit-Tests für jeden Zeilentyp aus T8.1; ein Test mit 1 Mio. generierten Zeilen bleibt unter 200 MB RAM
  - Notiz: `src/import/log-parser.ts` (rein: `parseLogLine` liefert `connect`, `disconnect`, `group`, `serverStart`, `serverStop`, `ignored` oder `unparsed`; dazu `orderLogFiles` für die chronologische Reihenfolge und `toUnix` für die Zeitzone der Logs) und `src/import/log-reader.ts` (`splitLines` arbeitet auf Buffern und liefert je Zeile den exakten Byte-Offset für `import_runs`; CRLF, geteilte Mehrbyte-Zeichen, fehlende letzte Zeilenumbrüche und ungültige Bytes sind abgedeckt, überlange Zeilen werden bei 64 KB gekappt). Der Parser wurde gegen die echte Beispieldatei laufen gelassen: 214.279 Zeilen, 2.768 Verbindungen, 2.768 Trennungen, 178 Gruppenänderungen, Start und Stopp – exakt die Zahlen aus der Analyse, 0 unbekannte Zeilen. Der Speichertest läuft über 1 Mio. erzeugte Zeilen.

- [x] **T8.5 Session-Rekonstruktion** · `Watcher` · braucht: T8.4
  - Reine Funktion in `/domain`: Connect/Disconnect paaren
  - Sonderfälle: Serverneustart oder -absturz schließt alle offenen Sessions (am letzten Log-Zeitstempel davor), doppelter Connect, Disconnect ohne Connect, konfigurierbare Maximaldauer einer Session
  - Fertig wenn: Tests für alle Sonderfälle; jede verworfene oder gekappte Session wird mit Grund gezählt
  - Notiz: `src/domain/import-sessions.ts` – `SessionBuilder` (streamend, gibt fertige Sessions sofort zurück) und `reconstructSessions` für Tests. Mehrfach verbundene Accounts werden FIFO gepaart, weil das Log nur die Datenbank-ID kennt. Jede Session trägt ihr Ende (`disconnect`, `serverStop`, `serverStart`, `endOfLogs`, `maxDuration`), die Zähler enthalten doppelte Verbindungen, verwaiste Trennungen, gekappte und leere Sessions sowie rückwärts laufende Zeitstempel. Gegenprobe an der echten Beispieldatei mit Höchstdauer 24 h: 2.765 Sessions, 8.171 h, Median 1,6 h, 10 doppelte Verbindungen, 0 verwaiste Trennungen (mein Wegwerf-Skript aus T8.1 hatte hier 9 – es hatte die zweite Verbindung überschrieben), 28 gekappt, 3 ohne Dauer.

- [x] **T8.6 Import-CLI für Logs** · `Watcher` `DB` · braucht: T8.3, T8.5, T2.5
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
  - Notiz: `pnpm import:logs <ordner> [--dry-run] [--from] [--to] [--clients] [--zone] [--server] [--max-session] [--no-rebuild] [--yes]`, Engine in `src/import/log-import.ts`. Eine Datei ist eine Transaktion (von Hand, weil zwischendurch asynchron gelesen wird): Ein Abbruch hinterlässt nichts, ein zweiter Lauf überspringt fertige Dateien (`import_runs`), Sitzungen werden also nie doppelt geschrieben. Sitzungen werden direkt geschrieben und die Aggregate am Ende **einmal** neu berechnet – der erste Ansatz mit `finalizeSession` je Sitzung war nach zehn Minuten nicht mit 1 GB durch (in `docs/performance.md` festgehalten). Gemessen: 5 GB / 46,5 Mio. Zeilen / 1,16 Mio. Sitzungen in 21 s bei konstantem Speicher (Heap ≤ 84 MB), Aggregate danach 3,6 s. Echte Beispieldatei: 2.765 Sitzungen, 190 Spieler zugeordnet, 136 Platzhalter, Suche nach 300 Klar-IPs in der Datenbankdatei findet nichts. IP-Prüfsummen entstehen nur innerhalb der Aufbewahrungsfrist (bei Logs von 2019 also gar nicht). Der Dry-Run-Bericht enthält die Verteilung der Verbindungen je Stunde zur Kontrolle der Zeitzone. Entscheidungen: Platzhalter-Spieler sind aus Spielerliste, Suche, Leaderboards und Rängen ausgeblendet (ihre Zeit bleibt in der Serverstatistik, die Spielerseite erklärt den Eintrag), Zeitzone standardmäßig deutsche Zeit, keine Höchstdauer je Sitzung. Bedienung steht in `docs/import-logs.md`.

- [x] **T8.7 Historische Aggregation** · `DB` · braucht: T8.6, T1.3
  - Nach dem Import `pnpm stats:rebuild` für den Importzeitraum: importierte Sessions landen in `user_daily_stats` als `online_s` und `unknown_s`, `server_hourly` wird aus Session-Überlappungen berechnet
  - Frontend kennzeichnet Zeiträume mit Importdaten („nur Online-Zeit, keine Aktivitätsdaten“); Leaderboards „aktiv“ weisen darauf hin, dass sie erst ab Live-Tracking gelten
  - Fertig wenn: Benchmark aus T1.4 bleibt mit den echten Importdaten im Budget
  - Notiz: Der Import ruft `rebuildAggregates` am Ende selbst auf (abschaltbar mit `--no-rebuild`); importierte Sessions landen als `online_s` und `unknown_s` in `user_daily_stats`, `active_s` bleibt 0. Neuer Endpunkt `GET /api/stats/sources` (Zeitraum der Importdaten und Beginn des Live-Trackings, eine Minute zwischengespeichert). Das Leaderboard weist darauf hin, dass importierte Zeiten nur Online-Zeit sind – bei der Wertung „aktiv“ mit dem Datum, ab dem aktive Zeit überhaupt erfasst wird. Im Tagesdiagramm der Spielerseite gab es die Serie „Unbekannt (Import)“ schon. Benchmark mit 232.520 importierten Sitzungen zusätzlich (809.527 Sessions gesamt): alles im Budget, schlechtester Wert „Leaderboard frei“ 48 ms (vorher 34 ms), Werte in `docs/performance.md`.

- [x] **T8.8 Analyse Alt-Ranking-DB** · `DB` · braucht: T0.1
  - Die Alt-DB ist SQLite. Eine Kopie unter `/data/import` mit `sqlite3` bzw. `better-sqlite3` read-only öffnen, Schema, Tabellen und Beispielwerte untersuchen; Bedeutung der Felder klären (Zeit online/aktiv, Einheit, Rang, Gruppen-IDs, Zeitstempel, UID oder DB-ID)
  - Ergebnis: `/docs/import-legacy-ranking.md` mit Feld-Mapping auf das neue Schema
  - Notiz: `docs/import-legacy-ranking.md`. Die Daten liegen in der SinusBot-Datenbank in der Schlüssel-Wert-Tabelle `scriptdata`: `timetrak<UID>` sind **Sekunden** reine Online-Zeit, `startTime<UID>` ist nur der Beginn des laufenden Messintervalls (nicht „zuerst gesehen“). Die Schlüssel enthalten die UID direkt, ein DB-ID-Mapping ist also nicht nötig. Die acht alten Ränge und ihre Schwellen (15 min bis 112 Tage, Minuten in der Konfiguration) stehen in `instances.config`, ebenso sieben ausgenommene Gruppen; Mute/Deaf/AFK waren nicht ausgeschlossen, der Wert entspricht also unserer Online-Zeit. Bestand: 11.469 Nutzer, zusammen 548.804 h, Median 1,5 h, Höchstwert 8,2 Jahre (dauerhaft verbundener Bot – Fall für T8.10). Unter dem früheren Skriptnamen liegt ein zweiter Bestand mit 174 Werten, bei 28 Nutzern ist der alte Wert größer; Vorschlag: je UID das Maximum nehmen und beide Zahlen ausweisen.

- [x] **T8.9 Import-CLI Alt-Ranking** · `DB` `Backend` · braucht: T8.8, T8.2
  - `pnpm import:ranking <pfad> [--dry-run]`
  - Pro UID `legacy_seconds` und `legacy_rank` setzen; `legacy_cutoff` festlegen
  - Rang-Engine (T6.2) rechnet: `legacy_seconds` + live erfasste Zeit **nach** dem Cutoff. Aus Logs importierte Zeit fließt nur in Statistiken, nicht in Ränge → keine Doppelzählung
  - Alte Rang-Gruppen-IDs den neuen Rängen zuordnen (Mapping-Datei), damit beim ersten Rang-Lauf niemand unerwartet absteigt
  - Notiz: `pnpm import:ranking <sinusbot.sqlite> [--dry-run] [--cutoff] [--map] [--min-minutes] [--yes]`, Logik in `src/import/ranking-import.ts`. Gelesen werden beide Bestände (aktueller Skriptname und der ältere), je UID zählt der größere Wert; die alte Rangleiter kommt aus `instances.config`, daraus ergibt sich `users.legacy_rank` ohne Zutun. Der Import **setzt** die Werte, ein zweiter Lauf ändert also nichts, und legt unbekannte UIDs als Spieler an (ohne Sitzungen bleiben sie aus Leaderboards und der Standard-Spielerliste heraus). Der Stichtag landet in der Einstellung `legacy.cutoff`, die die Rang-Engine schon auswertete; `rankingTimes` addiert jetzt `users.legacy_seconds` (die frühere Option `legacyS` ist weg). Mit `--map` (alte Gruppe → unser Rang) sagt der Bericht, wie viele Spieler denselben, einen höheren oder einen niedrigeren Rang bekämen. Lauf gegen die echte Kopie: 11.537 Spieler, 549.808 h, 190 schon bekannt, 10.174 mit altem Rang; mit einer Rangleiter nach den alten Schwellen würde niemand absteigen. Bedienung in `docs/import-legacy-ranking.md`.

- [x] **T8.10 Plausibilitätsbericht** · `Backend` `Frontend` · braucht: T8.7, T8.9
  - Pro Nutzer Vergleich: Zeit laut Logs vs. Zeit laut Alt-Ranking; größte Abweichungen zuerst
  - Admin kann pro Nutzer entscheiden, welcher Wert gilt (landet im Audit-Log)
  - Notiz: Seite „Abgleich“ (nur Admin, `/abgleich`) mit `GET /api/import/comparison` und `POST /api/import/comparison/:id` (`use: logs|legacy`, Audit `import.decision` mit Vorher-/Nachher-Wert, ohne UID). Standardmäßig werden nur Spieler gezeigt, die beide Quellen kennen – sonst stehen dort tausende Einträge, die sich gar nicht vergleichen lassen; abschaltbar über den Filter. „Logzeit übernehmen“ setzt `users.legacy_seconds` auf die Zeit aus den Logs und fragt vorher nach, wenn dadurch Zeit verloren ginge (die Logs reichen oft nicht weit genug zurück). Lauf gegen die echten Daten: 11.671 Spieler mit Daten, 4.756 innerhalb der Toleranz von 1 h; ganz oben stehen erwartungsgemäß die Dauerläufer (SinusBot-Instanz und Musikbot mit 72.169 h bzw. 62.782 h laut Altsystem gegenüber rund 1.258 h aus den Logs) – genau die Fälle, die T8.8 als unplausibel vermerkt hatte.

## Phase 9 – Spieler-Netzwerk

Ziel: Ein Kraft-gerichteter Graph zeigt, welche Spieler häufig zusammen im selben Channel sind. Knoten = Person, Kante = gemeinsam verbrachte Zeit.

Entscheidungen (20.09.2026):

- Seite **nur für Admins**.
- Gezählt wird Zeit im selben Channel mit überlappenden Aktivitätssegmenten. Zustand `afk` zählt nicht, `idle` **zählt mit** (jemand sitzt im Channel und hört zu).
- Kantengewicht sind **gemeinsame Stunden**; ein Umschalter auf „Anteil an der eigenen Zeit“ kann später folgen (die API liefert beide Werte von Anfang an).
- Auszuschließende Channels (Lobby, Warteraum, AFK) sind **in den Einstellungen auswählbar**, wie die AFK-Channel der Aktivitätserkennung.
- Zeiträume **30 Tage, 90 Tage, 1 Jahr, gesamt**. Das Netz muss **nicht live** sein: Ein Job rechnet es **einmal täglich** und legt das Ergebnis ab; die Seite liest nur noch.

Messung vorab (Prototyp gegen `data/synthetic.sqlite`, 8.500 Spieler, 2,19 Mio. Segmente, Sweep-Line über die Segmente der aktivsten 200 Spieler):

| Zeitraum | Segmente  |  Paare | Lesen  | Rechnen | Summe   |
| -------- | --------: | -----: | -----: | ------: | ------: |
| 30 Tage  |    21.979 | 12.563 |  12 ms |    6 ms |   18 ms |
| 90 Tage  |    65.973 | 18.601 |  38 ms |   20 ms |   58 ms |
| 1 Jahr   |   269.237 | 19.898 | 212 ms |   72 ms |  284 ms |
| Gesamt   | 1.184.558 | 19.869 | 847 ms |  218 ms | 1.065 ms |

Auf Abruf wären 1 Jahr und gesamt damit über dem 100-ms-Budget – als Tagesjob sind alle vier Zeiträume zusammen rund 1,5 s und völlig unkritisch.

- [x] **T9.1 Netzwerk berechnen und speichern** · `DB` `Backend` · braucht: T1.1, T5.3
  - Reine Funktion in `/domain`: Sweep-Line über nach `start_at` sortierte Segmente, je Channel die offenen Segmente mitführen, Überlappung je Paar aufsummieren. Verknüpfte UIDs vorher auf ihre Person abbilden (keine Selbstkanten), anonymisierte und Platzhalter-Spieler raus (`HIDDEN_USERS`), Mindestdauer je Begegnung und je Paar konfigurierbar
  - Kandidaten je Lauf: die aktivsten N Personen des Zeitraums (Vorgabe 200), sonst wächst die Paarzahl quadratisch mit der Spielerzahl
  - Ausgeschlossen: Zustand `afk`, Channels aus der neuen Einstellung, Channels die heute als AFK-Channel eingetragen sind
  - Schema: Tabellen für Knoten und Kanten je Zeitraum (`30d`, `90d`, `1y`, `all`), Migration von Hand auf `STRICT`/`WITHOUT ROWID` ergänzen; Zeitpunkt des letzten Laufs und Zähler in den Einstellungen
  - Einstellung `network`: auszuschließende Channels, Anzahl Kandidaten, Mindestzeit; Channel-Auswahl auf der Einstellungsseite wie bei den AFK-Channeln (Audit-Eintrag beim Speichern)
  - Job alle 24 h im `JobRunner` (wie Sicherung und Aufbewahrung), zusätzlich „jetzt berechnen“ für Admins – nötig, wenn die ausgeschlossenen Channels geändert wurden
  - Fertig wenn: Tests für Überlappung, Berührung (Ende = Anfang ergibt keine Kante), mehrere Channels gleichzeitig, verknüpfte Accounts, Mindestdauer, Zeitraumgrenzen und ausgeschlossene Channels; `pnpm bench` misst 30 Tage und 90 Tage; Laufzeit des Jobs in `docs/performance.md`
  - Notiz: `src/domain/co-presence.ts` (`buildCoPresence`, Sweep-Line, 14 Tests) plus `src/network/job.ts` und `src/network/settings.ts`. Tabellen `network_nodes` und `network_edges` je Fenster (Migration 0013, STRICT + WITHOUT ROWID); Knoten ohne einzige Verbindung werden gar nicht erst gespeichert. Der Job läuft alle 24 h im `JobRunner` und zusätzlich über „Jetzt neu berechnen“ auf der Einstellungsseite (Audit `network.run`). Einstellungen: auszuschließende Channels (AFK-Channel sind fest gesetzt und nicht abwählbar), Anzahl Kandidaten (Vorgabe 200), Mindestdauer je Begegnung (5 min) und je Paar (30 min); Karte auf der Einstellungsseite, Audit `settings.network`. **Wichtiger Fund:** Der erste Entwurf hat `persons` in beide Abfragen gejoint und über `COALESCE(primary_user_id, user_id)` gefiltert – das nutzt keinen Index und kostete für 30 Tage 1.058 ms statt 42 ms. Jetzt wird je Account aggregiert und die Person im Speicher zugeordnet, das Zeitfenster beginnt den Indexscan bei `from - 24 h`. Gemessen auf der synthetischen Datenbank: Job über alle vier Fenster 3,0 s, rund 66.000 Kantenzeilen. `pnpm bench` kennt jetzt ein eigenes Budget für Jobs (5 s statt 100 ms). Für T9.2 zu beachten: Bei einem Jahr existieren fast alle möglichen Paare der 200 Kandidaten (19.849 von 19.900) – die Seite muss die Zahl der gezeigten Verbindungen begrenzen.
- [x] **T9.2 Netzwerk-Seite** · `Backend` `Frontend` · braucht: T9.1
  - `GET /api/network?range=30d|90d|1y|all` (nur Admin) liefert Knoten (Person, Nickname, Gesamtzeit) und Kanten (gemeinsame Sekunden, Anteil an der Zeit beider Seiten) sowie den Zeitpunkt der letzten Berechnung; Filter für Mindestzeit und Anzahl Knoten
  - Seite `/netzwerk` mit Navigationseintrag: ECharts-`GraphChart` mit `layout: 'force'` (Modul in `web/src/charts/EChart.tsx` registrieren, Bundle wächst um rund 50 KB – notfalls die Seite dynamisch nachladen)
  - Knotengröße = Gesamtzeit, Kantenbreite = gemeinsame Zeit, Beschriftung nur für die größten Knoten, Nachbarn beim Überfahren hervorheben, Ziehen und Zoomen; Klick auf einen Knoten öffnet die Spielerseite
  - Tabellenansicht mit den stärksten Paaren (Pflicht: ein Kraftgraph ist für Screenreader wertlos) und Leerzustand
  - Hinweis auf der Seite, was der Graph **nicht** zeigt: nur live erfasste Zeit (der Log-Import schreibt keine Segmente), keine AFK-Zeit, anonymisierte und Platzhalter-Spieler fehlen, verknüpfte Accounts sind ein Knoten, gleicher Channel heißt nicht zwangsläufig miteinander geredet
  - Fertig wenn: Tests für Route (Rechte, Zeiträume, Filter) und Seite (Knoten/Kanten, Tabelle, Filter lösen Anfragen aus, Leerzustand); Screenshot zur Sichtprüfung; README und `docs/performance.md` ergänzt
  - Notiz: Seite `/netzwerk` (nur Admin) mit `GET /api/network?range=30d|90d|1y|all&limit=…`; gelesen werden nur die gespeicherten Tabellen, gerechnet hat der Tagesjob. Bedienung: Zeitraum-Umschalter (Zustand in der URL), **Schieberegler** für die Anzahl gezeigter Verbindungen (25 bis 1.500, Vorgabe 200) und **„Jetzt neu berechnen“** – letzteres nutzt denselben Endpunkt wie die Einstellungsseite. Diagramm ist ECharts `graph` mit Kraft-Layout (Modul in `EChart.tsx` ergänzt, Bundle wächst entsprechend); Punktgröße = gezählte Zeit (über die Fläche skaliert), Linienbreite = gemeinsame Zeit, Beschriftung nur für die 15 größten Punkte, Nachbarn beim Überfahren hervorgehoben, Ziehen und Zoomen an. Darunter die stärksten Paare als Tabelle (gemeinsame Zeit, Begegnungen, Anteil an der Zeit beider Seiten) mit Links zur Spielerseite, dazu ein Hinweis, was der Graph nicht zeigt. Kantenfarbe ist gedämpfte Schrift-, nicht Gitterfarbe – mit Gitterfarbe waren die Linien im Screenshot kaum zu sehen. Lesen kostet 28 ms bei 200 Verbindungen, 33 ms bei 1.500 (mit HTTP). Hell und dunkel per Screenshot geprüft.

## Phase 10 – Bot-Funktionen (Ablösung der SinusBot-Skripte)

Ziel: Die Aufgaben der bisherigen SinusBot-Skripte übernimmt dieser Dienst selbst – konfiguriert im Webinterface, gedrosselt über die zentrale Queue, mit Protokoll und Testmodus.

Entscheidungen (03.10.2026):

- **Anti-Proxy:** Jede IP eines **neuen** Nutzers geht an einen Online-Dienst. Wird sie als Proxy/VPN erkannt, landet sie auf einer lokalen Liste und wird künftig ohne Abfrage erkannt. Wer einmal ohne Proxy verbunden war, wird nicht erneut geprüft. Wegen Regel 1 enthält die lokale Liste **nicht die Klar-IP, sondern ihren HMAC-Hash** – für den Abgleich reicht das.
- **Regelbestätigung:** per Chat-Befehl an den Bot **und/oder** durch Betreten eines Bestätigungs-Channels, beides einzeln schaltbar.
- **Alte SinusBot-Einstellungen** werden **nicht** importiert; alle Module werden im Webinterface neu eingerichtet.
- **Support-Channel:** Benachrichtigung ist der Kern, automatisches Öffnen/Schließen (Name, Client-Limit) ist eine abschaltbare Option.

Grundsätze für alle Module:

- Jedes Modul hat `enabled` (Vorgabe aus) und `dryRun` (Vorgabe an, Regel 7). Im Testmodus wird nur protokolliert, was passiert wäre.
- Jede automatische Aktion landet im **Automatik-Protokoll** (Modul, Aktion, Spieler, Testmodus ja/nein); Änderungen an der Konfiguration im Audit-Log (Regel 10).
- Ein Modul fasst nur an, was ihm gehört: Servergruppen, die in **seiner** Konfiguration stehen (nie Rang-Gruppen, nie fremde), und Channels, die es **selbst angelegt** oder ausdrücklich übernommen hat. Fremde Channels werden nie gelöscht.
- Ausnahmen über Servergruppen („diese Gruppen ignorieren") gibt es einheitlich in jedem Modul.
- Logik als reine Funktionen in `/domain`, Tests nur gegen den Fake-Adapter.
- Vor dem Scharfschalten eines Moduls muss das entsprechende SinusBot-Skript aus sein, sonst arbeiten zwei Bots gegeneinander.

- [x] **T10.1 Query-Adapter erweitern** · `TS3` · braucht: T2.1
  - Ereignisse: private Textnachricht an den Bot (`textprivate`), Channel angelegt (mit Auslöser), Channel gelöscht; `clientMoved` zusätzlich mit Auslöser (selbst gewechselt oder verschoben)
  - Befehle: Channel anlegen, ändern (Name, Beschreibung, Limit, Passwort), löschen; Channel-Recht setzen; Channel-Gruppe eines Nutzers setzen; Mitglieder einer Servergruppe; Channel-Gruppen auflisten; Channelliste mit Belegung
  - Echte und Fake-Implementierung, alles über die Queue
  - Fertig wenn: Fake-Adapter bildet Channels und Belegung nach (anlegen, löschen, verschieben), Tests für jedes neue Ereignis und jeden Befehl
  - Notiz: Neue Ereignisse `textMessage` (nur Privatnachrichten, das eigene Echo des Bots wird verworfen), `channelCreated`, `channelDeleted`; `clientMoved` trägt jetzt `reasonId` und `invokerClid` (selbst gewechselt / verschoben / Channel-Kick). Neue Befehle an `Ts3Transport` und `Ts3Connection`: `self`, `channelCreate`, `channelEdit`, `channelDelete`, `channelSetPermission`, `channelGroups`, `setChannelGroup`, `serverGroupMembers`; `Ts3Channel` kennt zusätzlich Reihenfolge, Belegung, Limit, Art und Passwort-Flag. Die Channel-Befehle gehen bewusst über `execute` statt über die Helfer der Bibliothek – die holen nach jedem Anlegen eine komplette Channelliste an der Queue vorbei. **Fund:** Die Bibliothek hat bisher bei jeder Channel-Änderung, jedem Channel-Verschieben und jeder Textnachricht von sich aus `clientlist`/`channellist` geschickt (an der Queue vorbei, Regel 5); diese Handler sind jetzt ebenfalls ersetzt bzw. entfernt. Der Fake-Server bildet Channels samt Belegung nach, zieht den Bot wie der echte Server in einen selbst angelegten temporären Channel und löscht leere temporäre Channels ohne Löschverzögerung. Beim Verbinden kommt `servernotifyregister event=textprivate` und ein `whoami` dazu. Am echten Server noch zu prüfen: Schreibweise der Parameter von `channelcreate` (insbesondere `channel_delete_delay`).
- [x] **T10.2 Modul-Gerüst und Automatik-Protokoll** · `DB` `Backend` `Frontend` · braucht: T10.1
  - Tabelle `automation_log`, gemeinsame Ausführung mit Testmodus-Prüfung und Gruppen-Schutz (konfigurierte Gruppe, keine Rang-Gruppe), Watcher meldet Beitritt, Abgang, Wechsel und Nickname-Änderung an die Module
  - Seite „Automatik" (nur Admin) mit Übersicht der Module (an/aus, Testmodus) und Protokoll
  - AGENTS.md: Regel 13 für Bot-Module (nur eigene Gruppen und Channels)
  - Fertig wenn: Tests für Testmodus (kein Query-Befehl), Gruppen-Schutz, Protokoll; Aufbewahrung des Protokolls im Retention-Job
  - Notiz: Alles unter `src/automation/`. `ModuleActions` ist der einzige Weg, auf dem ein Modul etwas am Server tut: schreibt jede Aktion ins Protokoll (`done` / `dry` / `failed`), sendet im Testmodus nichts, kürzt Texte auf die Server-Limits, fängt Fehler ab und lehnt Servergruppen ab, die nicht in der Modul-Konfiguration stehen **oder** zur Rangleiter gehören (`ForeignGroupError`, auch im Testmodus). Automatische Bans brauchen immer eine Dauer. `AutomationHost` hängt als Listener am `SessionTracker` und reicht Beitritt (mit Kennzeichen „bei Abgleich entdeckt“), Nickname-Änderung, Channel-Wechsel samt Auslöser und Abgang an die Module weiter; dafür kennt der Tracker jetzt `onNicknameChanged`, `onObserved` und die Ursache eines Wechsels. Einstellungen je Modul unter `automation.<modul>` mit gemeinsamer Basis `enabled` (aus), `dryRun` (an), `exemptGroupIds`. Tabelle `automation_log` (Migration 0014, STRICT), Aufbewahrung 90 Tage im Retention-Job, wird bei Anonymisierung gelöscht und steht im Datenexport. API `GET /api/automation` und `GET /api/automation/log` (nur Admin), Seite `/automatik` mit Modul-Übersicht und Protokoll. Regel 13 steht in AGENTS.md. Die Modul-Liste (`MODULES` in `registry.ts`) ist noch leer und füllt sich ab T10.3; Sichtprüfung der Seite per Screenshot deshalb erst dort.
- [x] **T10.3 Nickname-Checker** · `Backend` `Frontend` · braucht: T10.2
  - Liste verbotener Muster (Text oder regulärer Ausdruck), optional „ähnliche Zeichen erkennen" (z. B. `Ａdmіn` → `admin`), je Muster eigener Hinweistext
  - Aktion: Nachricht oder Kick; Prüfung beim Beitritt und bei Nickname-Änderung (über die Abfrage, ServerQuery meldet Umbenennungen nicht als Ereignis)
  - Testfeld im Webinterface: „Würde dieser Nickname treffen?"
  - Fertig wenn: Tests für Muster, Normalisierung, Ausnahmen-Gruppen, ungültige Ausdrücke werden beim Speichern abgelehnt
  - Notiz: Regeln als reine Funktionen in `src/domain/nickname-check.ts`, Modul in `src/automation/modules/nickname.ts`, API `GET/PUT /api/automation/nickname` und `POST /api/automation/nickname/test` (nur Admin, Audit `automation.nickname`), Seite `/automatik/nickname`. Ein Muster ist Text (Teilwort) oder regulärer Ausdruck, optional mit eigenem Hinweistext; Aktion ist Privatnachricht, Anstupsen oder Kick (zeigt nur 40 Zeichen, die Seite sagt das). „Ähnliche Zeichen erkennen“ (Vorgabe an) vereinheitlicht vor dem Vergleich Vollbreite-Zeichen, Akzente, kyrillische/griechische Doppelgänger, Leetspeak und Trennzeichen; `l` und `i` gelten als gleich. Reguläre Ausdrücke mit verschachtelter Wiederholung wie `(a+)+` werden beim Speichern abgelehnt (Schutz vor minutenlanger Prüfung) – eine Heuristik, die auch ein paar harmlose Ausdrücke trifft. Geprüft wird beim Beitritt, nach einer Umbenennung (erst bei der nächsten Abfrage sichtbar) und beim Start des Dienstes für alle, die schon online sind. Der Baustein `ModuleBaseFields` (an/aus, Testmodus, ausgenommene Gruppen, Warnung vor dem Scharfschalten) ist für die übrigen Module wiederverwendbar. **Offen:** Sichtprüfung per Screenshot – das Screenshot-Werkzeug der früheren Sitzung existiert nicht mehr, die Prüfung folgt mit T10.11.
- [x] **T10.4 Support-Channel** · `Backend` `Frontend` · braucht: T10.2
  - Betritt jemand den Support-Channel: Nachricht an ihn, Anstupsen oder Nachricht an alle Supporter (Servergruppen), die online und nicht in einem AFK-Channel sind; eigener Text, wenn niemand da ist
  - Option: Channel automatisch öffnen/schließen (Name, Client-Limit), je nachdem ob ein Supporter verfügbar ist
  - Option: Discord-Meldung über die vorhandenen Benachrichtigungen
  - Fertig wenn: Tests für Benachrichtigung, niemand da, Ausnahmen, Öffnen/Schließen nur bei Zustandswechsel (keine Befehlsflut)
  - Notiz: Modul `src/automation/modules/support.ts`, Regeln in `src/domain/support.ts`, API `GET/PUT /api/automation/support` (nur Admin, Audit `automation.support`), Seite `/automatik/support`. Wer den Channel betritt (auch direkt beim Verbinden), bekommt eine Privatnachricht; alle erreichbaren Mitglieder der Team-Gruppen werden angestupst oder angeschrieben. „Erreichbar“ = online, Team-Gruppe, nicht in einem AFK-Channel der Aktivitätserkennung. Teammitglieder und ausgenommene Gruppen lösen nichts aus; je Spieler gilt eine Wartezeit (Vorgabe 60 s), damit Rein-Raus-Springen nicht das ganze Team anstupst. `{name}` in den Texten wird ersetzt, BBCode im Nickname entschärft. Einschalten geht nur mit Channel und mindestens einer Team-Gruppe. Option „automatisch öffnen/schließen“: ändert Name und Client-Limit des gewählten Channels, nur bei Zustandswechsel (geprüft bei Beitritt, Wechsel, Abgang und nach jeder Abfrage – so wird auch eine frisch vergebene Team-Gruppe bemerkt); ein Umbenennen auf den schon vorhandenen Namen wird vermieden, weil der Server das ablehnt. Discord: neues Ereignis `support.request` in den Benachrichtigungen. Der Host kennt dafür den Hook `onSynced`, `ModuleActions` darf jetzt `channelEdit`. Sichtprüfung per Screenshot folgt mit T10.11.
- [x] **T10.5 Staffliste** · `Backend` `Frontend` · braucht: T10.2
  - Channel-Beschreibung zeigt die Mitglieder gewählter Servergruppen mit Status online / abwesend / offline; Reihenfolge und Anzeigename je Gruppe, Vorlage mit Platzhaltern, Kopf- und Fußtext
  - Geschrieben wird nur, wenn sich der Text geändert hat, und höchstens alle 30 s
  - Fertig wenn: Tests für Darstellung, Mehrfach-Gruppen, Längenlimit der Beschreibung, keine Schreibzugriffe ohne Änderung
  - Notiz: Darstellung als reine Funktion in `src/domain/staff-list.ts`, Modul `src/automation/modules/staff.ts`, API `GET/PUT /api/automation/staff` (nur Admin, Audit `automation.staff`), Seite `/automatik/staff`. Die Mitglieder der gewählten Gruppen kommen per `servergroupclientlist` vom Server (ein Befehl je Gruppe, höchstens alle 5 Minuten), der Status aus der Live-Sicht: online, abwesend (alle Verbindungen in einem AFK-Channel) oder offline. Wer eine Gruppe frisch bekommen hat und online ist, erscheint sofort; für Online-Mitglieder gilt der aktuelle Nickname. Sortiert wird nach Status, dann Name. Geschrieben wird nur bei geändertem Text und frühestens 30 s nach dem letzten Schreiben; geänderte Einstellungen wirken beim nächsten Abgleich (bis zu eine Minute). Überschreitet der Text 8.192 Zeichen, verliert die längste Gruppe Einträge vom Ende her (offline zuerst) und zeigt „… (+n)“. Nicknames können kein BBCode einschleusen. Einstellbar: Reihenfolge und Überschrift je Gruppe, Kopf-/Fußtext, Zeilenvorlagen mit `{group}`, `{name}`, `{status}`, Statustexte, anklickbare Namen, Mehrfach-Gruppen, leere Gruppen. Die vorhandene Beschreibung des Channels wird überschrieben (steht auf der Seite). Nicht umgesetzt: eine Vorschau des fertigen Textes im Webinterface – Vorschlag für später. Sichtprüfung per Screenshot folgt mit T10.11.
- [x] **T10.6 Channel-Creator** · `DB` `Backend` `Frontend` · braucht: T10.2
  - Je Bereich (Eltern-Channel): Es ist immer eine einstellbare Zahl leerer Channels vorhanden („Name 1", „Name 2", … oder Namen aus einer Liste); überzählige leere werden entfernt
  - Einstellbar: Codec-Qualität, Client-Limit, Beitritts- und Sprechrecht, Beschreibung
  - Gelöscht werden nur Channels aus der Tabelle der verwalteten Channels; vorhandene passende Channels lassen sich im Webinterface ausdrücklich übernehmen
  - Fertig wenn: Tests für Anlegen, Aufräumen, Lücken in der Nummerierung, fremde Channels bleiben unangetastet, Neustart des Dienstes
  - Notiz: Planung als reine Funktion in `src/domain/channel-pool.ts` (`planPool`), Modul `src/automation/modules/channels.ts`, Tabelle `managed_channels` (Migration 0015, auch für T10.7 gedacht), API `GET/PUT /api/automation/channels` und `POST /api/automation/channels/adopt` (nur Admin, Audit `automation.channels` / `automation.channels.adopt`), Seite `/automatik/channels`. Je Bereich (ein Eltern-Channel, höchstens ein Bereich je Eltern-Channel): Namen als „Bezeichnung + Nummer“ oder aus einer Liste, Zahl der immer freien Channels (1–5), Höchstzahl, Client-Limit, Sprachqualität, Beitritts-/Sprechmacht, Beschreibung. Neue Channels sind permanent, füllen Lücken in der Nummerierung und werden hinter ihren Vorgänger einsortiert; überzählige leere verschwinden, höchste Nummer zuerst. **Gelöscht wird nur, was in `managed_channels` steht** – fremde Channels gleichen Namens bleiben stehen, ihr Name gilt als belegt. Vorhandene Channels (etwa die des alten Skripts) übergibt der Knopf „Vorhandene Channels übernehmen“ ausdrücklich an den Bot. Die Channelliste wird einmal je Abfrage gelesen; dazwischen arbeitet das Modul auf dieser Kopie und der Live-Sicht, sodass ein Channel-Wechsel keinen zusätzlichen Query-Befehl kostet und trotzdem sofort ein neuer Channel entsteht. Gelöscht wird ohne `force`: Ist inzwischen jemand drin, lehnt der Server ab. Nach einem Neustart gilt die Tabelle weiter; von Hand gelöschte Channels werden beim nächsten Abgleich vergessen und ersetzt. Im Testmodus ein Protokolleintrag je geändertem Plan, nicht je Abfrage. `ApiContext` kennt jetzt `channels()` für die Live-Channelliste. Sichtprüfung per Screenshot folgt mit T10.11.
- [x] **T10.7 Privat-Channel** · `DB` `Backend` `Frontend` · braucht: T10.6
  - Wer die Lobby betritt, bekommt einen eigenen Channel (Namensvorlage mit Nickname), wird hineinverschoben und erhält dort die eingestellte Channel-Gruppe; ein vorhandener eigener Channel wird wiederverwendet
  - Einstellbar: Eltern-Channel, Lebensdauer (temporär mit Löschverzögerung, semi-permanent, permanent), Beschreibung, optionales Passwort (per Privatnachricht), erlaubte Gruppen
  - Schutz vor Missbrauch: Wartezeit je Nutzer
  - Fertig wenn: Tests für Anlegen, Wiederverwenden, gelöschter Channel, Wartezeit, nicht erlaubte Gruppe
  - Notiz: Modul `src/automation/modules/private.ts`, API `GET/PUT /api/automation/private` (nur Admin, Audit `automation.private`), Seite `/automatik/private`. Je Eingang: Eingangs-Channel, Eltern-Channel, Namensvorlage mit `{name}`, Channel-Gruppe für den Besitzer, Lebensdauer (temporär mit Löschverzögerung bis 31 Tage, semi-permanent, permanent), Client-Limit, Sprachqualität, Beschreibung, optional erzeugtes Passwort (per Privatnachricht, nie im Protokoll), erlaubte Servergruppen. Der eigene Channel wird über `managed_channels` (Besitzer = Spieler) wiedergefunden; ist er auf dem Server weg, entsteht ein neuer. Bei gleichem Nickname bekommt der zweite Channel „(2)“. Ein temporärer Channel zieht den Bot hinein – er merkt sich vorher per `whoami` seinen Channel und geht danach zurück. Wartezeit je Spieler nur für das Anlegen (Vorgabe 30 s), die Rückkehr in den eigenen Channel geht immer. Spieler ohne erlaubte Gruppe bekommen eine Nachricht und einen Channel-Kick. Verschwundene Channels werden beim nächsten Abgleich vergessen. Die Channel-Gruppen kommen live vom Server (`ApiContext.channelGroups`); ist der Bot offline, trägt man die Nummer ein. Am echten Server zu prüfen: `channel_delete_delay` beim Anlegen und ob der Query-Account die Channel-Gruppe setzen darf. Sichtprüfung per Screenshot folgt mit T10.11.
- [x] **T10.8 Regelbestätigung** · `DB` `Backend` `Frontend` · braucht: T10.2
  - Regeltext mit Version; eine neue Version verlangt die Bestätigung erneut. Zustellung als Privatnachricht (beim Beitritt oder in einem Regel-Channel)
  - Bestätigung per Chat-Befehl und/oder Bestätigungs-Channel; danach optional Servergruppe setzen. Ablehnen oder Frist verstrichen: optional Kick bzw. andere Gruppe
  - Stand je Spieler (Version, Zeitpunkt) in der DB und auf der Spielerseite
  - Fertig wenn: Tests für beide Wege, neue Version, Frist, Ausnahmen, Gruppen nur aus der eigenen Konfiguration
  - Notiz: Modul `src/automation/modules/rules.ts`, Tabelle `rule_acceptances` (Migration 0016: letzte Entscheidung je Spieler mit Regel-Version), API `GET/PUT /api/automation/rules` (nur Admin, Audit `automation.rules` ohne Regeltext) und `GET /api/users/:id/rules` (ab Moderator), Seite `/automatik/rules`, Hinweis auf der Spielerseite. Die Regeln gehen als Privatnachrichten raus (eine je Absatz, bis 30), beim Verbinden oder beim Betreten eines Regel-Channels; danach die Aufforderung. Bestätigung per Antwort an den Bot (Wörter frei wählbar, Groß-/Kleinschreibung egal) und/oder durch Betreten eines Bestätigungs-Channels (danach zurück in den vorherigen oder einen festen Channel). Wer die aktuelle Version bestätigt hat, wird nicht mehr gefragt und bekommt die eingestellte Servergruppe – auch nachträglich beim nächsten Beitritt. Ablehnen entfernt die Gruppe, optional mit Kick; optional Frist mit Kick (geprüft bei jeder Abfrage, also bis zu eine Minute spät). Eine höhere Version fragt alle erneut; **die Gruppe bleibt dabei bis zur neuen Entscheidung stehen** (bewusst nicht entzogen – falls gewünscht, als Option nachrüsten). Rang-Gruppen werden beim Speichern und zusätzlich in `ModuleActions` abgelehnt. Wer beim Start des Dienstes schon online ist, wird nicht angeschrieben, sondern beim nächsten Beitritt; wer sich binnen einer Minute neu verbindet, bekommt die Regeln nicht doppelt. Im Testmodus wird nichts gesendet und keine Entscheidung gespeichert. Der Host reicht dafür Privatnachrichten als `onMessage` an die Module. Entscheidungen werden bei Anonymisierung gelöscht und stehen im Datenexport. Sichtprüfung per Screenshot folgt mit T10.11.
- [x] **T10.9 Spam-Control** · `Backend` `Frontend` · braucht: T10.2
  - Getrennt nach Aktion, jeweils mit eigenem Zeitfenster und eigenen Schwellen: Channel-Wechsel (nur selbst ausgelöst), Channel anlegen, Nickname ändern, schnelles Neuverbinden, Auslösen der Lobby
  - Stufen je Aktion: Verwarnung (Anstupsen oder Nachricht) → Kick → zeitlicher Ban
  - Fertig wenn: Tests für gleitendes Fenster, Stufen, Ausnahmen, verschobene Nutzer zählen nicht
  - Notiz: Zählung als reine Logik in `src/domain/spam.ts` (`SlidingCounter`, `spamStep`), Modul `src/automation/modules/spam.ts`, API `GET/PUT /api/automation/spam` (nur Admin, Audit `automation.spam`), Seite `/automatik/spam`. Fünf Arten, jede einzeln schaltbar mit eigenem Zeitfenster, eigenen Schwellen, Ban-Dauer und Texten: Channel-Wechsel (nur selbst ausgelöst – verschoben werden und per Abfrage bemerkte Wechsel zählen nicht), Channels anlegen (dafür reicht der Host `channelCreated` an die Module), Nickname ändern, schnelles Neuverbinden, Eingang der Privat-Channels. Drei Stufen je Art: Verwarnung (Anstupsen oder Nachricht) und Kick lösen genau beim Erreichen ihrer Schwelle aus, der Ban ab seiner Schwelle; 0 schaltet eine Stufe ab, die übrigen müssen ansteigen (API und Seite prüfen das). Gezählt wird je Spieler, nicht je Verbindung, sodass Neuverbinden den Zähler nicht zurücksetzt; nach einem Ban beginnt er neu. Bans sind immer zeitlich begrenzt (1 Minute bis 30 Tage). **Einschränkung:** Umbenennungen sieht der Bot nur bei der Abfrage, also höchstens eine je Minute – das Fenster dafür ist mit 10 Minuten vorbelegt. Nicht umgesetzt: Chat-Spam (ein Query-Client sieht nur Server-Chat und den eigenen Channel) und Anstupsen unter Spielern (für ServerQuery unsichtbar). Sichtprüfung per Screenshot folgt mit T10.11.
- [x] **T10.10 Anti-Proxy** · `DB` `Backend` `Frontend` `Security` · braucht: T10.2
  - Prüfung im IP-Schritt des Watchers (IP nur im Speicher): zuerst lokale Liste (HMAC-Hash), sonst Online-Dienst – nur für Nutzer, die noch nie ohne Proxy verbunden waren
  - Treffer: Hash auf die lokale Liste, Aktion nach Einstellung (Gruppe setzen, Nachricht, Anstupsen, Kick, zeitlicher Ban), Hinweis auf der Spielerseite, optional Meldung an Team-Gruppen und Discord
  - Ausnahmen: Servergruppen und einzelne Spieler; Einträge der lokalen Liste lassen sich im Webinterface entfernen (Fehlalarm)
  - Dienst nicht erreichbar oder Kontingent erschöpft: nichts tun, später erneut prüfen, Warnung im Bot-Status
  - API-Schlüssel nur aus `.env`; Datenschutz-Doku ergänzen (IP-Weitergabe an Dritten)
  - Fertig wenn: Tests für Liste, einmal sauber = nie wieder, Ausfall des Dienstes, keine Klar-IP in DB, Log oder Protokoll
  - Notiz: Dienst ist **proxycheck.io** (Entscheidung 03.10.2026), Abfrage in `src/automation/proxycheck.ts`, Modul `src/automation/modules/proxy.ts`, Tabellen `proxy_ips` (lokale Liste, nur HMAC-Hash) und `proxy_checks` (Ergebnis je Spieler) in Migration 0017, API `GET/PUT /api/automation/proxy`, `POST /api/automation/proxy/clear/:id` (nur Admin, Audit `automation.proxy` / `automation.proxy.clear`) und `GET /api/users/:id/proxy` (ab Moderator), Seite `/automatik/proxy`, Warnhinweis auf der Spielerseite. Die Prüfung hängt am IP-Schritt des Watchers (`IpProcessor.onAddress`): Die Adresse wird dort gehasht und nur im Speicher an das Modul gereicht. Reihenfolge: ausgenommen? → schon einmal sauber? → private Adresse? → lokale Liste (keine Abfrage) → Online-Dienst. Treffer: Hash auf die Liste, Spieler als „mit Befund“ vermerkt, Aktion nach Einstellung (nur vermerken, Nachricht, Anstupsen, Servergruppe + Nachricht, Kick, zeitlicher Ban), optional Privatnachricht an Team-Gruppen und Discord-Ereignis `proxy.detected`. Ohne Befund gilt der Spieler dauerhaft als sauber und wird nie wieder geprüft; ein Spieler mit Befund wird bei jedem Beitritt neu geprüft. Antwortet der Dienst nicht (Zeitüberschreitung, Kontingent, Fehler), passiert nichts, der Spieler wird beim nächsten Beitritt erneut geprüft und es gibt höchstens alle 10 Minuten eine Warnung im Log bzw. Bot-Status. Fehlalarm: „Als sauber markieren“ entfernt die Adressen dieses Spielers von der Liste. Der Schlüssel kommt aus `PROXYCHECK_API_KEY` (`.env.example` ergänzt), die Seite zeigt nur, ob einer gesetzt ist. **Wichtig:** Auch im Testmodus gehen die Adressen an den Dienst – sonst gäbe es nichts zu protokollieren; die Seite und `docs/datenschutz.md` sagen das ausdrücklich. Ein Test liest nach einem Treffer alle Tabellen aus und prüft, dass keine Klar-IP darin steht. Am echten Dienst ungeprüft: Antwortformat und Kontingentmeldung kenne ich nur aus der Dokumentation von proxycheck.io (API v2).
- [x] **T10.11 Doku** · `Docs` · braucht: T10.3–T10.10
  - README, Betriebsdoku (Rechte des Query-Accounts je Modul, Umstieg vom SinusBot), Screenshots aus der synthetischen Datenbank
  - Notiz: Neue Datei `docs/automatik.md` (Grundsätze, Module, Rechte je Modul, Umstieg vom SinusBot, Grenzen); README um Abschnitt, Funktionsliste und Screenshot ergänzt, `docs/betrieb.md` um Verweis und `PROXYCHECK_API_KEY`, `docs/datenschutz.md` schon in T10.10. Die **Sichtprüfung** aller neun Seiten ist nachgeholt (hell, Übersicht auch dunkel) – gegen eine kleine synthetische Datenbank mit erfundenen Einstellungen, ohne TeamSpeak-Verbindung. Dabei behoben: abgeschnittene Auswahlfelder, zu hohe Knöpfe neben Eingabefeldern, Ausrichtung der Gruppennamen in der Staffliste, rechtsbündige Modul-Tabelle. Zwei Screenshots liegen unter `docs/screenshots/`. Die Rechte-Namen in `docs/automatik.md` stammen aus der TeamSpeak-Rechteliste und sind **nicht am echten Server geprüft**. Nicht optisch geprüft: schmale Bildschirme.

## Phase 11 – Updater

Entscheidung (13.10.2026): Hinweis im Webinterface **und** Knopf für Admins; installiert werden ausschließlich veröffentlichte GitHub-Releases, nie von selbst.

- [x] **T11.1 Updater** · `Backend` `Frontend` `Ops` · braucht: T7.1
  - `setup.ps1 update` holt das neueste Release (oder `-Version`), statt `git pull` auf `main`
  - Täglicher Blick auf die Releases, Anzeige auf der Seite „Bot-Status“
  - „Update installieren“ für Admins: Der Dienst übergibt an das Setup-Skript
  - Notiz: `src/update/updater.ts` (Abfrage von `releases/latest`, Vergleich über `src/domain/version.ts`, Start des Skripts), API `GET /api/update`, `POST /api/update/check`, `POST /api/update/install` (nur Admin, Audit `update.install`), Karte „Version und Updates“ auf der Seite „Bot-Status“, Job `update-check` (täglich), Konfiguration `UPDATE_CHECK`, `UPDATE_REPO`, `SERVICE_NAME`. **Nur Releases:** Entwürfe, Vorabversionen und alles, was nicht `vX.Y.Z` heißt, werden verworfen; die Install-Route nimmt keine Version entgegen, sondern installiert nur das Release der letzten Prüfung – so gelangt kein Text aus einer Anfrage auf eine Kommandozeile. Das Skript checkt das Release-Tag aus (losgelöster HEAD), bricht bei lokalen Änderungen vorher ab, schreibt `data/update-status.json` und stellt bei gescheitertem Build den vorherigen Stand wieder her. Der Dienst startet das Skript über WMI (`Win32_Process.Create`), damit es nicht in seinem Prozessbaum hängt – NSSM beendet beim Anhalten den ganzen Baum. **Praktisch geprüft:** Release-Abfrage und Tag-Auflösung des Skripts gegen das echte Repository, Statusdatei, und dass der über WMI gestartete Prozess `WmiPrvSE.exe` als Elternprozess hat und den Aufrufer überlebt. **Nicht geprüft:** ein vollständiges Update gegen einen echten Windows-Dienst (braucht Administratorrechte und NSSM) – das erste Update auf dem Produktivsystem bitte von Hand mit `setup.ps1 update` beobachten. Offen als Vorschlag: Hinweis in der Navigation und Discord-Meldung bei neuem Release.

- [x] **T11.2 Update ohne Git** · `Ops` `Backend` · braucht: T11.1
  - Anlass (13.10.2026): Das Produktivsystem ist kein Git-Verzeichnis; `setup.ps1 update` von 1.0 hat dort nichts geholt, sondern nur neu gebaut, und der Updater aus T11.1 setzte Git voraus
  - Notiz: Ohne `.git` lädt `setup.ps1 update` das Release als Archiv (`https://github.com/<repo>/archive/refs/tags/<tag>.zip`), prüft, dass die Version darin zum Tag passt, und ersetzt `src`, `web`, `drizzle`, `scripts`, `docs` (gespiegelt, also ohne Altlasten gelöschter Dateien) sowie die Dateien im Hauptordner. `data\`, `.env`, `node_modules`, `web\dist` und eigene Dateien im Hauptordner bleiben. Der Download läuft, bevor der Dienst angehalten wird. Der vorherige Stand liegt unter `data\update-rollback` und wird bei gescheitertem Build zurückgespielt. Installationen mit `.git` verhalten sich wie in T11.1. Der Dienst bietet den Knopf jetzt auch ohne Git an (Sperrgrund `no_git` entfällt). **Praktisch geprüft** an einer nachgestellten Installation aus dem v1.0.0-Archiv: Sprung auf 1.2.0 und zurück, eigene Dateien, Datenbank, `.env` und `node_modules` unberührt, gelöschte Quelldateien verschwinden. **Nicht geprüft:** der Teil mit Dienst, Build und Start unter NSSM. Eigene Änderungen innerhalb der Programmverzeichnisse (z. B. eine angepasste `setup.ps1`) gehen beim Update verloren – steht in `docs/betrieb.md`.

- [x] **Fehler: Staffliste wird vom Server abgelehnt** (13.10.2026, aus `debug-logs/`)
  - Meldung im Log des Produktivsystems: `staff.update` scheitert mit „invalid parameter size“ (Fehler 1541)
  - Notiz: Der Server zählt die 8.192 erlaubten Zeichen einer Channel-Beschreibung als **Bytes** (UTF-8), die Staffliste hat Zeichen gezählt. Jede Zeile der Vorgabe enthält einen Gedankenstrich (3 Bytes), dazu kommen Umlaute – eine Liste, die gekürzt werden musste, landete deshalb immer knapp über dem Limit. `renderStaffList` misst jetzt Bytes (`byteLength`, `truncateBytes` in `src/domain/staff-list.ts`), das Protokoll nennt die Größe in Bytes. Die Größe der betroffenen Liste stand nicht im Log; die Erklärung passt zum Fehler, ist aber am Server noch nicht bestätigt. Nebenbefund: Nach einem gescheiterten Schreiben versucht das Modul es erst wieder, wenn sich der Text ändert – deshalb stand der Fehler nur einmal im Log.

- [x] **Staffliste: verknüpfte Accounts nur einmal** (13.10.2026, Wunsch des Betreibers)
  - Zweitaccounts von Teammitgliedern standen einzeln in der Liste
  - Notiz: `StaffModule` fasst Accounts, die als Person verknüpft sind (T5.3), zu einem Eintrag unter dem Haupt-Account zusammen – auch über mehrere Gruppen hinweg und auch dann, wenn nur der Zweitaccount in der Gruppe ist. Status: online, sobald einer der Accounts verbunden ist. Name: aktueller Nickname des Haupt-Accounts, sonst sein zuletzt gespeicherter, sonst der Name aus der Gruppenliste des Servers. Der anklickbare Link zeigt auf den Haupt-Account. Nicht verknüpfte Zweitaccounts bleiben einzeln – verknüpft wird auf der Spielerseite.

- [x] **Regelbestätigung: englische Fassung nach Land** (13.10.2026, Wunsch des Betreibers)
  - DACH bekommt Deutsch, der Rest Englisch
  - Notiz: Neuer Abschnitt `english` in den Einstellungen der Regelbestätigung (Regeltext, beide Wörter, Aufforderung, Texte nach der Entscheidung, Kick-Grund), abschaltbar, ab Werk aus – bestehende Einstellungen ändern ihr Verhalten nicht. Die Sprache bestimmt `ruleLanguage`: `DE`, `AT`, `CH`, `LI` → Deutsch, sonst Englisch; unbekanntes Land → Deutsch. Quelle ist `users.country` (vom TeamSpeak-Server beim Verbinden gemeldet, mit GeoLite2 zusätzlich aus der IP). Version, Channels, Servergruppe und Frist sind gemeinsam; die Wörter zum Bestätigen und Ablehnen werden in beiden Sprachen verstanden, egal in welcher Sprache die Regeln kamen. Ein Wort darf nicht in einer Sprache bestätigen und in der anderen ablehnen (API und Seite prüfen das). Die Bestätigung per Channel ist sprachneutral. Offen: Die Texte der übrigen Module (Support, Privat-Channel, Spam, Nickname, Anti-Proxy) sind weiterhin einsprachig.

- [x] **Anti-Proxy als Einladungssystem** (13.10.2026, Wunsch des Betreibers)
  - Spieler mit Proxy bekommt eine einschränkende Gruppe, wählt per Nummer einen Spieler aus der Liste der Anwesenden; bestätigt dieser, gibt es die Freigabe-Gruppe und einen Move in dessen Channel (nicht in AFK-Channels)
  - Notiz: Neue Aktion `invite` im Anti-Proxy-Modul, Ablauf in `src/automation/modules/proxy-invite.ts` (`ProxyInvites`), Tabelle `proxy_vouches` (Migration 0018: wer für wen gebürgt hat), Einstellungen unter `invite` (Freigabe-Gruppe, Gruppen der Bürgen, Frist, Versuche, alle Texte, Wörter für ja/nein). Die einschränkende Gruppe ist das vorhandene Feld `groupId`. Freigegeben ist, wer die Freigabe-Gruppe hat – die Gruppe auf dem Server ist die Wahrheit, damit ein Admin die Freigabe durch Wegnehmen widerrufen kann; ohne Freigabe-Gruppe zählt der eigene Eintrag. Liste: höchstens 60 Personen, nach Name, jede einmal, nie andere Eingeschränkte, in Nachrichten unter 1.024 Zeichen aufgeteilt, BBCode in Nicknames entschärft. Je Verbindung begrenzte Zahl von Anfragen (Vorgabe 3); Frist für die Antwort (Vorgabe 300 s, geprüft bei jeder Abfrage); geht der Gefragte offline, darf neu gewählt werden. Ein „ja“ von jemandem, der nicht gefragt wurde, zählt nicht. Wer ohne Proxy wiederkommt, verliert die einschränkende Gruppe (gilt jetzt auch für die Aktion „Servergruppe setzen“). Rang-Gruppen und gleiche Gruppe für Sperre und Freigabe werden beim Speichern abgelehnt. Spielerseite und `GET /api/users/:id/proxy` nennen den Bürgen; „Als sauber markieren“ löscht auch die Bürgschaft. Der Ablauf-Stand liegt nur im Speicher (nach Neustart kommt die Liste beim nächsten Beitritt erneut). **Voraussetzung auf dem Server:** Die einschränkende Gruppe muss Privatnachrichten an den Query-Client zulassen. Nicht umgesetzt: englische Texte für diesen Ablauf, Auswahl per Name statt Nummer.

---

## Phase 12 – Ausbau

Aufgenommen am 16.10.2026 auf Wunsch des Betreibers. Details, die er nicht festgelegt hat, sind als Vorschlag markiert und vor Beginn kurz mit ihm abzustimmen.

- [ ] **T12.1 Englische Texte für alle Bot-Module** · `Backend` `Frontend` · braucht: T10.11
  - Anlass: Offener Punkt aus „Regelbestätigung: englische Fassung nach Land“. Bisher sprechen nur die Regeln Englisch; Support-Channel, Privat-Channel, Spam-Control, Nickname-Checker und Anti-Proxy (inkl. Einladungssystem) schreiben Spielern nur auf Deutsch
  - Sprachwahl wie bei den Regeln über `ruleLanguage` (`DE`, `AT`, `CH`, `LI` → Deutsch, sonst Englisch, unbekanntes Land → Deutsch); die Funktion dafür aus `rules.ts` in eine gemeinsame Stelle unter `/domain` ziehen
  - Je Modul ein Abschnitt `english` mit allen Texten, die **Spieler** sehen (Nachrichten, Pokes, Kick-Gründe), abschaltbar, ab Werk aus; bestehende Einstellungen ändern ihr Verhalten nicht. Texte an das Team (z. B. die Benachrichtigung der Supporter) bleiben einsprachig
  - Wörter zum Antworten (Anti-Proxy-Einladung ja/nein) werden in beiden Sprachen verstanden, unabhängig von der Sprache der Frage; ein Wort darf nicht in einer Sprache zustimmen und in der anderen ablehnen (API und Seite prüfen das, wie bei den Regeln)
  - Einstellungsseiten: englische Felder je Modul in einem eigenen, einklappbaren Bereich; gemeinsame Bausteine statt sechsmal derselben Karte
  - Fertig wenn: Tests je Modul für Deutsch, Englisch, unbekanntes Land und ausgeschalteten Abschnitt; Migration bestehender Einstellungen ohne Verhaltensänderung; `docs/automatik.md` ergänzt

- [ ] **T12.2 Netzwerk-Seite ausbauen: Filter und Farben** · `Backend` `Frontend` · braucht: T9.2
  - Ziel: Im Graphen schneller sehen, wer zu welcher Gruppe gehört, und gezielt einzelne Spieler oder Kreise betrachten
  - Vorschlag Filter (Zustand in der URL, wie der Zeitraum):
    - Spielersuche: Spieler hervorheben und auf ihn zoomen; Umschalter „nur sein Umfeld“ (direkte Nachbarn, optional zweiter Grad)
    - Mindestzeit je Verbindung zusätzlich zur Anzahl gezeigter Verbindungen
    - Nach Servergruppe bzw. Rang und nach Land ein- oder ausblenden
    - Einzelne Knoten ohne Verbindung nach dem Filtern ausblenden
    - Umschalter Kantengewicht „gemeinsame Stunden“ / „Anteil an der eigenen Zeit“ (die API liefert `shareA`/`shareB` bereits, siehe Entscheidung in Phase 9)
  - Vorschlag Farben, auswählbar mit Legende:
    - **Gruppen (Communities):** Der Tagesjob bestimmt Cluster (z. B. Louvain als reine Funktion in `/domain`) und speichert sie je Zeitraum am Knoten (Migration); Farbe je Cluster
    - **Rang** (Rangleiter aus `ranks`) oder **höchste Servergruppe** (`users.server_groups`)
    - **Land** (`users.country`)
    - **Aktivität:** zuletzt gesehen (z. B. aktiv / länger weg / inaktiv)
  - Farben aus der vorhandenen Palette (`web/src/charts/palette.ts`), hell und dunkel lesbar; bei mehr Kategorien als Farben die kleinsten als „Sonstige“ zusammenfassen
  - API: `GET /api/network` liefert je Knoten zusätzlich Cluster, Rang, Servergruppen, Land und zuletzt gesehen; Filter, die die Datenmenge verkleinern (Mindestzeit, Spieler-Umfeld), serverseitig; reine Darstellungsfilter im Frontend. Weiterhin nur Admin, weiterhin unter 100 ms (gegen `data/synthetic.sqlite` messen)
  - Tabelle der stärksten Paare folgt denselben Filtern
  - Fertig wenn: Tests für Cluster-Funktion (getrennte Gruppen, eine Gruppe, leerer Graph, deterministisch), Route (neue Felder, Filter, Rechte) und Seite (Filter lösen Anfragen aus bzw. blenden aus, Legende, Farbmodus); Screenshot hell und dunkel; README und `docs/performance.md` ergänzt


## Phase 13 – Bindung & Achievements

Aufgenommen am 16.10.2026 auf Wunsch des Betreibers. Details, die er nicht festgelegt hat, sind als Vorschlag markiert und vor Beginn kurz mit ihm abzustimmen.

Grundsätze (Vorschlag):

- Alles auf **Personenebene** (verknüpfte UIDs zusammen, wie T5.3). Ein Achievement gehört der Person und erscheint auf allen ihren UIDs.
- Spielzeit-Achievements zählen die **Rangzeit** (Legacy-Zeit bis `legacy_cutoff` plus Live-Zeit, Regel 12), damit langjährige Spieler sie nicht neu erspielen müssen. Achievements nach Uhrzeit, Serie oder Aktivität brauchen Live-Daten und gelten erst ab Live-Tracking; die Seite weist darauf hin (wie T8.7).
- Achievements werden nur vergeben, nie entzogen. Ausnahme: das Löschen nach DSGVO (T7.2) entfernt sie mit.
- Schwellen und Texte stehen in einem festen Katalog im Code (`/domain`). Im Webinterface lässt sich jedes Achievement nur ein- oder ausschalten.
- Ausgewertet wird in einem Job aus den Aggregaten (`user_daily_stats`, `user_totals`, `server_hourly`, `network_edges`) und den Sessions des letzten Laufs, nie per Vollscan über Rohdaten bei jedem Aufruf.

Vorschlag Katalog (Stufen Bronze / Silber / Gold / Platin, wo angegeben):

| Gruppe | Achievement | Bedingung |
|---|---|---|
| Spielzeit | **Stammgast** (Stufen) | 10 / 100 / 500 / 1.000 / 2.500 h Rangzeit |
| Spielzeit | **Aktivposten** (Stufen) | 50 / 250 / 1.000 h aktive Zeit (ohne idle/AFK) |
| Treue | **Urgestein** (Stufen) | 1 / 2 / 5 / 10 Jahre seit dem ersten Besuch, im letzten Jahr noch gesehen |
| Treue | **Pionier** | unter den ersten 100 Nutzern des Servers (nach `first_seen`) |
| Treue | **Comeback** | nach mindestens 180 Tagen Pause wieder da |
| Serie | **Dauerbrenner** (Stufen) | an 7 / 30 / 100 Tagen in Folge mindestens 15 min online |
| Serie | **Wochenendkrieger** | an 10 Wochenenden in Folge Samstag oder Sonntag online |
| Session | **Marathon** (Stufen) | eine Session von 4 / 8 / 12 h |
| Uhrzeit | **Nachteule** | 25 Sessions, die zwischen 0 und 5 Uhr (Berlin) laufen |
| Uhrzeit | **Frühaufsteher** | 25 Sessions, die vor 7 Uhr (Berlin) beginnen |
| Uhrzeit | **Silvester** | zum Jahreswechsel um Mitternacht online |
| Uhrzeit | **Geburtstagskind** | am Jahrestag des ersten Besuchs online |
| Sozial | **Gesellig** (Stufen) | mit 10 / 25 / 50 verschiedenen Spielern je mindestens 1 h gemeinsam online (Netzwerk, Zeitraum „gesamt“) |
| Sozial | **Unzertrennlich** | 250 h gemeinsam mit derselben Person |
| Sozial | **Rekordnacht** | online, als der Server einen neuen Allzeit-Rekord an Nutzern erreicht hat |
| Server | **Weltenbummler** | in 25 verschiedenen Channels gewesen |
| Server | **Gipfelstürmer** | den höchsten Rang der Rangleiter erreicht |
| Geheim | **Geheim-Achievements** | auf der Seite als „???“ angezeigt, bis jemand sie hat (z. B. genau 1 Minute nach Mitternacht am 1.1. verbunden, 1.000. Session) |

- [x] **T13.1 Bindung & Abwanderung** · `Backend` `Frontend` · braucht: T3.2, T5.3
  - Neue Seite unter Statistik (alle Rollen, Liste vermisster Spieler wie die Spielerseiten)
  - **Kohorten:** Personen nach Monat des ersten Besuchs; Anteil, der nach 7 / 30 / 90 Tagen wieder online war (mind. ein Tag mit Online-Zeit ab Tag N), als Tabelle mit Farbskala
  - **Monatsbilanz:** je Monat aktive Personen, davon neu, wiedergekehrt (nach ≥ 90 Tagen Pause) und verloren (im Vormonat aktiv, seitdem nicht mehr), als Diagramm
  - **Vermisste Stammspieler:** Personen mit mindestens X h in den 90 Tagen vor ihrem letzten Besuch, die seit Y Wochen fehlen (X, Y in der Seite einstellbar, Vorschlag 20 h und 4 Wochen); Spalten letzter Besuch, Gesamtzeit, Rang; Link zur Spielerseite; CSV-Export wie T3.8
  - Berechnung im täglichen Job in eine Cache-Tabelle (Migration), da Kohorten über den Zeitraum „gesamt“ zu teuer für eine Live-Abfrage sind; importierte Sessions zählen mit (Online-Zeit reicht)
  - Fertig wenn: reine Funktionen in `/domain` mit Tests (leere Kohorte, Rückkehr genau an Tag N, verknüpfte UIDs, Tagesgrenze Berlin); Route- und Seitentests; Abfrage < 100 ms auf dem synthetischen Datensatz, Ergebnis in `docs/performance.md`
  - Notiz: Logik in `src/domain/loyalty.ts`, täglicher Job `loyalty` (`src/loyalty/job.ts`) schreibt Migration 0020 (`loyalty_cohorts`, `loyalty_months`, `loyalty_players`, STRICT); Seite `/bindung`, API `/api/loyalty`, `/api/loyalty/missing(.csv)`, Neuberechnung für Admins mit Audit-Eintrag. Grundlage sind die Tage aus `user_daily_stats` (Berliner Kalendertage, damit ist die Tagesgrenze schon richtig). Abweichung: „verloren“ zählt im Monat des letzten Besuchs, sobald jemand 30 Tage nicht mehr da war (nicht „im Vormonat aktiv“), damit der laufende Monat nicht jeden als verloren zeigt, der nur zwei Wochen fehlt. Rückkehr nach N Tagen heißt: letzter Besuch mindestens N Tage nach dem ersten. Gemessen: Seite 0,3–6 ms, Job 0,6 s.

- [x] **T13.2 Achievement-Katalog & Engine** · `DB` `Backend` · braucht: T5.3, T6.1
  - Katalog als Daten in `/domain/achievements` (ID, Gruppe, Stufen, Schwellen, geheim ja/nein); Namen und Beschreibungen in der Übersetzungsdatei
  - Reine Funktion: aus den Kennzahlen einer Person (Rangzeit, aktive Zeit, Serien, längste Session, Sessions nach Uhrzeit, Kontakte, Channels, Rang) die erreichten Stufen und das Erreichungsdatum bestimmen
  - Migration: Tabelle `achievements_earned` (person bzw. user, achievement_id, Stufe, earned_at, `backfilled`), eindeutig je Person, Achievement und Stufe; Fortschritt wird nicht gespeichert, sondern beim Anzeigen aus den Aggregaten berechnet
  - Fertig wenn: Tests je Achievement für Grenzwerte (knapp darunter, genau, darüber), Stufen, verknüpfte UIDs, Legacy-Zeit, Sommer-/Winterzeit bei den Uhrzeit-Achievements; DSGVO-Löschung und -Export (T7.2) enthalten die neue Tabelle
  - Notiz: Katalog in `src/domain/achievements.ts` (25 Achievements, `CATALOG_VERSION`), Fakten je Person in `src/achievements/facts.ts`, Migration 0019 (`achievements_earned`, STRICT, WITHOUT ROWID). Zeilen gehören dem Account, der beim Erreichen Hauptaccount der Person war; Lesen fasst immer alle Accounts der Person zusammen, so geht beim Verknüpfen oder Lösen nichts verloren. Gegenüber dem Vorschlag hinzugekommen (Prüfung am 16.10.2026, was die Daten hergeben): Veteran (Zeit im alten Ranking), Bürge (Anti-Proxy-Einladung), Hausherr (Privat-Channel), Unterwegs (Android/iOS) und vier geheime: Punktlandung (erste zwei Minuten des Jahres), Jubilar (1.000 Sessions), Namenswechsler (10 Nicks), Schlafmütze (100 h AFK). Abweichung vom Grundsatz oben: Uhrzeit-, Serien- und Treue-Achievements nutzen auch importierte Sessions (die Logs haben Beginn und Ende); nur aktiv/AFK, Channels, Netzwerk, Plattform, Privat-Channel und Bürge brauchen Live-Daten. Katalog für Betreiber: `docs/achievements.md`.

- [x] **T13.3 Achievement-Job & Nachberechnung** · `Backend` · braucht: T13.2
  - Läuft nach dem Schreiben der Aggregate (Vorschlag alle 15 min) und prüft nur Personen, die seit dem letzten Lauf online waren; Voll-Lauf nach Katalog- oder Einstellungsänderung
  - Erster Lauf berechnet alle Achievements aus der vorhandenen Historie nach (`backfilled = 1`, Datum so genau wie die Daten es hergeben), ohne Nachrichten zu verschicken
  - Schreiben gebündelt in einer Transaktion; ein erneuter Lauf erzeugt keine Duplikate
  - Fertig wenn: Tests für inkrementellen Lauf, Voll-Lauf, Idempotenz und Nachberechnung auf Seed-Daten; Laufzeit des Voll-Laufs auf dem synthetischen Datensatz in `docs/performance.md`
  - Notiz: `src/achievements/job.ts`, Job `achievements` alle 15 min im `JobRunner`. Voll-Lauf, wenn sich Katalogversion, ausgeschaltete Achievements oder Verknüpfungen ändern (Fingerprint im Zustand `achievements.state`); dann `backfilled = 1` mit dem Datum aus den Daten. Normale Läufe datieren neue Stufen auf den Lauf. Voll-Lauf auf dem synthetischen Datensatz 4,2 s, normaler Lauf (Spieler der letzten Stunde) 0,9 s. Rekordstunden und Pioniere speichert der Job im Zustand, damit die Spielerseite sie nicht neu bestimmen muss. Gesellig/Unzertrennlich hängen am täglichen Netzwerk-Job und kommen daher bis zu einen Tag später.

- [x] **T13.4 Achievements im Webinterface** · `Backend` `Frontend` · braucht: T13.3
  - Spielerseite: Abzeichen mit Stufe und Datum, Fortschritt zur nächsten Stufe („noch 37 h bis Gold“), nachberechnete als solche gekennzeichnet
  - Übersichtsseite: alle Achievements mit Seltenheit (Anteil der Personen, die es haben), wer es zuletzt erreicht hat, Liste der Inhaber; geheime bleiben „???“, bis jemand sie hat
  - Dashboard: Kachel „Zuletzt erreicht“
  - Einstellungen (nur Admin): Achievements einzeln ein-/ausschalten, Eintrag im Audit-Log (Regel 10); ausgeschaltete werden ausgeblendet, nicht gelöscht
  - Fertig wenn: Route- und Seitentests (Rechte, geheime Achievements, Fortschritt, Seltenheit); Abfragen < 100 ms
  - Notiz: API `GET /api/achievements`, `GET /api/achievements/:id` (Inhaber, paginiert), `GET /api/users/:id/achievements` (alle Rollen), `GET/PUT /api/settings/achievements` und `POST /api/settings/achievements/run` (nur Admin, Audit `settings.achievements` / `achievements.run`). Seite `/achievements` (für alle Rollen in der Navigation), Karte auf der Spielerseite, Kachel „Zuletzt erreicht“ auf dem Dashboard (nur in normalen Läufen erreichte Stufen), Karte in den Einstellungen. Übersicht 26 ms, Spielerseite 19 ms, Inhaber 14 ms (p95 jeweils < 31 ms). Stufenfarben Bronze bis Diamant als Tokens in `styles.css`, hell und dunkel. Offen: Screenshot für die README.
  - Weitere Ideen, für die heute Daten fehlen: Redezeit („Plaudertasche“, bräuchte `client_flag_talking` im Polling), Chatnachrichten (der Bot sieht nur seine eigenen), Zeit mit dem Team („Teamplayer“, ginge über Servergruppen im Netzwerk), „Erster des Tages“ (ginge aus den Sessions, kostet aber eine serverweite Abfrage je Tag).

- [ ] **T13.5 Benachrichtigung bei neuen Achievements (optional)** · `Backend` `Frontend` · braucht: T13.4, T5.4
  - Private TS3-Nachricht an den Spieler (Text je Achievement anpassbar, Platzhalter für Name und Stufe), optional zusätzlich Discord; beides ab Werk aus, Testmodus an (Regel 7)
  - Nachrichten laufen über `ModuleActions` und die Query-Queue (Regel 5, 13), höchstens eine Nachricht je Person und Lauf (mehrere Achievements zusammengefasst); nachberechnete lösen nie eine Nachricht aus
  - Sprachwahl nach Land wie T12.1, sobald diese Aufgabe erledigt ist
  - Fertig wenn: Tests für Testmodus, Zusammenfassen, keine Nachricht bei Nachberechnung, offline gewordene Spieler (Nachricht beim nächsten Join oder verwerfen, Vorschlag: verwerfen)


---

## Gefundene Punkte

Hier tragen Agents Auffälligkeiten ein, die nicht zur aktuellen Aufgabe gehören.

- (T10.3) Ein abgebrochener `pnpm test` hinterlässt auf Windows den vitest-Hauptprozess, der weiter CPU verbraucht; spätere Testläufe hängen dann oder melden „Timeout terminating forks worker“. Abhilfe: übrig gebliebene `node`-Prozesse von vitest beenden. Einmal ist außerdem ein Frontend-Test-Worker mit einer Zugriffsverletzung (0xC0000005) abgestürzt, ohne Bezug zum Code – beobachten. Nachtrag T10.6: Das tritt inzwischen in etwa jedem zweiten Lauf auf, jedes Mal in einer anderen Datei (auch 0xC000001D); die Tests selbst bestehen im Wiederholungslauf. Verdacht: Node 24 mit dem `forks`-Pool von vitest 5 auf diesem Rechner – `pool: 'threads'` oder Node 22 ausprobieren.
- (T0.1) Auf dem Entwicklungsrechner ist pnpm nicht global installiert; aktuell per `corepack pnpm …` genutzt (Version über `packageManager` in package.json fixiert). Lokal läuft Node 24, Zielumgebung ist Node 22 LTS – `engines` steht auf `>=22`, `@types/node` auf 22.
