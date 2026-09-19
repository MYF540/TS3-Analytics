# Datenbank

SQLite über `better-sqlite3`, Schema und Migrationen mit Drizzle. Die Datei liegt standardmäßig unter `data/ts3-analytics.sqlite` (`SQLITE_PATH`).

## Verbindung

`openDatabase()` in `src/db/client.ts` setzt beim Öffnen:

| PRAGMA         | Wert                                 |
| -------------- | ------------------------------------ |
| `journal_mode` | `WAL`                                |
| `synchronous`  | `NORMAL`                             |
| `foreign_keys` | `ON`                                 |
| `temp_store`   | `MEMORY`                             |
| `busy_timeout` | `5000` ms                            |
| `cache_size`   | `SQLITE_CACHE_SIZE_MB` (Standard 64) |
| `mmap_size`    | `SQLITE_MMAP_SIZE_MB` (Standard 256) |

Beim Start führt der Dienst alle ausstehenden Migrationen aus (`runMigrations()`).

## Konventionen

- Alle Tabellen sind `STRICT`. Zusammengesetzte oder Text-Primärschlüssel (`user_daily_stats`, `ip_seen`, `settings`) sind zusätzlich `WITHOUT ROWID`.
- Zeitpunkte: UTC-Unix-Sekunden (`INTEGER`). Dauern: Sekunden.
- `user_daily_stats.day`: Kalendertag in `Europe/Berlin` als Zahl `YYYYMMDD` (z. B. `20260919`), damit unabhängig von der Zeitumstellung.
- Die TS3-UID steht nur in `users.uid`; alle anderen Tabellen referenzieren `users.id`.
- IP-Daten nur als HMAC-SHA256 (`BLOB`, 32 Byte) in `ip_seen`, nie im Klartext.
- Aktivitätszustände: `active`, `idle`, `afk`, `unknown` (importierte Zeiten).
- Offene Sessions haben `leave_at = NULL`; offene Segmente `is_open = 1`, `end_at` ist dann der Zeitpunkt der letzten Verlängerung.

## Tabellen (Überblick)

| Tabelle             | Zweck                                                                    |
| ------------------- | ------------------------------------------------------------------------ |
| `users`             | Ein Eintrag pro UID                                                      |
| `nicknames`         | Nickverlauf, dazu FTS5-Index `nicknames_fts` (Trigram, Teilstring-Suche) |
| `channels`          | Channel-Namen nach TS3-cid                                               |
| `sessions`          | Verbindungen (`source` = `live` oder `import`)                           |
| `activity_segments` | Zusammenhängende Abschnitte gleichen Zustands und Channels               |
| `user_daily_stats`  | Tagesaggregat pro Nutzer                                                 |
| `user_totals`       | Allzeit-Aggregat pro Nutzer (Leaderboards)                               |
| `server_minutely`   | Online-Zahl pro Minute (kurzfristig)                                     |
| `server_hourly`     | Stundenaggregat (dauerhaft)                                              |
| `ip_seen`           | IP- und Subnetz-Hashes pro Nutzer                                        |
| `settings`          | Schlüssel/JSON-Wert                                                      |

Das maßgebliche Schema steht in `src/db/schema.ts`.

## Schema ändern

1. `src/db/schema.ts` anpassen.
2. `pnpm db:generate --name <kurzer_name>` erzeugt `drizzle/NNNN_<name>.sql` und aktualisiert `drizzle/meta`.
3. Die erzeugte SQL-Datei prüfen und von Hand ergänzen, was drizzle-kit nicht abbildet:
   - `STRICT` (und ggf. `WITHOUT ROWID`) bei neuen Tabellen. Achtung: drizzle-kit baut Tabellen bei manchen Änderungen per „neue Tabelle anlegen, Daten kopieren, umbenennen“ neu auf – auch dort `STRICT` ergänzen.
   - FTS5-Tabellen und Trigger.
   - Bei großen Tabellen: Datenmigrationen in Batches bzw. Indizes bewusst anlegen.
4. `pnpm test` ausführen. `src/db/schema.test.ts` prüft, dass die migrierte DB zum Drizzle-Schema passt (Spalten, Typen, NOT NULL, Indizes, `STRICT`/`WITHOUT ROWID`).
5. `pnpm db:check` prüft die Konsistenz der Migrationsdateien.

Bereits ausgelieferte Migrationen werden nie nachträglich geändert.
