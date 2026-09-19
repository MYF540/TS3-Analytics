/**
 * Calendar helpers for Europe/Berlin without external dependencies.
 * Timestamps are UTC Unix seconds; a "day" is the Berlin calendar date encoded as YYYYMMDD.
 */

export const TIME_ZONE = 'Europe/Berlin';
export const HOUR_S = 3600;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

// Berlin's UTC offset only changes on the hour, so caching per UTC hour is exact.
const offsetCache = new Map<number, number>();
const MAX_CACHE = 200_000;

/** UTC offset of Europe/Berlin at `ts`, in seconds (3600 in winter, 7200 in summer). */
export function berlinOffset(ts: number): number {
  const hour = Math.floor(ts / HOUR_S);
  const cached = offsetCache.get(hour);
  if (cached !== undefined) return cached;

  const probe = hour * HOUR_S;
  const p: Record<string, number> = {};
  for (const part of partsFormatter.formatToParts(probe * 1000)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day, p.hour, p.minute, p.second) / 1000;
  const offset = asUtc - probe;

  if (offsetCache.size >= MAX_CACHE) offsetCache.clear();
  offsetCache.set(hour, offset);
  return offset;
}

function dayFromUtcDate(date: Date): number {
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

/** Berlin calendar day (YYYYMMDD) containing `ts`. */
export function berlinDay(ts: number): number {
  return dayFromUtcDate(new Date((ts + berlinOffset(ts)) * 1000));
}

function dayToUtcMidnight(day: number): number {
  const year = Math.floor(day / 10000);
  const month = Math.floor(day / 100) % 100;
  return Date.UTC(year, month - 1, day % 100) / 1000;
}

/** The day after `day` (YYYYMMDD). */
export function nextDay(day: number): number {
  return dayFromUtcDate(new Date((dayToUtcMidnight(day) + 86_400) * 1000));
}

const dayStartCache = new Map<number, number>();

/** UTC timestamp of 00:00 Berlin time on `day`. */
export function berlinDayStart(day: number): number {
  const cached = dayStartCache.get(day);
  if (cached !== undefined) return cached;
  const localMidnight = dayToUtcMidnight(day);
  // Midnight never falls into a DST gap in Berlin (switches happen at 02:00/03:00).
  let ts = localMidnight - berlinOffset(localMidnight);
  ts = localMidnight - berlinOffset(ts);
  if (dayStartCache.size >= MAX_CACHE) dayStartCache.clear();
  dayStartCache.set(day, ts);
  return ts;
}

/** Parses `YYYY-MM-DD` into YYYYMMDD, or returns `undefined` if it is not a valid date. */
export function parseDay(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return undefined;
  const day = Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]);
  return dayFromUtcDate(new Date(dayToUtcMidnight(day) * 1000)) === day ? day : undefined;
}

export interface DayPiece {
  day: number;
  seconds: number;
}

/** Splits `[start, end)` at Berlin midnights. Empty intervals yield no pieces. */
export function splitByDay(start: number, end: number): DayPiece[] {
  const pieces: DayPiece[] = [];
  let t = start;
  while (t < end) {
    const day = berlinDay(t);
    const boundary = Math.min(end, berlinDayStart(nextDay(day)));
    pieces.push({ day, seconds: boundary - t });
    t = boundary;
  }
  return pieces;
}

/** Start of the UTC hour containing `ts`. */
export function hourStart(ts: number): number {
  return ts - (((ts % HOUR_S) + HOUR_S) % HOUR_S);
}
