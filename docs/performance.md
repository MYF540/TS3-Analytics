# Performance

Budget laut AGENTS.md: jede Kernabfrage des Webinterfaces **unter 100 ms**, auch für den Zeitraum „gesamt“. Gemessen wird mit synthetischen Daten, die den erwarteten Umfang abbilden.

## Ablauf

```
pnpm seed:synthetic            # erzeugt data/synthetic.sqlite (eigene Datei, nie die echte DB)
pnpm bench                     # misst alle Kernabfragen, gibt eine Markdown-Tabelle aus
```

Optionen: `seed:synthetic --years 6 --regular 500 --casual 8000 --seed 42 --out <pfad> --force`, `bench --db <pfad> --runs 30`. `bench` endet mit Exit-Code 1, wenn eine Abfrage (p95) über dem Budget liegt.

**Regel:** Wer eine Kernabfrage in `src/db/queries/` oder ein zugehöriges Schema/Index ändert, führt den Benchmark erneut aus und aktualisiert die Tabelle unten.

## Synthetischer Datensatz

- 6 Jahre, 500 Stammnutzer (zum Teil später hinzugekommen oder abgewandert, Aktivität 25–90 % der Tage, am Wochenende mehr), 8.000 Gelegenheitsnutzer (wenige Sessions innerhalb von bis zu 30 Tagen)
- Startzeiten nach Tageszeit gewichtet (Abendspitze 19–21 Uhr Berliner Zeit), Session-Längen 20 min – 4 h, gelegentlich 8–24 h
- Alle Sessions als Live-Daten mit Aktivitätssegmenten (worst case für die Rohdatenmenge), 1–4 Nicknames pro Nutzer
- Aggregate über `rebuildAggregates` (misst damit auch den Rebuild)
- Nicht enthalten: `server_minutely` (nur 14 Tage, trivial klein), `ip_seen`, offene Sessions

## Ergebnis (2026-09-19, T1.4)

Datenbestand: 8.500 Nutzer, 577.007 Sessions, 2.190.841 Segmente, 448.747 Tageszeilen, 52.578 Stundenzeilen (DB ca. 240 MB).
System: Intel Core i9-14900K, 64 GB RAM, Windows 11, Node 24.18, SQLite 3.53, 30 Läufe je Abfrage, warmer Cache.

| Abfrage                                         | Median (ms) | p95 (ms) | Max (ms) | Budget |
| ----------------------------------------------- | ----------: | -------: | -------: | :----: |
| Leaderboard gesamt (online)                     |         0.1 |      0.1 |      0.1 |   ✅   |
| Leaderboard gesamt (aktiv)                      |         0.0 |      0.1 |      0.2 |   ✅   |
| Leaderboard längste Session (gesamt)            |         0.0 |      0.1 |      0.1 |   ✅   |
| Leaderboard Woche                               |         0.6 |      0.7 |      0.7 |   ✅   |
| Leaderboard Monat                               |         2.5 |      2.7 |      2.9 |   ✅   |
| Leaderboard Jahr                                |         6.8 |      7.3 |      7.3 |   ✅   |
| Leaderboard Jahr, Seite 10                      |         7.0 |      7.3 |      7.4 |   ✅   |
| Leaderboard frei (gesamter Zeitraum über Tage)  |        22.0 |     23.0 |     23.0 |   ✅   |
| Nutzerdetail (aktivster Nutzer, 1 Jahr Verlauf) |         2.9 |      3.0 |      3.0 |   ✅   |
| Dashboard Kennzahlen (30 Tage)                  |         1.3 |      1.4 |      1.4 |   ✅   |
| Online-Verlauf 24 h                             |         0.0 |      0.0 |      0.0 |   ✅   |
| Online-Verlauf 30 Tage                          |         0.1 |      0.2 |      0.2 |   ✅   |
| Online-Verlauf 1 Jahr                           |         1.9 |      2.3 |      3.1 |   ✅   |
| Online-Verlauf gesamt                           |        18.6 |     21.3 |     21.6 |   ✅   |
| Heatmap 30 Tage                                 |         0.1 |      0.2 |      0.3 |   ✅   |
| Heatmap 1 Jahr                                  |         2.0 |      2.3 |      2.4 |   ✅   |
| Heatmap gesamt                                  |        12.9 |     16.0 |     18.4 |   ✅   |
| Suche Nick (Teilstring, 4 Zeichen)              |         0.6 |      0.7 |      0.8 |   ✅   |
| Suche Nick (2 Zeichen, Präfix)                  |         0.5 |      0.7 |      0.8 |   ✅   |
| Suche UID-Präfix                                |         0.3 |      0.4 |      0.6 |   ✅   |

