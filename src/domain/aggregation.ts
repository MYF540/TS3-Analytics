/**
 * Pure aggregation rules shared by incremental updates and `stats:rebuild`.
 * Using the same functions in both paths is what keeps them identical.
 */
import { berlinDay, HOUR_S, hourStart, splitByDay } from './time.js';

export type AggregatedState = 'active' | 'idle' | 'afk' | 'unknown';

export interface DailyDelta {
  day: number;
  onlineS: number;
  activeS: number;
  idleS: number;
  afkS: number;
  unknownS: number;
  sessions: number;
  longestSessionS: number;
}

export interface ClosedSessionInput {
  joinAt: number;
  leaveAt: number;
  source: 'live' | 'import';
}

export interface ClosedSegmentInput {
  startAt: number;
  endAt: number;
  state: AggregatedState;
}

export function emptyDelta(day: number): DailyDelta {
  return {
    day,
    onlineS: 0,
    activeS: 0,
    idleS: 0,
    afkS: 0,
    unknownS: 0,
    sessions: 0,
    longestSessionS: 0,
  };
}

/**
 * Per-day contribution of a closed session: online time is split at Berlin midnights; the session
 * count and its full duration (for "longest session") belong to the day it started.
 * Imported sessions have no activity data, so their time also counts as `unknown`.
 */
export function sessionDailyDeltas(session: ClosedSessionInput): DailyDelta[] {
  const joinDay = berlinDay(session.joinAt);
  const deltas = new Map<number, DailyDelta>([[joinDay, emptyDelta(joinDay)]]);
  for (const piece of splitByDay(session.joinAt, session.leaveAt)) {
    const delta = deltas.get(piece.day) ?? emptyDelta(piece.day);
    delta.onlineS += piece.seconds;
    if (session.source === 'import') delta.unknownS += piece.seconds;
    deltas.set(piece.day, delta);
  }
  const first = deltas.get(joinDay);
  if (first) {
    first.sessions = 1;
    first.longestSessionS = session.leaveAt - session.joinAt;
  }
  return [...deltas.values()].sort((a, b) => a.day - b.day);
}

const STATE_FIELD = {
  active: 'activeS',
  idle: 'idleS',
  afk: 'afkS',
  unknown: 'unknownS',
} as const satisfies Record<AggregatedState, keyof DailyDelta>;

/** Per-day contribution of a closed activity segment to the matching state column. */
export function segmentDailyDeltas(segment: ClosedSegmentInput): DailyDelta[] {
  return splitByDay(segment.startAt, segment.endAt).map((piece) => {
    const delta = emptyDelta(piece.day);
    delta[STATE_FIELD[segment.state]] = piece.seconds;
    return delta;
  });
}

/** Adds `delta` into `target` (sums, and max for the longest session). */
export function mergeDelta(target: DailyDelta, delta: DailyDelta): void {
  target.onlineS += delta.onlineS;
  target.activeS += delta.activeS;
  target.idleS += delta.idleS;
  target.afkS += delta.afkS;
  target.unknownS += delta.unknownS;
  target.sessions += delta.sessions;
  target.longestSessionS = Math.max(target.longestSessionS, delta.longestSessionS);
}

export interface HourStats {
  /** Start of the UTC hour. */
  hour: number;
  /** Sum of session seconds within the hour (average online = onlineS / 3600). */
  onlineS: number;
  /** Maximum number of concurrent sessions within the hour. */
  maxOnline: number;
  uniqueUsers: number;
}

export interface SessionSpan {
  userId: number;
  joinAt: number;
  leaveAt: number;
}

interface HourBucket {
  onlineS: number;
  users: Set<number>;
  /** [time, +1 | -1] */
  events: [number, number][];
}

function finishBucket(hour: number, bucket: HourBucket): HourStats {
  // Half-open intervals: at equal times, leaving (-1) is applied before joining (+1).
  bucket.events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let max = 0;
  for (const [, delta] of bucket.events) {
    current += delta;
    if (current > max) max = current;
  }
  return { hour, onlineS: bucket.onlineS, maxOnline: max, uniqueUsers: bucket.users.size };
}

/**
 * Computes hourly server statistics for the UTC hours in `[from, to)` (both hour-aligned).
 * `sessions` must contain every closed session overlapping the range, **sorted by `joinAt`**.
 * Streams: finished hours are yielded as soon as no later session can touch them, so memory
 * stays bounded when fed the full history.
 */
export function* aggregateHours(
  sessions: Iterable<SessionSpan>,
  from: number,
  to: number,
): Generator<HourStats> {
  const buckets = new Map<number, HourBucket>();
  let nextHour = from;

  function* emitUntil(limit: number): Generator<HourStats> {
    while (nextHour < to && nextHour + HOUR_S <= limit) {
      const bucket = buckets.get(nextHour);
      if (bucket) {
        buckets.delete(nextHour);
        yield finishBucket(nextHour, bucket);
      }
      nextHour += HOUR_S;
    }
  }

  let lastJoin = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    if (session.joinAt < lastJoin) throw new Error('aggregateHours: sessions must be sorted');
    lastJoin = session.joinAt;
    // No session seen from now on starts before this one, so earlier hours are final.
    yield* emitUntil(session.joinAt);

    const start = Math.max(session.joinAt, from);
    const end = Math.min(session.leaveAt, to);
    for (let hour = hourStart(start); hour < end; hour += HOUR_S) {
      const a = Math.max(start, hour);
      const b = Math.min(end, hour + HOUR_S);
      if (b <= a) continue;
      let bucket = buckets.get(hour);
      if (!bucket) {
        bucket = { onlineS: 0, users: new Set(), events: [] };
        buckets.set(hour, bucket);
      }
      bucket.onlineS += b - a;
      bucket.users.add(session.userId);
      bucket.events.push([a, 1], [b, -1]);
    }
  }
  yield* emitUntil(Number.POSITIVE_INFINITY);
}
