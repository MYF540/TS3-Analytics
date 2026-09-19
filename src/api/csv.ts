import type { FastifyReply } from 'fastify';

/** Column headers of the CSV exports (German, like the UI). */
export const CSV_LABELS = {
  rank: 'Platz',
  userId: 'Spieler-ID',
  uid: 'UID',
  nickname: 'Nickname',
  onlineH: 'Spielzeit (h)',
  onlineS: 'Spielzeit (s)',
  activeH: 'Aktivzeit (h)',
  activeS: 'Aktivzeit (s)',
  sessions: 'Sessions',
  firstSeen: 'Erstmals gesehen',
  lastSeen: 'Zuletzt gesehen',
  country: 'Land',
  online: 'Online',
  accounts: 'Verknüpfte Accounts',
  yes: 'ja',
  no: 'nein',
  metric: { online: 'Spielzeit', active: 'Aktivzeit', longestSession: 'Längste Session' },
} as const;

export function sendCsv(reply: FastifyReply, filename: string, csv: string): FastifyReply {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`)
    .header('cache-control', 'no-store')
    .send(csv);
}
