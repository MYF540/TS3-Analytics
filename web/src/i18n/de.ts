/**
 * German UI texts. All visible strings live here so further languages can be added later
 * (same keys, other file). Placeholders use `{name}`.
 */
export const de = {
  'app.title': 'TS3 Analytics',
  'app.skipToContent': 'Zum Inhalt springen',

  'nav.dashboard': 'Dashboard',
  'nav.players': 'Spieler',
  'nav.leaderboards': 'Leaderboards',
  'nav.main': 'Hauptnavigation',

  'theme.toggle': 'Farbschema wechseln',
  'theme.light': 'Hell',
  'theme.dark': 'Dunkel',

  'status.checking': 'Status wird geprüft …',
  'status.ok': 'Mit TeamSpeak verbunden',
  'status.degraded': 'Keine Verbindung zum TeamSpeak-Server',
  'status.down': 'Datenbank nicht erreichbar',
  'status.unreachable': 'Dienst nicht erreichbar',

  'page.dashboard.title': 'Dashboard',
  'page.dashboard.intro': 'Überblick über Aktivität und Auslastung des Servers.',
  'page.players.title': 'Spieler',
  'page.players.intro': 'Alle erfassten Spieler mit Suche und Spielzeit.',
  'page.player.title': 'Spieler',
  'page.player.intro': 'Details zu Spieler #{id}.',
  'page.leaderboards.title': 'Leaderboards',
  'page.leaderboards.intro': 'Ranglisten nach Spielzeit, Aktivität und längster Session.',
  'page.notFound.title': 'Seite nicht gefunden',
  'page.notFound.text': 'Diese Seite gibt es nicht.',
  'page.notFound.back': 'Zurück zum Dashboard',
  'page.placeholder': 'Inhalte folgen in Kürze.',

  'error.title': 'Etwas ist schiefgelaufen',
  'error.NOT_FOUND': 'Nicht gefunden.',
  'error.USER_NOT_FOUND': 'Dieser Spieler existiert nicht.',
  'error.VALIDATION_ERROR': 'Ungültige Eingabe.',
  'error.INVALID_RANGE': 'Ungültiger Zeitraum.',
  'error.UNAUTHORIZED': 'Bitte melde dich an.',
  'error.FORBIDDEN': 'Dafür fehlen dir die Rechte.',
  'error.RATE_LIMITED': 'Zu viele Anfragen, bitte kurz warten.',
  'error.INTERNAL_ERROR': 'Interner Fehler. Details stehen im Server-Log.',
  'error.NETWORK': 'Der Server ist nicht erreichbar.',
  'error.UNKNOWN': 'Unbekannter Fehler.',

  'unit.hours': '{value} h',
  'unit.minutes': '{value} min',
} as const;

export type MessageKey = keyof typeof de;