Weitere Messwerte: Datengenerierung 11 s, `rebuildAggregates` über alle 6 Jahre 15,5 s.

### Nachmessung T3.2 (2026-09-19)

Neue Abfragen für die API, gleicher Datensatz und Rechner (alle anderen Werte unverändert im Rahmen der Messschwankung, Maximum jetzt 34 ms bei „Online-Verlauf gesamt“):

| Abfrage                                      | Median (ms) | p95 (ms) | Max (ms) | Budget |
| -------------------------------------------- | ----------: | -------: | -------: | :----: |
| Leaderboard Jahr, Anzahl (Paginierung)       |         7.5 |      8.2 |      8.5 |   ✅   |
| Nutzerliste (Standardfilter, nach Spielzeit) |         3.9 |      4.4 |      4.8 |   ✅   |
| Nutzerliste (alle, nach Nickname, Seite 20)  |        14.2 |     21.7 |     22.8 |   ✅   |
| Nutzerliste mit Suche                        |         2.9 |      4.2 |      4.3 |   ✅   |

Eine Leaderboard-Seite „Jahr“ besteht aus Einträgen + Anzahl (zusammen ca. 16 ms).

### Nachmessung T5.3 (2026-09-19, UID-Verknüpfung)

Leaderboards rechnen jetzt pro Person (verknüpfte UIDs zusammen). Datensatz wie oben, zusätzlich 50 verknüpfte Paare unter den aktivsten Nutzern. Gleicher Rechner.

| Abfrage                                         | Median (ms) | p95 (ms) | Max (ms) | Budget |
| ----------------------------------------------- | ----------: | -------: | -------: | :----: |
| Leaderboard gesamt (online)                     |         2.5 |      2.7 |      2.9 |   ✅   |
| Leaderboard gesamt (aktiv)                      |         2.4 |      2.6 |      2.7 |   ✅   |
| Leaderboard längste Session (gesamt)            |         2.6 |      2.8 |      2.8 |   ✅   |
| Leaderboard Woche                               |         0.7 |      0.8 |      0.8 |   ✅   |
| Leaderboard Monat                               |         2.5 |      2.6 |      2.8 |   ✅   |
| Leaderboard Jahr                                |         6.8 |      7.5 |      7.6 |   ✅   |
| Leaderboard Jahr, Seite 10                      |         7.1 |      7.4 |      7.4 |   ✅   |
| Leaderboard frei (gesamter Zeitraum über Tage)  |        23.5 |     24.9 |     25.5 |   ✅   |
| Leaderboard Jahr, Anzahl (Paginierung)          |         6.7 |      6.8 |      6.9 |   ✅   |
| Nutzerdetail (aktivster Nutzer, 1 Jahr Verlauf) |         6.1 |      6.4 |      6.6 |   ✅   |

Allzeit-Leaderboards lesen nicht mehr direkt den sortierten Index von `user_totals`, sondern gruppieren alle ca. 8.500 Nutzer (0,1 → 2,5 ms). Die übrigen Werte sind unverändert.

Erster Ansatz (verworfen): Der Join auf die Personen-Tabellen direkt über alle Zeilen von `user_daily_stats` brauchte für „Leaderboard frei“ 272 ms. Jetzt wird zuerst pro Nutzer aggregiert und erst das Ergebnis (höchstens ein paar tausend Zeilen) auf Personen abgebildet.

### Nachmessung T7.4 (2026-09-20, Channel-Statistik)

