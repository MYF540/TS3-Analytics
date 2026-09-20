# TeamSpeak-Serverlogs: Format und Auswertung

Grundlage für den Log-Import (Phase 8). Untersucht wurde eine echte Logdatei des Servers
(27 MB, 214.279 Zeilen, 13.09.2019 bis 04.11.2019, virtueller Server 4). Alle Beispielzeilen in
diesem Dokument sind nachgebaut – Nicknames, IP-Adressen und IDs stammen **nicht** aus den echten
Daten (IP-Adressen aus dem Dokumentationsbereich 203.0.113.0/24).

## Dateien

```
ts3server_2019-09-13__03_35_27.597751_4.log
          └── Startzeitpunkt ──┘        └─ virtueller Server
```

- Pro Serverstart entsteht eine Datei; sie beginnt mit `listening on …` und endet im Normalfall
  mit `stopped`. Fehlt `stopped`, wurde der Server abgeschossen oder ist abgestürzt.
- Nur Dateien des relevanten virtuellen Servers verarbeiten (Suffix `_4`). Die Instanz-Logs
  (`_0`) enthalten keine Client-Ereignisse.
- Sortiert wird nach dem Zeitstempel im Dateinamen, nicht nach Änderungsdatum.
- Die Datei beginnt mit einem UTF-8-BOM. Der Inhalt ist UTF-8, kann aber beschädigte Zeilen
  enthalten (siehe Sonderfälle).

## Zeilenaufbau

```
2019-09-13 03:35:28.651614|INFO    |VirtualServer |4  |listening on 203.0.113.7:9987, [::]:9987
└── Zeitstempel ─────────┘ └Level─┘ └Komponente──┘ └┘ └── Nachricht ───────────────────────────┘
                                                    │
                                                    virtueller Server
```

Level und Server-ID sind mit Leerzeichen aufgefüllt. Im Sample kommen nur `INFO` und die
Komponenten `VirtualServer`, `VirtualServerBase` und `PktHandler` vor.

**Wichtig:** 307 von 5.536 Nicknames enthalten selbst ein `|`. Die Zeile darf deshalb nicht mit
`split('|')` zerlegt werden – nur die ersten vier Trenner gehören zum Kopf:

```
/^\uFEFF?([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/   (\uFEFF steht für das BOM am Dateianfang)
```

Ebenso kann ein Nickname ein `'` enthalten (2 Fälle). Die Muster unten fangen das ab, indem der
Nickname gierig (`.*`) gelesen wird und erst das letzte `'(id:` die Grenze bildet.

## Zeitzone

Die Zeitstempel tragen keine Zeitzone. Die Verteilung der Verbindungen über den Tag spricht für
**UTC**: Das Maximum liegt zwischen 16 und 19 Uhr Logzeit, was 18 bis 21 Uhr deutscher Zeit
entspricht – ein typischer Feierabend-Verlauf. Wären die Zeiten bereits lokal, läge das Maximum
ungewöhnlich früh und fiele ab 20 Uhr schon wieder ab.

Sicher ist das nicht. Der Import bekommt deshalb eine Option für die Zeitzone der Logs (Vorgabe
UTC), und der Dry-Run gibt die Verteilung je Stunde aus, damit sie vor dem echten Lauf geprüft
werden kann. Gegenprobe später: Die Zeitstempel in `ts3server.sqlitedb` (T8.3) und in der
Alt-Ranking-Datenbank (T8.8) sind Unix-Zeiten und damit eindeutig.

## Ereignisse, die der Import braucht

| Ereignis        | Muster (nur der Nachrichtenteil)                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| Verbindung      | `^client connected '(.*)'\(id:(\d+)\)( using a myTeamSpeak ID)? from (.+):(\d+)$`                    |
| Trennung        | `^client disconnected '(.*)'\(id:(\d+)\) reason '(.*)'$`                                             |
| Gruppe erhalten | `^client \(id:(\d+)\) was added to servergroup '(.*)'\(id:(\d+)\) by client '(.*)'\(id:(\d+)\)$`     |
| Gruppe entfernt | `^client \(id:(\d+)\) was removed from servergroup '(.*)'\(id:(\d+)\) by client '(.*)'\(id:(\d+)\)$` |
| Serverstart     | `^listening on `                                                                                     |
| Serverstopp     | `^stopped$`                                                                                          |

Beispiele (nachgebaut):

```
client connected 'Spieler'(id:1234) from 203.0.113.7:51234
client connected 'Spieler'(id:1234) using a myTeamSpeak ID from 203.0.113.7:51234
client disconnected 'Spieler'(id:1234) reason 'reasonmsg=Verlassen'
client (id:1234) was added to servergroup 'Mitglied'(id:12) by client 'Admin'(id:2)
```

