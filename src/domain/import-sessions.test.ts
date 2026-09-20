import { describe, expect, it } from 'vitest';
import { reconstructSessions, SessionBuilder, type SessionEvent } from './import-sessions.js';

const T0 = 1_500_000_000;
const H = 3600;

const connect = (at: number, dbid: number, nick = `n${String(dbid)}`): SessionEvent => ({
  kind: 'connect',
  at,
  dbid,
  nick,
});
const disconnect = (at: number, dbid: number, nick = `n${String(dbid)}`): SessionEvent => ({
  kind: 'disconnect',
  at,
  dbid,
  nick,
});

describe('reconstructSessions', () => {
  it('pairs a connection with its disconnection', () => {
    const { sessions, counters } = reconstructSessions([
      connect(T0, 7, 'Spieler'),
      disconnect(T0 + 2 * H, 7),
    ]);
    expect(sessions).toEqual([
      { dbid: 7, nick: 'Spieler', joinAt: T0, leaveAt: T0 + 2 * H, end: 'disconnect' },
    ]);
    expect(counters).toMatchObject({ connects: 1, disconnects: 1, sessions: 1 });
  });

  it('keeps several players apart', () => {
    const { sessions } = reconstructSessions([
      connect(T0, 1),
      connect(T0 + 60, 2),
      disconnect(T0 + 120, 1),
      disconnect(T0 + 180, 2),
    ]);
    expect(sessions.map((s) => [s.dbid, s.joinAt, s.leaveAt])).toEqual([
      [1, T0, T0 + 120],
      [2, T0 + 60, T0 + 180],
    ]);
  });

  it('pairs two connections of one account oldest first', () => {
    const { sessions, counters } = reconstructSessions([
      connect(T0, 7, 'erste'),
      connect(T0 + 60, 7, 'zweite'),
      disconnect(T0 + 120, 7),
      disconnect(T0 + 180, 7),
    ]);
    expect(sessions).toEqual([
      { dbid: 7, nick: 'erste', joinAt: T0, leaveAt: T0 + 120, end: 'disconnect' },
      { dbid: 7, nick: 'zweite', joinAt: T0 + 60, leaveAt: T0 + 180, end: 'disconnect' },
    ]);
    expect(counters.doubleConnects).toBe(1);
  });

  it('drops a disconnection without a connection and counts it', () => {
    const { sessions, counters } = reconstructSessions([disconnect(T0, 7)]);
    expect(sessions).toEqual([]);
    expect(counters).toMatchObject({ strayDisconnects: 1, sessions: 0 });
  });

  it('closes everything when the server stops', () => {
    const { sessions, counters } = reconstructSessions([
      connect(T0, 1),
      connect(T0 + 60, 2),
      { kind: 'serverStop', at: T0 + 600 },
      connect(T0 + 700, 1),
      disconnect(T0 + 800, 1),
    ]);
    expect(sessions).toEqual([
      { dbid: 1, nick: 'n1', joinAt: T0, leaveAt: T0 + 600, end: 'serverStop' },
      { dbid: 2, nick: 'n2', joinAt: T0 + 60, leaveAt: T0 + 600, end: 'serverStop' },
      { dbid: 1, nick: 'n1', joinAt: T0 + 700, leaveAt: T0 + 800, end: 'disconnect' },
    ]);
    expect(counters.closedByServer).toBe(2);
  });

  it('treats a server start in the middle of the logs like a crash', () => {
    const { sessions } = reconstructSessions([
      connect(T0, 1),
      { kind: 'serverStart', at: T0 + 300 },
      disconnect(T0 + 400, 1),
    ]);
    expect(sessions).toEqual([
      { dbid: 1, nick: 'n1', joinAt: T0, leaveAt: T0 + 300, end: 'serverStart' },
    ]);
  });

  it('closes what is still open at the end of the logs', () => {
    const { sessions, counters } = reconstructSessions([connect(T0, 1)], { endAt: T0 + 90 });
    expect(sessions).toEqual([
      { dbid: 1, nick: 'n1', joinAt: T0, leaveAt: T0 + 90, end: 'endOfLogs' },
    ]);
    expect(counters.closedAtEnd).toBe(1);
  });

  it('cuts a session that ran longer than allowed', () => {
    const { sessions, counters } = reconstructSessions(
      [connect(T0, 1), disconnect(T0 + 50 * 86_400, 1)],
      { maxDurationS: 86_400 },
    );
    expect(sessions).toEqual([
      { dbid: 1, nick: 'n1', joinAt: T0, leaveAt: T0 + 86_400, end: 'maxDuration' },
    ]);
    expect(counters.capped).toBe(1);
  });

  it('keeps long sessions when no limit is set', () => {
    const { sessions, counters } = reconstructSessions([
      connect(T0, 1),
      disconnect(T0 + 50 * 86_400, 1),
    ]);
    expect(sessions[0]?.leaveAt).toBe(T0 + 50 * 86_400);
    expect(counters.capped).toBe(0);
  });

  it('drops a session without any duration', () => {
    const { sessions, counters } = reconstructSessions([connect(T0, 1), disconnect(T0, 1)]);
    expect(sessions).toEqual([]);
    expect(counters).toMatchObject({ empty: 1, sessions: 0 });
  });

  it('clamps a timestamp that goes backwards', () => {
    const { sessions, counters } = reconstructSessions([
      connect(T0, 1),
      disconnect(T0 - 600, 1),
      connect(T0 + 10, 2),
      disconnect(T0 + 70, 2),
    ]);
    expect(counters.backwardsInTime).toBe(1);
    expect(counters.empty).toBe(1);
    expect(sessions.map((s) => s.dbid)).toEqual([2]);
  });
});

describe('SessionBuilder', () => {
  it('reports sessions as they finish, not at the end', () => {
    const builder = new SessionBuilder();
    expect(builder.push(connect(T0, 1))).toEqual([]);
    expect(builder.openCount).toBe(1);
    expect(builder.push(disconnect(T0 + 60, 1))).toHaveLength(1);
    expect(builder.openCount).toBe(0);
    expect(builder.endOfLogs(T0 + 60)).toEqual([]);
  });

  it('survives a log full of connections without disconnections', () => {
    const builder = new SessionBuilder({ maxDurationS: 3600 });
    for (let i = 0; i < 1000; i++) builder.push(connect(T0 + i, i));
    const sessions = builder.endOfLogs(T0 + 10_000);
    expect(sessions).toHaveLength(1000);
    expect(builder.counters.capped).toBe(1000);
    expect(builder.openCount).toBe(0);
  });
});
