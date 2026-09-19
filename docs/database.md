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

- Alle Tabellen sind `STRICT`. Zusammengesetzte oder Text-Primärschlüssel (`user_daily_stats`, `ip_seen`, `settings`, `admin_sessions`, `user_tags`) sind zusätzlich `WITHOUT ROWID`.
- Zeitpunkte: UTC-Unix-Sekunden (`INTEGER`). Dauern: Sekunden.
- `user_daily_stats.day`: Kalendertag in `Europe/Berlin` als Zahl `YYYYMMDD` (z. B. `20260919`), damit unabhängig von der Zeitumstellung.
- Die TS3-UID steht in `users.uid`; alle anderen Tabellen referenzieren `users.id`. Einzige Ausnahme ist `bans.uid`, weil ein Ban auch UIDs betreffen kann, die der Bot nie gesehen hat (`bans.user_id` wird gesetzt, sobald die UID bekannt ist).
- IP-Daten nur als HMAC-SHA256 (`BLOB`, 32 Byte) in `ip_seen` und `bans`, nie im Klartext. IP-Regeln der Banliste, die Muster sind, werden nur mit `bans.ip_pattern = 1` markiert.
- Aktivitätszustände: `active`, `idle`, `afk`, `unknown` (importierte Zeiten).
- Offene Sessions haben `leave_at = NULL`; offene Segmente `is_open = 1`, `end_at` ist dann der Zeitpunkt der letzten Verlängerung.

## Tabellen (Überblick)

| Tabelle                     | Zweck                                                                      |
| --------------------------- | -------------------------------------------------------------------------- |
| `users`                     | Ein Eintrag pro UID                                                        |
| `nicknames`                 | Nickverlauf, dazu FTS5-Index `nicknames_fts` (Trigram, Teilstring-Suche)   |
| `channels`                  | Channel-Namen nach TS3-cid                                                 |
| `sessions`                  | Verbindungen (`source` = `live` oder `import`)                             |
| `activity_segments`         | Zusammenhängende Abschnitte gleichen Zustands und Channels                 |
| `user_daily_stats`          | Tagesaggregat pro Nutzer                                                   |
| `user_totals`               | Allzeit-Aggregat pro Nutzer (Leaderboards)                                 |
| `server_minutely`           | Online-Zahl pro Minute (kurzfristig)                                       |
| `server_hourly`             | Stundenaggregat (dauerhaft); Ø online = `online_s / 3600`                  |
| `ip_seen`                   | IP- und Subnetz-Hashes pro Nutzer                                          |
| `settings`                  | Schlüssel/JSON-Wert                                                        |
| `admin_users`               | Konten des Webinterfaces (Rolle, argon2-Hash)                              |
| `admin_sessions`            | Login-Sessions (nur Hash des Tokens)                                       |
| `audit_log`                 | Protokoll aller Änderungen und Anmeldungen                                 |
| `player_notes`              | Notizen zu Spielern (weich gelöscht über `deleted_at`)                     |
| `player_note_revisions`     | Frühere Fassungen von Notizen                                              |
| `tags`, `user_tags`         | Frei definierbare Tags und ihre Zuordnung zu Spielern                      |
| `bans`                      | Spiegel der Banliste; aufgehobene Bans behalten `removed_at`               |
| `flags`                     | Hinweise auf Zweitaccounts/Ban-Umgehung, ein Eintrag pro Paar (`pair_key`) |
| `persons`, `person_members` | Verknüpfte UIDs einer Person mit Haupt-Account                             |
| `group_changes`             | Servergruppen-Änderungen aus dem Server-Log (nur geparste Felder)          |

Das maßgebliche Schema steht in `src/db/schema.ts`.

## Aggregate

Leaderboards, Dashboard und Rang-Engine lesen nur aus `user_daily_stats`, `user_totals` und `server_hourly`. Die Logik steht in `src/domain/aggregation.ts` (rein) und `src/db/aggregates.ts`.

- **Wann:** Eine Session bzw. ein Segment fließt erst beim Schließen in die Aggregate ein (`finalizeSession`, `finalizeSegment`). Schließen und Fortschreiben laufen in einer Transaktion; ein zweites Schließen trifft nichts, daher keine Doppelzählung. Offene Sessions/Segmente sind nicht enthalten – „online jetzt“ und laufende Sessions muss die API separat ergänzen.
- **Tage:** Online- und Zustandszeiten werden an Berliner Mitternacht aufgeteilt (Tage mit 23 bzw. 25 Stunden bei Zeitumstellung). Session-Anzahl und „längste Session“ zählen am Tag des Joins, mit der vollen Dauer.
- **Zustände:** `online_s` kommt aus Sessions, `active_s`/`idle_s`/`afk_s`/`unknown_s` aus Segmenten. Importierte Sessions (`source = 'import'`) zählen zusätzlich als `unknown_s`.
- **Gesamtwerte:** `user_totals` = Summe bzw. Maximum der Tageswerte; `first_seen`/`last_seen` = frühester/spätester Zeitpunkt abgeschlossener Sessions und Segmente.
- **Stunden (UTC):** `online_s` = Summe der Session-Sekunden in der Stunde, `max_online` = maximale Anzahl gleichzeitiger Sessions, `unique_users` = verschiedene Nutzer. Beim Schließen einer Session werden alle berührten Stunden aus den abgeschlossenen Sessions neu berechnet. Stunden ohne Sessions haben keine Zeile.

### Neu berechnen

```
pnpm stats:rebuild [--from YYYY-MM-DD] [--to YYYY-MM-DD]
```

Berechnet die Aggregate aus Sessions und Segmenten neu (Tage in Berliner Zeit, beide inklusive). Tageszeilen außerhalb des Zeitraums bleiben unverändert, `user_totals` wird für alle betroffenen Nutzer vollständig neu gebildet. Jeder Nutzer läuft in einer eigenen Transaktion, die Stunden in einer gemeinsamen. Für ein konsistentes Ergebnis den Dienst vorher stoppen. Im Produktivbetrieb ohne Dev-Abhängigkeiten: `pnpm build` und dann `node dist/cli/stats-rebuild.js …`.

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
