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

- [ ] **T4.5 Aktivitäts-Einstellungen im Webinterface** · `Backend` `Frontend` · braucht: T4.2, T2.3
  - Idle-Schwelle, AFK-Channels (Auswahl aus Channelliste), „Away = AFK“, „Lautsprecher stumm = AFK“ bearbeiten (nur Admin); Speichern über `saveActivitySettings`, Eintrag im Audit-Log
  - Hinweis im UI, dass Änderungen nur für künftige Zeiten gelten (bestehende Segmente bleiben)

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
