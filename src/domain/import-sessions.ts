/**
 * Turns connect and disconnect events from old server logs into sessions (T8.5). Pure: it only
 * sees events and returns sessions, so every special case can be tested without files.
 *
 * The log only carries the client database id, never the connection id. Two connections of the
 * same account at the same time therefore cannot be told apart – they are paired oldest first
 * (see docs/import-logs.md).
 */

export type SessionEvent =
  | { kind: 'connect'; at: number; dbid: number; nick: string }
  | { kind: 'disconnect'; at: number; dbid: number; nick: string }
  | { kind: 'serverStart'; at: number }
  | { kind: 'serverStop'; at: number };

/** Why a session ended – `disconnect` is the normal case, the rest is bookkeeping. */
export type SessionEnd = 'disconnect' | 'serverStop' | 'serverStart' | 'endOfLogs' | 'maxDuration';

export interface ImportedSession {
  dbid: number;
  /** Name at the time of the connection; the disconnect line may carry a newer one. */
  nick: string;
  joinAt: number;
  leaveAt: number;
  end: SessionEnd;
}

export interface SessionCounters {
  connects: number;
  disconnects: number;
  sessions: number;
  /** Account connected again while a connection was still open. */
  doubleConnects: number;
  /** Disconnect without a matching connect – dropped. */
  strayDisconnects: number;
  /** Sessions cut short because they ran longer than allowed. */
  capped: number;
  /** Sessions closed by a server stop, a server start or the end of the logs. */
  closedByServer: number;
  closedAtEnd: number;
  /** Events whose timestamp was older than the previous one; clamped. */
  backwardsInTime: number;
  /** Connect and disconnect in the same second – dropped, they carry no time. */
  empty: number;
}

export interface SessionOptions {
  /**
   * Longest session that is believed, in seconds. Longer ones are cut to this length and
   * counted; a permanently connected bot would otherwise add years of "online time".
   * `undefined` keeps every session as it is.
   */
  maxDurationS?: number | undefined;
}

interface OpenSession {
  joinAt: number;
  nick: string;
}

function emptyCounters(): SessionCounters {
  return {
    connects: 0,
    disconnects: 0,
    sessions: 0,
    doubleConnects: 0,
    strayDisconnects: 0,
    capped: 0,
    closedByServer: 0,
    closedAtEnd: 0,
    backwardsInTime: 0,
    empty: 0,
  };
}

export class SessionBuilder {
  /** Open connections per database id, oldest first. */
  private readonly open = new Map<number, OpenSession[]>();
  private last = Number.NEGATIVE_INFINITY;
  readonly counters = emptyCounters();

  constructor(private readonly options: SessionOptions = {}) {}

  /** Number of connections that are still open. */
  get openCount(): number {
    let total = 0;
    for (const list of this.open.values()) total += list.length;
    return total;
  }

  /** Feeds one event and returns the sessions it finished. */
  push(event: SessionEvent): ImportedSession[] {
    const at = this.clamp(event.at);
    switch (event.kind) {
      case 'connect': {
        this.counters.connects++;
        const list = this.open.get(event.dbid);
        if (list && list.length > 0) {
          this.counters.doubleConnects++;
          list.push({ joinAt: at, nick: event.nick });
        } else {
          this.open.set(event.dbid, [{ joinAt: at, nick: event.nick }]);
        }
        return [];
      }
      case 'disconnect': {
        this.counters.disconnects++;
        const list = this.open.get(event.dbid);
        const start = list?.shift();
        if (!start) {
          this.counters.strayDisconnects++;
          return [];
        }
        if (list?.length === 0) this.open.delete(event.dbid);
        const session = this.close(event.dbid, start, at, 'disconnect');
        return session ? [session] : [];
      }
      // A stop ends every connection; a start in the middle of the logs means the server was
      // restarted after a crash, and the connections before it are just as over.
      case 'serverStop':
      case 'serverStart':
        return this.closeAll(at, event.kind);
    }
  }

  /** Closes what is still open at the end of all logs. */
  endOfLogs(at: number): ImportedSession[] {
    return this.closeAll(this.clamp(at), 'endOfLogs');
  }

  private closeAll(at: number, end: SessionEnd): ImportedSession[] {
    const sessions: ImportedSession[] = [];
    for (const [dbid, list] of this.open) {
      for (const start of list) {
        const session = this.close(dbid, start, at, end);
        if (session) sessions.push(session);
      }
    }
    this.open.clear();
    return sessions.sort((a, b) => a.joinAt - b.joinAt || a.dbid - b.dbid);
  }

  private close(
    dbid: number,
    start: OpenSession,
    leaveAt: number,
    end: SessionEnd,
  ): ImportedSession | undefined {
    let finalEnd = end;
    let finalLeave = leaveAt;
    const max = this.options.maxDurationS;
    if (max !== undefined && finalLeave - start.joinAt > max) {
      finalLeave = start.joinAt + max;
      finalEnd = 'maxDuration';
      this.counters.capped++;
    }
    if (finalLeave <= start.joinAt) {
      this.counters.empty++;
      return undefined;
    }
    this.counters.sessions++;
    if (end === 'serverStop' || end === 'serverStart') this.counters.closedByServer++;
    if (end === 'endOfLogs') this.counters.closedAtEnd++;
    return { dbid, nick: start.nick, joinAt: start.joinAt, leaveAt: finalLeave, end: finalEnd };
  }

  /** Logs are read in order; a timestamp going backwards is a clock change, not a new order. */
  private clamp(at: number): number {
    if (at < this.last) {
      this.counters.backwardsInTime++;
      return this.last;
    }
    this.last = at;
    return at;
  }
}

/** Convenience for tests and small runs: all sessions of a finished list of events. */
export function reconstructSessions(
  events: readonly SessionEvent[],
  options: SessionOptions & { endAt?: number } = {},
): { sessions: ImportedSession[]; counters: SessionCounters } {
  const builder = new SessionBuilder(options);
  const sessions: ImportedSession[] = [];
  let last = 0;
  for (const event of events) {
    last = Math.max(last, event.at);
    sessions.push(...builder.push(event));
  }
  sessions.push(...builder.endOfLogs(options.endAt ?? last));
  return { sessions, counters: builder.counters };
}
