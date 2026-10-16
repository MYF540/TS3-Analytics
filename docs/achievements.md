# Achievements

Abzeichen, die Spieler durch Spielzeit, Treue und besondere Momente verdienen (Phase 13). Sie sind im Webinterface unter „Achievements“ zu sehen, auf jeder Spielerseite und als Kachel „Zuletzt erreicht“ auf dem Dashboard. Auf dem TeamSpeak-Server ändert sich dadurch nichts.

## Grundsätze

- **Pro Person:** Verknüpfte UIDs zählen zusammen, ein Achievement erscheint auf allen UIDs der Person.
- **Einmal erreicht, bleibt es.** Nur die DSGVO-Anonymisierung entfernt Achievements.
- **Spielzeit** zählt wie beim Rangsystem: Zeit aus dem alten Ranking bis zum Stichtag plus Live-Zeit danach (Regel 12). Aus Logs rekonstruierte Zeit zählt hier nicht.
- **Nur Live-Daten:** Aktive Zeit, AFK-Zeit, Channels, gemeinsame Zeit, Plattform, Privat-Channel und Bürgschaft gibt es erst seit dem Live-Tracking. Uhrzeit-, Serien- und Treue-Achievements nutzen auch importierte Sessions, weil die Logs Verbindungsbeginn und -ende enthalten.
- **Nachberechnung:** Der erste Lauf, und jeder Lauf nach einer Änderung (Achievement ein- oder ausgeschaltet, Accounts verknüpft, neue Katalogversion), wertet alle Spieler aus der vorhandenen Historie aus. Diese Stufen werden mit dem Datum gespeichert, an dem sie laut Daten erreicht wurden, und als „nachträglich erkannt“ markiert. Sie erscheinen nicht unter „Zuletzt erreicht“ und lösen später keine Nachricht aus.
- **Normale Läufe** alle 15 Minuten prüfen nur Spieler, die seit dem letzten Lauf online waren. Neue Stufen tragen den Zeitpunkt des Laufs.

## Katalog

Stufen heißen Bronze, Silber, Gold, Platin und Diamant (so viele, wie das Achievement hat).

| Gruppe    | Achievement      | Bedingung                                                                                           |
| --------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| Spielzeit | Stammgast        | 10 / 100 / 500 / 1.000 / 2.500 h Rangzeit                                                           |
| Spielzeit | Aktivposten      | 50 / 250 / 1.000 h aktive Zeit (ohne Idle und AFK)                                                  |
| Treue     | Urgestein        | Besuch nach dem 1. / 2. / 5. / 10. Jahrestag des ersten Besuchs                                     |
| Treue     | Pionier          | unter den ersten 100 Personen nach erstem Besuch                                                    |
| Treue     | Veteran          | hatte Zeit im alten Rangsystem                                                                      |
| Treue     | Comeback         | nach mindestens 180 Tagen ohne eine Minute online wieder da                                         |
| Serien    | Dauerbrenner     | 7 / 30 / 100 Tage in Folge mit mindestens 15 min                                                    |
| Serien    | Wochenendkrieger | 10 Wochenenden in Folge (Samstag oder Sonntag, mindestens 15 min)                                   |
| Sessions  | Marathon         | eine Session von 4 / 8 / 12 h                                                                       |
| Uhrzeit   | Nachteule        | 25 Sessions mit mindestens 30 min zwischen 0 und 5 Uhr                                              |
| Uhrzeit   | Frühaufsteher    | 25 Sessions, die zwischen 5 und 7 Uhr beginnen                                                      |
| Uhrzeit   | Silvester        | um Mitternacht zum Jahreswechsel online                                                             |
| Uhrzeit   | Geburtstagskind  | an einem Jahrestag des ersten Besuchs online (29. Februar: am 28.)                                  |
| Gemeinsam | Gesellig         | mit 10 / 25 / 50 Personen je mindestens 1 h gemeinsam (Netzwerk „gesamt“)                           |
| Gemeinsam | Unzertrennlich   | 250 h mit derselben Person (Netzwerk „gesamt“)                                                      |
| Gemeinsam | Rekordnacht      | online in einer Stunde mit neuem Allzeit-Rekord an Nutzern (nicht in den ersten 30 Tagen der Daten) |
| Gemeinsam | Bürge            | hat beim Anti-Proxy-Einladungssystem für jemanden gebürgt                                           |
| Server    | Weltenbummler    | 25 verschiedene Channels besucht                                                                    |
| Server    | Gipfelstürmer    | der Rang-Job hat den höchsten Rang der Leiter bestimmt                                              |
| Server    | Hausherr         | besitzt einen Privat-Channel                                                                        |
| Server    | Unterwegs        | mit der App für Android oder iOS verbunden                                                          |
| Geheim    | Punktlandung     | in den ersten zwei Minuten eines neuen Jahres verbunden                                             |
| Geheim    | Jubilar          | 1.000 Sessions                                                                                      |
| Geheim    | Namenswechsler   | 10 verschiedene Nicknames                                                                           |
| Geheim    | Schlafmütze      | 100 h AFK                                                                                           |

Uhrzeiten gelten in `Europe/Berlin`. Gesellig und Unzertrennlich lesen das täglich berechnete Spieler-Netzwerk; sie werden also höchstens einen Tag später erkannt, und es zählen nur die dort berücksichtigten Spieler (Vorgabe: die 200 aktivsten).

Geheime Achievements zeigt die Übersicht als „???“, bis jemand sie erreicht hat. Auf der Spielerseite erscheinen sie erst, wenn der Spieler sie hat.

## Einstellungen

Unter „Einstellungen → Achievements“ (nur Admins) lässt sich jedes Achievement ein- und ausschalten. Ausgeschaltete werden nicht mehr ausgewertet und nirgends angezeigt; bereits erreichte bleiben gespeichert. „Jetzt auswerten“ startet einen Lauf sofort. Beides steht im Audit-Log.

Schwellen und Texte stehen fest im Code (`src/domain/achievements.ts`, Texte in `web/src/i18n/de.ts`). Wer Schwellen ändert, erhöht `CATALOG_VERSION`; der nächste Lauf wertet dann alle Spieler neu aus.