Die Variante `using a myTeamSpeak ID` kommt in 686 von 2.768 Verbindungen vor; sie ändert nur den
Text, nicht die Felder.

### Die ID ist die Client-Datenbank-ID

`(id:1234)` ist die **Client-Datenbank-ID**, nicht die Verbindungs-ID (clid). Eine UID steht in
keiner dieser Zeilen. Daraus folgt:

- Die Zuordnung zu einer UID muss aus einer Kopie von `ts3server.sqlitedb` kommen (T8.3).
- Verbindung und Trennung lassen sich nur über die Datenbank-ID paaren. Ist derselbe Account
  zweimal gleichzeitig verbunden (im Sample 9-mal), ist nicht entscheidbar, welche Trennung zu
  welcher Verbindung gehört. Empfehlung: nach dem Prinzip „älteste zuerst“ paaren und den Fall
  zählen.

### Trennungsgründe

Der Teil hinter `reason` ist eine Parameterliste im ServerQuery-Stil, die Werte sind **nicht**
maskiert und enthalten Leerzeichen. Sie darf deshalb nicht an Leerzeichen zerlegt werden; zu
suchen ist nach den bekannten Schlüsseln.

| Form                                                 | Anzahl | Bedeutung                           |
| ---------------------------------------------------- | -----: | ----------------------------------- |
| `reasonmsg=<Text>`                                   |  2.740 | normales Verlassen, Text vom Nutzer |
| `reasonmsg` (ohne `=`)                               |     18 | Verbindung abgebrochen              |
| `invokerid=… invokername=… invokeruid=… reasonmsg=…` |     10 | vom Team getrennt (Kick oder Ban)   |

Ob ein Kick oder ein Ban vorliegt, steht nicht in der Zeile. Eigene Zeilen für Bans oder Kicks
gibt es im Sample nicht. Für die Historie ist das unerheblich – gezählt wird die Zeit bis zur
Trennung.

## Zeilen, die ignoriert werden

| Form                                               | Anzahl im Sample | Grund                                  |
| -------------------------------------------------- | ---------------: | -------------------------------------- |
| `query client connected/disconnected …`            |          203.690 | Query-Clients zählen nicht (AGENTS.md) |
| `file download from …`, `file upload …`            |            3.072 | keine Anwesenheit                      |
| `channel '…'(id:N) edited/created/deleted by …`    |            1.434 | Channelnamen, für die Historie unnötig |
| `Dropping client N because of ping/resend timeout` |              199 | die zugehörige Trennung wird geloggt   |
| `Cleaning up connection because of N resends …`    |              118 | siehe oben                             |
| `client '…'(id:N) changed myTeamSpeak ID …`        |               43 | kein Zeitbezug                         |
| `file deleted from …`, `complaint added for …`     |                5 | irrelevant                             |

**95 % aller Zeilen stammen von Query-Clients** – im Sample ein Monitoring-Dienst, der sich im
Minutentakt verbindet. Der Import sollte deshalb zuerst billig filtern (Zeichenkettensuche nach
`|query client`) und die Regex erst auf den Rest anwenden. Relevant sind rund 3 % der Zeilen.

## Was die Logs nicht enthalten

- **UIDs** – nur Datenbank-IDs (Ausnahme: `invokeruid` beim Kick).
- **Channelwechsel und den Channel eines Clients.** Geloggt wird nur, wenn ein Channel bearbeitet,
  angelegt oder gelöscht wird. Für importierte Zeiten gibt es deshalb keine Channel-Statistik.
- **Aktivität**: kein Idle, kein AFK, kein Mikrofonstatus. Importierte Zeit ist ausschließlich
  Online-Zeit und wird als Zustand `unknown` geführt (T8.2).
- **Client-Version, Plattform, Land.**
- **Nickname-Änderungen** während einer Sitzung; im Log steht der Name beim Verbinden und beim
  Trennen.
- **Bans und die Banliste.**

## Sonderfälle und Zahlen aus dem Sample

