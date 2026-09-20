# Altes Rangsystem: Datenbestand und Zuordnung

Grundlage für T8.9 (Import der Ranglaufzeiten). Untersucht wurde eine Kopie der SinusBot-Datenbank
mit den Daten des Skripts „Tunakills Rankingsystem“. Die Kopie bleibt lokal; hier stehen nur
Struktur, Konfiguration und aggregierte Zahlen – keine UIDs, Nicknames oder IP-Adressen.

## Wo die Daten liegen

Die SinusBot-Datenbank ist SQLite. Relevant ist die Tabelle `scriptdata`, ein Schlüssel-Wert-Speicher:

```sql
CREATE TABLE scriptdata (
  uuid    STRING NOT NULL,   -- Name des Skripts
  keyname STRING NOT NULL,   -- Schlüssel, oft mit angehängter UID
  data    BLOB NOT NULL,     -- Wert als Text
  meta    STRING,
  PRIMARY KEY (uuid, keyname)
)
```

Für das Rangsystem sind zwei `uuid`-Werte belegt:

| `uuid`                    | Einträge | Bedeutung                                      |
| ------------------------- | -------: | ---------------------------------------------- |
| `Tunakills_Rankingsystem` |   22.944 | aktueller Bestand                              |
| `Tunakills Rankingsystem` |      351 | älterer Bestand unter dem früheren Skriptnamen |

### Schlüssel je Nutzer

| Schlüssel        | Wert                                                   |
| ---------------- | ------------------------------------------------------ |
| `timetrak<UID>`  | **Sekunden**, fortlaufend aufaddiert                   |
| `startTime<UID>` | Unix-Zeit, Beginn des laufenden Messintervalls         |
| `allUserListed`  | JSON-Liste aller erfassten Nutzer mit Nickname und UID |
| `timetrak`       | Summenzähler des Skripts, kein Nutzerwert              |
| `startTime`      | Zeitpunkt des letzten Skriptstarts, kein Nutzerwert    |

Die UID ist direkt angehängt – 28 Zeichen Base64 mit `=` am Ende. Alle 11.469 Schlüssel im
Bestand haben diese Form, es sind also keine Query-Konten oder Platzhalter darunter. Die
Zuordnung zu unseren Nutzern läuft damit direkt über die UID, ein Umweg über Datenbank-IDs wie
beim Log-Import (T8.3) entfällt.

**`startTime` ist nicht „zuerst gesehen“.** Das Skript setzt den Wert bei jeder Aktualisierung neu
(`setUserTimetrakStart`). Er sagt nur, wann zuletzt gemessen wurde, und taugt weder als Beginn der
Zählung noch als letzter Besuch.

## Wie das Skript gezählt hat

```js
var user_online_time = time - store.get('startTime' + uid);
store.set('timetrak' + uid, alter_wert + user_online_time);
```

- Gezählt wird reine **Online-Zeit in Sekunden**, alle 5 Minuten (`update_interval`) fortgeschrieben.
- Die Konfiguration dieses Servers hat `disable_tracking_for_mute`, `…_deaf` und `…_away` auf `0`
  und keine ausgenommenen Channels: Es zählt jede Sekunde online, unabhängig von Mikrofon,
  Lautsprecher, AFK oder Channel. Die Zahl ist damit mit unserer **Online-Zeit** vergleichbar,
  nicht mit der aktiven Zeit.
- Lief der Bot nicht, wurde nichts gezählt. Nach einem Absturz geht das angefangene Intervall
  verloren. Die Werte sind deshalb systematisch eher zu klein.

## Ränge des alten Systems

Aus `instances.config` → `scriptSettings["Tunakills_Rankingsystem"].settings`. `time_required`
steht in **Minuten**, verglichen wird `time_required * 60 < timetrak`.

| Stufe | `time_required` | entspricht | Servergruppe | Nutzer im Bestand |
| ----: | --------------: | ---------- | -----------: | ----------------: |
|     1 |              15 | 15 Minuten |          135 |             8.312 |
|     2 |             360 | 6 Stunden  |           59 |               982 |
|     3 |           1.440 | 1 Tag      |           75 |               536 |
|     4 |          10.080 | 7 Tage     |          134 |               122 |
|     5 |          20.160 | 14 Tage    |          136 |                66 |
|     6 |          40.320 | 28 Tage    |          151 |                40 |
|     7 |          80.640 | 56 Tage    |          152 |                31 |
|     8 |         161.280 | 112 Tage   |          153 |                25 |

1.355 Nutzer liegen unter der ersten Stufe und hatten damit keinen Rang.

Weitere Einstellungen:

- `server_groups_to_not_set_rank`: sieben Gruppen (57, 58, 67, 68, 69, 73, 139) sind vom Rangsystem
  ausgenommen – vermutlich Team- und Sondergruppen. Die Zuordnung zu unseren Ausnahmen (T6.2)
  gehört in die Mapping-Datei von T8.9.
- `ranking_enable` ist `"0"`. Die Abfrage im Skript lautet `if(config.ranking_enable == 1) return;`
  – der Schalter ist also invertiert: `0` heißt aktiv.
