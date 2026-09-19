/**
 * Parses server-group changes from TS3 server log lines (T5.7). Only these lines are ever looked
 * at; raw log lines are never stored (other lines contain IP addresses).
 *
 * Examples (the nickname in front of `(id:…)` exists in newer server versions only):
 *   2026-09-19 18:22:01.123456|INFO    |VirtualServer |1  |client (id:17) was added to servergroup 'Server Admin'(id:6) by client 'Admin'(id:2)
 *   2026-09-19 18:22:01.123456|INFO    |VirtualServer |1  |client 'Bob'(id:17) was removed from servergroup 'VIP'(id:9) by client 'Admin'(id:2)
 */

export interface GroupChange {
  /** UTC seconds (the server logs in UTC). */
  at: number;
  /** Microsecond part of the timestamp, to order and deduplicate lines of the same second. */
  micros: number;
  action: 'added' | 'removed';
  /** Client database id of the member. */
  dbid: number;
  nickname: string | undefined;
  groupId: number;
  groupName: string;
  invokerName: string;
  invokerDbid: number;
}

const LINE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?\|[^|]*\|[^|]*\|[^|]*\|client (?:'(.*?)')?\(id:(\d+)\) was (added to|removed from) servergroup '(.*?)'\(id:(\d+)\) by client '(.*?)'\(id:(\d+)\)\s*$/;

export function parseGroupChange(line: string): GroupChange | undefined {
  const m = LINE.exec(line.trim());
  if (!m) return undefined;
  const [
    ,
    y,
    mo,
    d,
    h,
    mi,
    s,
    frac,
    nickname,
    dbid,
    verb,
    groupName,
    groupId,
    invoker,
    invokerDbid,
  ] = m;
  return {
    at: Math.floor(
      Date.UTC(+(y ?? 0), +(mo ?? 1) - 1, +(d ?? 1), +(h ?? 0), +(mi ?? 0), +(s ?? 0)) / 1000,
    ),
    micros: Number((frac ?? '0').padEnd(6, '0')),
    action: verb === 'added to' ? 'added' : 'removed',
    dbid: Number(dbid),
    nickname: nickname || undefined,
    groupId: Number(groupId),
    groupName: groupName ?? '',
    invokerName: invoker ?? '',
    invokerDbid: Number(invokerDbid),
  };
}

/** Position of an entry in the log, for "only newer than the last processed line". */
export function logPosition(change: Pick<GroupChange, 'at' | 'micros'>): number {
  return change.at * 1_000_000 + change.micros;
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?\|/;

/** Log position of any log line (only its timestamp is read), or undefined. */
export function lineLogPosition(line: string): number | undefined {
  const m = TIMESTAMP.exec(line.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, frac] = m;
  const at =
    Date.UTC(+(y ?? 0), +(mo ?? 1) - 1, +(d ?? 1), +(h ?? 0), +(mi ?? 0), +(s ?? 0)) / 1000;
  return logPosition({ at, micros: Number((frac ?? '0').padEnd(6, '0')) });
}