Die Channel-Statistik liest `activity_segments` direkt; es gibt kein Aggregat je Channel. Gleicher Datensatz (2,19 Mio. Segmente), 10 Läufe je Abfrage.

| Abfrage                       | Median (ms) | p95 (ms) | Max (ms) | Budget |
| ----------------------------- | ----------: | -------: | -------: | :----: |
| Channel-Nutzung 24 h          |         1.2 |      1.4 |      1.4 |   ✅   |
| Channel-Nutzung 30 Tage       |        20.9 |     21.7 |     21.7 |   ✅   |
| Ungenutzte Channels (90 Tage) |        27.2 |     27.8 |     27.8 |   ✅   |

Deshalb bietet die Seite nur 24 Stunden, 7 und 30 Tage an: „1 Jahr“ lag bei 351 ms (Median), weil dabei fast alle Segmente gelesen werden. Ein Tages-Aggregat je Channel wäre die Lösung für lange Zeiträume – dann ließe sich die Anzahl unterschiedlicher Spieler allerdings nicht mehr über mehrere Tage summieren, ohne sie doppelt zu zählen. Bis dafür Bedarf besteht, bleibt die Frage „welche Channels werden genutzt?“ auf kurze Zeiträume beschränkt.

### Log-Import T8.6 (2026-09-20)

Gemessen auf demselben Rechner, erzeugte Logdateien im Format des echten Servers (95 % Query-Clients wie im Original), SQLite mit `synchronous = OFF`:

| Menge                | Zeilen     | Sitzungen | Dauer  | Durchsatz         |
| -------------------- | ---------- | --------- | ------ | ----------------- |
| 1 GB (1 Datei)       | 9.302.000  | 232.520   | 4,6 s  | 2,0 Mio. Zeilen/s |
| 5 GB (5 Dateien)     | 46.510.000 | 1.162.600 | 21,0 s | 2,2 Mio. Zeilen/s |
| Aggregate danach neu | –          | 1.162.600 | 3,6 s  | –                 |

Der Speicherverbrauch bleibt konstant: Beim 5-GB-Lauf lag der Heap bei höchstens 84 MB, der gesamte Prozess (RSS) bei 302 MB – darin stecken der SQLite-Cache (64 MB) und die Speicherabbildung der Datenbank. Jede Datei brauchte zwischen 4,1 und 4,4 s, unabhängig davon, wie viele schon importiert waren. Die entstandene Datenbank war 88 MB groß.

Echte Beispieldatei zum Vergleich: 27 MB, 214.279 Zeilen, 2.765 Sitzungen, rund 1 s einschließlich Datenbankschreiben.

Verworfener erster Ansatz: Der Import hat jede Sitzung einzeln über `finalizeSession` in die Aggregate eingerechnet. Das schreibt `server_hourly` für dieselben Stunden immer wieder neu und war nach zehn Minuten noch nicht mit 1 GB durch. Jetzt schreibt der Import nur Sitzungen und rechnet die Aggregate am Ende einmal neu (`rebuildAggregates`, T8.7) – dabei wird jede Sitzung genau einmal gelesen.

### Einordnung

- Die Messung lief auf einem schnellen Desktop-Rechner. Der Zielserver (Hetzner Dedicated, Windows Server 2016) ist voraussichtlich deutlich langsamer. Kritisch sind dort nur die drei Abfragen über den gesamten Zeitraum (~15–25 ms hier). Bei Faktor 3–4 liegen sie weiterhin unter 100 ms, aber mit wenig Reserve. Nach Inbetriebnahme sollte `pnpm bench` einmal auf dem Server laufen.
- Mögliche Optimierungen, falls nötig: Monats-Aggregat für Leaderboards über lange Zeiträume; Tages-Aggregat für den Server-Verlauf; Caching der Allzeit-Kurven (ändern sich höchstens stündlich).

### Behobene Engpässe

- `rebuildAggregates` brauchte zunächst 240 s: Die Berechnung von `first_seen`/`last_seen` als Unterabfrage innerhalb des `INSERT … SELECT` wurde von SQLite für jede Tageszeile neu ausgewertet. Jetzt zwei separate Abfragen → 15,5 s.
