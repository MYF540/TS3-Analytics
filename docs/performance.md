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

### Einordnung

- Die Messung lief auf einem schnellen Desktop-Rechner. Der Zielserver (Hetzner Dedicated, Windows Server 2016) ist voraussichtlich deutlich langsamer. Kritisch sind dort nur die drei Abfragen über den gesamten Zeitraum (~15–25 ms hier). Bei Faktor 3–4 liegen sie weiterhin unter 100 ms, aber mit wenig Reserve. Nach Inbetriebnahme sollte `pnpm bench` einmal auf dem Server laufen.
- Mögliche Optimierungen, falls nötig: Monats-Aggregat für Leaderboards über lange Zeiträume; Tages-Aggregat für den Server-Verlauf; Caching der Allzeit-Kurven (ändern sich höchstens stündlich).

### Behobene Engpässe

- `rebuildAggregates` brauchte zunächst 240 s: Die Berechnung von `first_seen`/`last_seen` als Unterabfrage innerhalb des `INSERT … SELECT` wurde von SQLite für jede Tageszeile neu ausgewertet. Jetzt zwei separate Abfragen → 15,5 s.
