# Sicherung und Wiederherstellung

## Automatische Sicherung

Der Dienst sichert die Datenbank einmal täglich (Job „Datenbank-Sicherung“, sichtbar auf der Seite „Bot-Status“):

- Ziel: `BACKUP_DIR` (Standard `./data/backups`), Dateiname `ts3-analytics-JJJJMMTT-HHMMSS.sqlite` (Zeit in UTC)
- Aufbewahrt werden die neuesten `BACKUP_KEEP` Sicherungen (Standard 14), ältere werden gelöscht. Andere Dateien im Ordner bleiben unberührt.
- Die Sicherung läuft im laufenden Betrieb (SQLite-Online-Backup) und blockiert den Watcher nicht. Jede Kopie wird mit `PRAGMA quick_check` geprüft und erst danach unter ihrem endgültigen Namen abgelegt; eine abgebrochene Sicherung bleibt höchstens als `*.partial` liegen und wird beim nächsten Lauf ersetzt.
- Jede Sicherung ist eine einzelne, eigenständige Datei (ohne `-wal`/`-shm`).

Die Sicherungen enthalten dieselben Daten wie die Datenbank (u. a. IP-Hashes, Notizen). Den Ordner deshalb genauso schützen wie `./data` und nicht öffentlich ablegen. Wer Sicherungen außer Haus kopiert, sollte sie verschlüsseln.

## Manuelle Sicherung

Vor Updates oder Umbauten:

```
pnpm backup
```

Nutzt dieselbe Konfiguration (`.env`) und Rotation wie der tägliche Job und funktioniert auch, während der Dienst läuft.

## Wiederherstellung

1. Dienst stoppen (`nssm stop ts3-analytics` bzw. Prozess beenden).
2. Aktuelle Datenbank zur Sicherheit wegkopieren: `SQLITE_PATH` sowie – falls vorhanden – die Dateien mit Endung `-wal` und `-shm`.
3. Gewünschte Sicherung nach `SQLITE_PATH` kopieren und alte `-wal`/`-shm`-Dateien daneben löschen.
4. Dienst starten. Fehlende Migrationen werden beim Start automatisch ausgeführt.

Zeiten zwischen Sicherung und Wiederherstellung fehlen danach. Spieler, die zu diesem Zeitpunkt online waren, werden beim Start wie nach einem Neustart behandelt (offene Sessions werden geschlossen oder, bei kurzer Unterbrechung, fortgesetzt).
