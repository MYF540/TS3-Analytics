# Datenschutz: Auskunft und Löschung

Beides erledigt ein Admin auf der Spielerseite in der Karte „Datenschutz“. Jede der beiden Aktionen steht im Protokoll – mit der internen Spieler-ID, nie mit der UID.

## Auskunft (Export)

„Alle Daten als JSON exportieren“ lädt eine Datei `spieler-<ID>.json` mit allem, was zu dieser UID gespeichert ist: Stammdaten, Nickname-Verlauf, Sessions, Tageswerte, Notizen samt Verlauf, Tags, verknüpfte Accounts, Hinweise, Bans, Servergruppen-Änderungen, Rang-Daten und Moderationsaktionen.

IP-Adressen werden nie gespeichert, nur nicht umkehrbare Prüfsummen. Der Export enthält deshalb keine Prüfsummen, sondern nur die Anzahl unterschiedlicher Adressen sowie Länder und Zeiträume – daraus lässt sich nichts zurückrechnen.

## Löschung (Anonymisieren)

Zur Bestätigung muss die UID des Spielers eingetippt werden.

**Entfernt werden:** UID (ersetzt durch eine zufällige Kennung), Client-Datenbank-ID, Nicknames, Plattform/Version/Land, IP-Prüfsummen, Notizen samt Verlauf, Tags, Hinweise, Account-Verknüpfungen und alle Rang-Daten. In der gespiegelten Banliste und im Servergruppen-Verlauf wird der Personenbezug entfernt.

**Erhalten bleiben:** Sessions, Aktivitätssegmente und die Tages- und Gesamtwerte – als anonymer Eintrag. Damit stimmen Serverstatistiken wie „wie viele waren gleichzeitig online“ weiterhin.

**Sichtbarkeit:** Anonymisierte Einträge erscheinen nicht mehr in Leaderboards, Spielerliste, Suche und Rängen. Ihre Spielerseite meldet, dass die Daten anonymisiert wurden.

### Wichtig

- Ist der Spieler gerade online, wird die Anonymisierung abgelehnt. Erst trennen (z. B. kicken), dann anonymisieren – sonst würde die laufende Sitzung weiter unter der alten Identität geschrieben.
- Ein **Ban auf dem TeamSpeak-Server** gehört dem Server, nicht dieser Anwendung. Er wird nicht aufgehoben, und der nächste Abgleich der Banliste würde die UID erneut spiegeln. Wenn die Löschung auch den Ban betrifft, den Ban vorher auf dem Server entfernen.
- Verbindet sich dieselbe UID später wieder, entsteht ein neuer Spieler ohne Bezug zum anonymisierten Eintrag.
- Das Protokoll (Audit-Log) bleibt unverändert. Es belegt, wer wann welche Änderung vorgenommen hat, und kann Nicknames aus früheren Aktionen enthalten.
- **Sicherungen:** Ältere Sicherungen enthalten die Daten weiterhin. Sie laufen nach `BACKUP_KEEP` Tagen aus (Standard 14). Wer früher endgültig löschen muss, entfernt zusätzlich die betroffenen Sicherungen aus `BACKUP_DIR`.
