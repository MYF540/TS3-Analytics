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
  - Notiz: `web/src/pages/PlayersPage.tsx`: Suche (300 ms verzögert), Sortierung per Spaltenkopf (aria-sort), Gelegenheitsspieler-Schalter, Paginierung (50/Seite); gesamter Zustand in der URL (`q`, `sort`, `order`, `page`, `casual`). `PlayerPage.tsx`: Kopf mit Online-Status und UID, 6 Kennzahlen, gestapelte Tagesbalken aktiv/idle/AFK/unbekannt (30 Tage/1 Jahr, fehlende Tage als leere Balken, Tabellenansicht), letzte Sessions (laufend/importiert markiert), Top-Channels als Balkenliste, Nickverlauf, Länder mit Hinweis auf IP-Aufbewahrung. Farben: Kategorie-Slots 1–4 der Referenzpalette (validiert; Aqua/Gelb im Hellmodus < 3:1 → Legende + Tabelle). Dauern ab 100 h ohne Minuten. Per Screenshot mit synthetischen Daten geprüft.

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

- [ ] **T5.2 Alt- & Evasion-Erkennung** · `Security` · braucht: T5.1, T4.2
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
  - Notiz: `docs/betrieb.md` – Voraussetzungen, Installation (`pnpm build` → `dist/` + `web/dist/`, Start `node dist/main.js`), Rechte des Query-Accounts als Tabelle, Anti-Flood-Allowlist, NSSM-Dienst (`AppDirectory` ist Pflicht, sonst wird `.env` und `./data` nicht gefunden), Logs, Update-Ablauf, GeoLite2-Update, Liste der automatischen Jobs mit ihren Intervallen. Der Produktionspfad wurde einmal durchgespielt: Build, `node dist/main.js`, `/api/health` und die ausgelieferte Weboberfläche antworten. Offen bis zur Installation auf dem Server: die genauen Rechtenamen der Query-Gruppe und ob NSSM `AppExit Default Restart` hier wie gewünscht wirkt.

- [ ] **T7.4 Channel-Statistik** · `Backend` `Frontend` · braucht: T3.2
  - Nutzung pro Channel, ungenutzte Channels der letzten X Tage

- [ ] **T7.5 Öffentliche Leaderboard-Seite (optional)** · `Backend` `Frontend` `Security` · braucht: T4.1, T3.6
  - Eigener, getrennter HTTP-Listener (eigener Host/Port in der Config, Standard: aus), der ausschließlich eine schreibgeschützte Leaderboard-Ansicht ausliefert – ohne Login, ohne UIDs, ohne Links auf Spielerdetails
  - Bewusste Ausnahme von Regel 8, nur für diesen Listener; das Admin-Webinterface bleibt auf 127.0.0.1
  - Konfigurierbar, welche Leaderboards öffentlich sind; Spieler können per Override ausgeblendet werden (T6.5)
  - Fertig wenn: Test belegt, dass über den öffentlichen Listener keine andere API-Route erreichbar ist

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