| Fall                                  |     Zahl | Folge für den Import                                    |
| ------------------------------------- | -------: | ------------------------------------------------------- |
| Verbindungen / Trennungen             | je 2.768 | im Sample ausgeglichen                                  |
| Gleicher Account doppelt verbunden    |        9 | „älteste zuerst“ paaren, zählen                         |
| Trennung ohne offene Verbindung       |        9 | verwerfen und zählen (Folge der doppelten Verbindungen) |
| Sitzungen über 24 Stunden             |       25 | Höchstdauer konfigurierbar kappen                       |
| Längste Sitzung                       |  52 Tage | dauerhaft verbundener Client (Musikbot o. Ä.)           |
| Höchste Zahl gleichzeitig Verbundener |       27 |                                                         |
| Beschädigte Zeilen                    |        2 | Zeile zählen, Datei weiterlesen                         |
| Nicknames mit `\|`                    |      307 | Zeile nicht an `\|` zerlegen                            |
| Nicknames mit `'`                     |        2 | gierig lesen                                            |
| Nicknames mit Zeichen außerhalb ASCII |      227 | UTF-8, Emojis kommen vor                                |
| Längster Nickname                     |       30 | Grenze des Servers                                      |

Die beschädigten Zeilen sehen so aus – die Mikrosekunden stehen vor dem Datum, der Rest der Zeile
ist unverändert:

```
0000002019-09-17 17:35:04.|INFO    |VirtualServer |4  |query client connected …
```

Solche Zeilen passen nicht auf das Kopfmuster. Der Parser zählt sie je Datei und liest weiter; der
Dry-Run-Bericht weist sie aus.

## Folgen für T8.4 bis T8.6

- Zeilenweise streamen; 27 MB sind rund 214.000 Zeilen (ø 130 Byte), 5 GB also etwa 40 Millionen.
- Reihenfolge: Vorfilter → Kopfmuster → Ereignismuster. Nur so bleibt der Durchsatz brauchbar.
- Serverstopp (`stopped`) und Dateiende schließen alle offenen Sitzungen am letzten Zeitstempel
  davor; fehlt `stopped`, ist das Dateiende die Grenze.
- Jede verworfene Zeile und jede gekappte Sitzung bekommt einen Grund und wird gezählt – der
  Dry-Run-Bericht besteht aus diesen Zählern.

## So läuft der Import

```
pnpm backup                                  # vorher sichern
nssm stop ts3-analytics                      # Dienst anhalten
pnpm import:logs <ordner> --dry-run --clients <kopie von ts3server.sqlitedb>
pnpm import:logs <ordner> --clients <kopie von ts3server.sqlitedb>
nssm start ts3-analytics
```

Der Probelauf schreibt nichts und gibt denselben Bericht aus wie der echte Lauf. Wichtig darin:

- **Verbindungen je Stunde**: Liegt das Maximum am Abend, stimmt die angenommene Zeitzone. Sonst
  den Lauf mit `--zone utc` wiederholen.
- **Platzhalter**: Datenbank-IDs, zu denen der Server keinen Account mehr kennt. Sie bekommen die
  UID `unknown-dbid-<id>`, ihre Zeit zählt in der Serverstatistik, in Spielerliste, Suche und
  Leaderboards tauchen sie nicht auf. Über „Accounts verknüpfen“ lassen sie sich einem Spieler
  zuordnen.
- **Unbekannte Zeilen**: Tauchen viele auf, hat der Server ein neues Format – dann erst die
  Muster oben ergänzen.

Optionen:

| Option                    | Wirkung                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `--dry-run`               | nur Bericht, keine Änderung                                        |
| `--clients <datei>`       | Kopie von `ts3server.sqlitedb` für die Zuordnung der IDs zu UIDs   |
| `--from`, `--to`          | Zeitraum (Berliner Tage). Ohne `--to`: bis zur ersten Live-Sitzung |
| `--zone berlin\|utc`      | Zeitzone der Logzeitstempel, Vorgabe `berlin`                      |
| `--server <id>`           | virtueller Server, Vorgabe aus `TS3_SERVER_ID`                     |
| `--max-session <stunden>` | kappt überlange Sitzungen (Vorgabe: keine Grenze)                  |
| `--no-rebuild`            | Tageswerte nicht am Ende neu berechnen                             |
| `--yes`                   | ohne Rückfrage starten                                             |

Zweimal derselbe Ordner ist unproblematisch: Jede Datei ist in `import_runs` vermerkt und wird
übersprungen, solange sie unverändert ist. Ein abgebrochener Lauf hinterlässt nichts – eine
Datei zählt erst als importiert, wenn ihre Transaktion abgeschlossen ist.

Importierte Zeit ist **nur Online-Zeit** (Zustand `unknown`); sie fließt in Statistiken und
Leaderboards, aber nicht in die Ränge – die rechnen mit `legacy_seconds` aus dem alten
Rangsystem plus der live erfassten Zeit (siehe [import-legacy-ranking.md](import-legacy-ranking.md)).
