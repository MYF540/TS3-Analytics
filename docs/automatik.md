# Automatik: die Bot-Module

Die Module übernehmen, was vorher einzelne SinusBot-Skripte erledigt haben. Eingerichtet werden sie im Webinterface unter **Automatik** (nur Admins); dort steht auch das Automatik-Protokoll.

## Grundsätze

- **Aus ist die Vorgabe.** Jedes Modul wird einzeln eingeschaltet.
- **Erst Testmodus.** Ein eingeschaltetes Modul startet im Testmodus: Es sendet nichts an den TeamSpeak-Server, sondern schreibt ins Automatik-Protokoll, was es getan hätte (Ergebnis „nur Test“). Erst wenn die Einträge dort stimmen, den Testmodus abschalten.
- **Ein Modul fasst nur an, was ihm gehört.** Servergruppen nur, wenn sie in seinen eigenen Einstellungen stehen – nie eine Gruppe der Rangleiter. Channels nur, wenn es sie selbst angelegt hat oder sie ihm ausdrücklich übergeben wurden.
- **Automatische Bans sind immer zeitlich begrenzt.**
- **Alles ist nachvollziehbar.** Jede Aktion steht 90 Tage im Automatik-Protokoll, jede Änderung an den Einstellungen im Protokoll der Anwendung.
- **Ausnahmen:** In jedem Modul, das auf Spieler wirkt, lassen sich Servergruppen ausnehmen (z. B. Team und Musikbots).

## Die Module

| Modul            | Was es tut                                                                                                                                          | Besonderheiten                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Nickname-Checker | Prüft Nicknames beim Beitritt und nach Umbenennung gegen verbotene Muster; Nachricht, Anstupsen oder Kick                                           | „Ähnliche Zeichen erkennen“ liest `4dm1n` oder `Аdmіn` als `admin`. Umbenennungen werden bis zu eine Minute spät bemerkt |
| Support-Channel  | Wer den Channel betritt, bekommt eine Nachricht; erreichbare Teammitglieder werden angestupst oder angeschrieben                                    | Optional: Channel umbenennen und sperren, solange niemand erreichbar ist; optional Discord-Meldung                       |
| Staffliste       | Schreibt in eine Channel-Beschreibung, wer vom Team online, abwesend oder offline ist                                                               | Überschreibt die vorhandene Beschreibung des gewählten Channels                                                          |
| Channel-Creator  | Hält unter einem Channel immer eine feste Zahl leerer Channels bereit                                                                               | Löscht nur eigene Channels; vorhandene lassen sich mit „Vorhandene Channels übernehmen“ übergeben                        |
| Privat-Channel   | Wer den Eingang betritt, bekommt einen eigenen Channel samt Channel-Gruppe                                                                          | Ein noch vorhandener eigener Channel wird wiederverwendet                                                                |
| Regelbestätigung | Schickt die Regeln als Privatnachricht; Bestätigung per Antwort an den Bot oder durch Betreten eines Channels                                       | Neue Version der Regeln fragt alle erneut; Stand je Spieler auf der Spielerseite                                         |
| Spam-Control     | Zählt Channel-Wechsel, angelegte Channels, Umbenennungen, Neuverbindungen und Privat-Channel-Anfragen – je Art eigene Schwellen: Warnung, Kick, Ban | Verschoben werden zählt nicht. Chat-Spam ist für einen Query-Client nicht sichtbar                                       |
| Anti-Proxy       | Prüft neue Spieler bei proxycheck.io auf VPN/Proxy                                                                                                  | Gibt IP-Adressen an einen Dritten weiter – siehe [datenschutz.md](datenschutz.md). Schlüssel: `PROXYCHECK_API_KEY`       |

## Rechte des Query-Accounts

Zusätzlich zu den Rechten für den Grundbetrieb (siehe README). Die Namen stammen aus der Rechteliste von TeamSpeak 3; **am eigenen Server prüfen** – fehlt eines, steht die fehlgeschlagene Aktion mit der Meldung des Servers im Automatik-Protokoll.

| Modul                         | Rechte                                                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alle mit Nachrichten          | `i_client_private_textmessage_power`, `i_client_poke_power`                                                                                                                                                                                                 |
| Kick (Nickname, Spam, Regeln) | `i_client_kick_from_server_power`, `i_client_kick_from_channel_power`                                                                                                                                                                                       |
| Ban (Spam, Anti-Proxy)        | `b_client_ban_create`, `i_client_ban_power`, `i_client_ban_max_bantime`                                                                                                                                                                                     |
| Servergruppe (Regeln, Proxy)  | `i_group_member_add_power`, `i_group_member_remove_power`                                                                                                                                                                                                   |
| Verschieben (Privat, Regeln)  | `i_client_move_power`                                                                                                                                                                                                                                       |
| Support: öffnen/schließen     | `b_channel_modify_name`, `b_channel_modify_maxclients`, `i_channel_modify_power`                                                                                                                                                                            |
| Staffliste                    | `b_virtualserver_servergroup_client_list`, `b_channel_modify_description`, `i_channel_modify_power`                                                                                                                                                         |
| Channel-Creator               | `b_channel_create_permanent`, `b_channel_create_child`, `b_channel_create_with_maxclients`, `b_channel_create_with_description`, `b_channel_delete_permanent`, `i_channel_delete_power`, `i_permission_modify_power`                                        |
| Privat-Channel                | `b_channel_create_temporary` (bzw. `…_semi_permanent`/`…_permanent`), `b_channel_create_child`, `b_channel_create_with_password`, `i_channel_create_modify_with_temp_delete_delay`, `b_virtualserver_channelgroup_list`, `i_channel_group_member_add_power` |
| Regelbestätigung per Chat     | Privatnachrichten an den Bot (`b_virtualserver_notify_register`); fehlt das Recht, meldet der Dienst beim Start eine Warnung und der Chat-Weg bleibt wirkungslos                                                                                            |
| Anti-Proxy                    | `b_client_remoteaddress_view`                                                                                                                                                                                                                               |

Alle Befehle laufen über die gedrosselte Queue (`TS3_QUERY_RATE_LIMIT`).

## Umstieg vom SinusBot

1. Modul im Webinterface einrichten und **im Testmodus** einschalten. Das alte Skript läuft weiter.
2. Ein, zwei Tage das Automatik-Protokoll ansehen: Trifft das Modul die richtigen Spieler, legt es die erwarteten Channels an?
3. **Altes Skript abschalten**, dann erst den Testmodus beenden. Laufen beide gleichzeitig scharf, arbeiten zwei Bots gegeneinander – beim Channel-Creator etwa legt einer an, was der andere löscht.
4. Beim Channel-Creator die vorhandenen Channels des alten Skripts mit „Vorhandene Channels übernehmen“ übergeben; sonst bleiben sie für immer stehen.

Die Einstellungen der alten Skripte werden nicht importiert, sondern neu eingetragen.

## Grenzen

- **Umbenennungen** meldet ServerQuery nicht als Ereignis; sie fallen erst bei der nächsten Abfrage auf (Vorgabe alle 60 s).
- **Fristen** der Regelbestätigung werden ebenfalls mit der Abfrage geprüft, ein Kick kommt also bis zu eine Minute später.
- **Chat-Spam und Anstupsen unter Spielern** sieht ein Query-Client nicht.
- **Temporäre Privat-Channels** ziehen den Bot beim Anlegen kurz hinein; er geht danach in seinen Channel zurück.
- Die Staffliste zeigt geänderte Einstellungen nach der nächsten Abfrage, neue Gruppenmitglieder, die offline sind, nach spätestens fünf Minuten.