- `set_message`: Nachricht nach dem Aufstieg, entspricht unserer Aufstiegsnachricht (T6.5).

## Zahlen zum Bestand

| Kennzahl                      |      Wert |
| ----------------------------- | --------: |
| Nutzer mit Zeitwert           |    11.469 |
| Summe aller Zeiten            | 548.804 h |
| Median                        |     1,5 h |
| 90. Perzentil                 |    11,8 h |
| Höchstwert                    |  72.170 h |
| Werte gleich 0                |         2 |
| Negative oder unlesbare Werte |         0 |

Der Höchstwert entspricht 8,2 Jahren – das Skript läuft seit 2017, es handelt sich also um einen
dauerhaft verbundenen Client (Bot oder Radio). Solche Fälle muss der Plausibilitätsbericht (T8.10)
sichtbar machen, statt sie stillschweigend zu übernehmen.

## Doppelter Bestand unter dem alten Skriptnamen

Unter `Tunakills Rankingsystem` (mit Leerzeichen) liegen 174 ältere Zeitwerte:

- 106 UIDs kommen in beiden Beständen vor; bei **28** davon ist der alte Wert größer. Diese Nutzer
  haben beim Umbenennen des Skripts Zeit verloren.
- 68 UIDs stehen nur im alten Bestand, zusammen 458 Stunden.

Vorschlag für T8.9: je UID das Maximum beider Bestände übernehmen und beide Zahlen im Bericht
ausweisen. So verliert niemand Zeit, und der Fall bleibt nachvollziehbar.

## Zuordnung auf unser Schema

| Alt                                  | Neu                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `timetrak<UID>` (Sekunden)           | `users.legacy_seconds`                                                         |
| Stufe aus `server_group_to_set`      | `users.legacy_rank`                                                            |
| Zeitpunkt der Umstellung             | Einstellung `legacy_cutoff`                                                    |
| `server_group_to_set[].server_group` | Mapping-Datei auf unsere Ränge (T8.9), damit niemand beim ersten Lauf absteigt |
| `server_groups_to_not_set_rank`      | Ausnahmen des Rangsystems (T6.2)                                               |
| `allUserListed`                      | nicht übernehmen – Nicknames kommen aus dem laufenden Betrieb                  |

Die Rang-Engine rechnet danach `legacy_seconds` plus die live erfasste Zeit **nach**
`legacy_cutoff`. Aus Logs importierte Zeit fließt nur in die Statistik, nicht in die Ränge – sonst
würde dieselbe Zeit doppelt zählen.

## Was der Bestand nicht enthält

- Keine Historie: nur ein Summenwert je UID, keine Tage, keine Sitzungen.
- Keine Aufteilung in aktiv, inaktiv oder AFK.
- Kein „zuerst gesehen“ und kein „zuletzt gesehen“.
- Keine Channel- oder Serverinformationen.
- Keine Angabe, welchen Rang ein Nutzer tatsächlich hatte – er ergibt sich nur aus dem Zeitwert
  und der Konfiguration. Wer in einer ausgenommenen Gruppe war, hatte trotz Zeit keinen Rang.

## So läuft der Import

```
pnpm backup
pnpm import:ranking <kopie der sinusbot-datenbank> --dry-run
pnpm import:ranking <kopie der sinusbot-datenbank> --cutoff 2026-09-01 --map rangmap.json
```

Der Probelauf zeigt den Bestand, die alte Rangleiter samt Verteilung und – sobald eine eigene
Rangleiter eingerichtet ist – welchen Rang unsere Regeln daraus machen würden.

| Option                | Wirkung                                                         |
| --------------------- | --------------------------------------------------------------- |
| `--dry-run`           | nur Bericht, keine Änderung                                     |
| `--cutoff JJJJ-MM-TT` | Stichtag der Umstellung, Vorgabe: jetzt                         |
| `--map <datei.json>`  | alte Servergruppe → unsere Rang-ID, z. B. `{"135": 1, "59": 2}` |
| `--min-minutes <n>`   | Einträge unter dieser Zeit überspringen                         |
| `--yes`               | ohne Rückfrage übernehmen                                       |

Mit `--map` steht im Bericht zusätzlich, wie viele Spieler mit unserer Rangleiter denselben,
einen höheren oder einen niedrigeren Rang bekämen. Wer absteigen würde, sollte vor dem
Abschalten des Probemodus auffallen – entweder die Schwellen anpassen oder den Rang einfrieren.

Der Import schreibt `users.legacy_seconds` und `users.legacy_rank` sowie die Einstellung
`legacy.cutoff`. Er **setzt** die Werte, addiert sie also nicht: Ein zweiter Lauf ändert nichts.
Spieler, die es hier noch nicht gibt, werden angelegt; ohne Sitzungen tauchen sie weder in
Leaderboards noch (mit der Standard-Mindestspielzeit) in der Spielerliste auf.

Die Rang-Engine rechnet danach: `legacy_seconds` + selbst erfasste Zeit **ab** dem Stichtag. Aus
Logs importierte Zeit (`unknown_s`) bleibt außen vor – sonst zählte dieselbe Stunde doppelt.
