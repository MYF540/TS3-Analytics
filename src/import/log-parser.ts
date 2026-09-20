/**
 * Pure parsing of TeamSpeak server log lines (T8.4). The formats, the special cases and the
 * numbers behind the decisions are written down in docs/import-logs.md.
 */
import { berlinOffset } from '../domain/time.js';

/** Time zone the log timestamps are in; they carry none themselves. */
export const LOG_ZONES = ['utc', 'berlin'] as const;
export type LogZone = (typeof LOG_ZONES)[number];

export interface LogHeader {
  /** UTC seconds. */
  at: number;
  level: string;
  component: string;
  /** Virtual server the line belongs to; the instance log has none. */
  serverId: number | undefined;
  message: string;
}

export type LogEvent =
  | { kind: 'connect'; at: number; dbid: number; nick: string; ip: string }
  | {
      kind: 'disconnect';
      at: number;
      dbid: number;
      nick: string;
      /** Raw reason list; `invoked` says whether somebody kicked or banned the player. */
      reason: string;
      invoked: boolean;
    }
  | {
      kind: 'group';
      at: number;
      added: boolean;
      dbid: number;
      groupId: number;
      groupName: string;
      byDbid: number;
      byName: string;
    }
  | { kind: 'serverStart'; at: number }
  | { kind: 'serverStop'; at: number };

/** Not an event we need (`ignored`) or a line that does not parse at all (`unparsed`). */
export type ParseResult = LogEvent | { kind: 'ignored' } | { kind: 'unparsed' };

const HEADER =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.\d+\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/;

// The nickname is read greedily: it may contain "|" and "'", so only the last "'(id:" counts.
const CONNECT = /^client connected '(.*)'\(id:(\d+)\)(?: using a myTeamSpeak ID)? from (.+):\d+$/;
const DISCONNECT = /^client disconnected '(.*)'\(id:(\d+)\) reason '(.*)'$/;
const GROUP =
  /^client \(id:(\d+)\) was (added to|removed from) servergroup '(.*)'\(id:(\d+)\) by client '(.*)'\(id:(\d+)\)$/;

/** Known but irrelevant; it does not start with a prefix we can filter on. */
const MYTEAMSPEAK = /^client '.*'\(id:\d+\) changed myTeamSpeak ID/;

/** Messages we know and deliberately skip; everything else counts as unknown. */
const IGNORED = [
  'query client ',
  'file download ',
  'file upload ',
  'file deleted ',
  'channel ',
  'complaint added ',
  'Dropping client ',
  'Cleaning up connection ',
  'listening on ',
];

/**
 * Cheap test before any regex runs: 95 % of the lines in a real log are query clients.
 * Works on the raw line so the header does not have to be parsed first.
 */
export function isQueryLine(raw: string): boolean {
  return raw.includes('|query client ');
}

/**
 * Converts the wall clock time of a log line to UTC seconds. In Berlin the hour that exists
 * twice when the clocks go back is read as the first (summer) one.
 */
export function toUnix(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  zone: LogZone,
): number {
  const asUtc =
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000;
  if (zone === 'utc') return asUtc;
  // Two passes: the offset depends on the result, and the result on the offset.
  const first = asUtc - berlinOffset(asUtc - 7200);
  return asUtc - berlinOffset(first);
}

/** The first line of a log file starts with a byte order mark. */
const BOM = String.fromCharCode(0xfeff);

export function stripBom(raw: string): string {
  return raw.startsWith(BOM) ? raw.slice(1) : raw;
}

export function parseHeader(raw: string, zone: LogZone): LogHeader | undefined {
  const m = HEADER.exec(stripBom(raw));
  if (!m) return undefined;
  const at = toUnix(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6]),
    },
    zone,
  );
  const serverId = Number((m[9] ?? '').trim());
  return {
    at,
    level: (m[7] ?? '').trim(),
    component: (m[8] ?? '').trim(),
    serverId: Number.isInteger(serverId) && (m[9] ?? '').trim() !== '' ? serverId : undefined,
    message: m[10] ?? '',
  };
}

export function parseMessage(message: string, at: number): ParseResult {
  const connect = CONNECT.exec(message);
  if (connect) {
    return {
      kind: 'connect',
      at,
      nick: connect[1] ?? '',
      dbid: Number(connect[2]),
      ip: connect[3] ?? '',
    };
  }
  const disconnect = DISCONNECT.exec(message);
  if (disconnect) {
    const reason = disconnect[3] ?? '';
    return {
      kind: 'disconnect',
      at,
      nick: disconnect[1] ?? '',
      dbid: Number(disconnect[2]),
      reason,
      invoked: reason.includes('invokerid='),
    };
  }
  const group = GROUP.exec(message);
  if (group) {
    return {
      kind: 'group',
      at,
      added: group[2] === 'added to',
      dbid: Number(group[1]),
      groupName: group[3] ?? '',
      groupId: Number(group[4]),
      byName: group[5] ?? '',
      byDbid: Number(group[6]),
    };
  }
  if (message === 'stopped') return { kind: 'serverStop', at };
  if (message.startsWith('listening on ')) return { kind: 'serverStart', at };
  if (IGNORED.some((prefix) => message.startsWith(prefix))) return { kind: 'ignored' };
  if (MYTEAMSPEAK.test(message)) return { kind: 'ignored' };
  return { kind: 'unparsed' };
}

/**
 * Parses one raw line. `serverId` limits the result to one virtual server; lines of another
 * server are ignored rather than reported as unknown.
 */
export function parseLogLine(
  raw: string,
  options: { zone: LogZone; serverId?: number },
): ParseResult {
  if (raw === '') return { kind: 'ignored' };
  if (isQueryLine(raw)) return { kind: 'ignored' };
  const header = parseHeader(raw, options.zone);
  if (!header) return { kind: 'unparsed' };
  if (options.serverId !== undefined && header.serverId !== options.serverId) {
    return { kind: 'ignored' };
  }
  return parseMessage(header.message, header.at);
}

const FILE_NAME = /^ts3server_(\d{4})-(\d{2})-(\d{2})__(\d{2})_(\d{2})_(\d{2})\.\d+_(\d+)\.log$/;

export interface LogFileName {
  name: string;
  /** Start of the log file, from its name (UTC seconds). */
  startedAt: number;
  serverId: number;
}

/** Reads the timestamp and virtual server out of a log file name. */
export function parseLogFileName(name: string, zone: LogZone): LogFileName | undefined {
  const m = FILE_NAME.exec(name);
  if (!m) return undefined;
  return {
    name,
    startedAt: toUnix(
      {
        year: Number(m[1]),
        month: Number(m[2]),
        day: Number(m[3]),
        hour: Number(m[4]),
        minute: Number(m[5]),
        second: Number(m[6]),
      },
      zone,
    ),
    serverId: Number(m[7]),
  };
}

/** Log files of one virtual server, oldest first. Names that do not fit are left out. */
export function orderLogFiles(
  names: readonly string[],
  options: { zone: LogZone; serverId: number },
): LogFileName[] {
  return names
    .map((name) => parseLogFileName(name, options.zone))
    .filter((file): file is LogFileName => file !== undefined && file.serverId === options.serverId)
    .sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name));
}
