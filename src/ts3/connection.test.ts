import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../logging/logger.js';
import { NotConnectedError, Ts3Connection, type ConnectionState } from './connection.js';
import { FakeTs3Server } from './fake-transport.js';
import { CLIENT_TYPE_QUERY, type Ts3Client } from './types.js';

let server: FakeTs3Server;
let connection: Ts3Connection;
let states: ConnectionState[];

function createConnection(options: { keepAliveMs?: number } = {}) {
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 5, initialBackoffMs: 1000, maxBackoffMs: 8000, jitter: 0, ...options },
    { logger: createSilentLogger() },
  );
  states = [];
  connection.on('stateChange', (s) => states.push(s));
  return connection;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  server = new FakeTs3Server(() => Date.now());
});

afterEach(async () => {
  await connection.stop();
  vi.useRealTimers();
});

describe('Ts3Connection', () => {
  it('connects and runs commands', async () => {
    createConnection().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.state).toBe('connected');
    server.join({ uid: 'u1', nickname: 'Alice' });
    expect((await connection.clientList()).map((c) => c.nickname)).toEqual(['Alice']);
  });

  it('reconnects after the connection drops', async () => {
    createConnection().start();
    await vi.advanceTimersByTimeAsync(0);
    const disconnected = vi.fn();
    connection.on('disconnected', disconnected);

    server.dropConnection();
    expect(connection.state).toBe('waiting');
    expect(disconnected).toHaveBeenCalledOnce();
    await expect(connection.clientList()).rejects.toBeInstanceOf(NotConnectedError);

    await vi.advanceTimersByTimeAsync(999);
    expect(server.connectAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.connectAttempts).toBe(2);
    expect(connection.state).toBe('connected');
    expect(states).toEqual(['connecting', 'connected', 'waiting', 'connecting', 'connected']);
  });

  it('reports its status for the status page', async () => {
    server.failConnects = 1;
    createConnection().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.status()).toMatchObject({
      state: 'waiting',
      failedAttempts: 1,
      lastConnectedAt: undefined,
      lastError: { at: 0, message: 'connection refused (fake)' },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.status()).toMatchObject({
      state: 'connected',
      since: 1,
      failedAttempts: 0,
      lastConnectedAt: 1,
      queuedCommands: 0,
    });
    await vi.advanceTimersByTimeAsync(5000);
    server.dropConnection(new Error('lost 192.168.1.20:10011'));
    expect(connection.status()).toMatchObject({
      state: 'waiting',
      since: 6,
      lastConnectedAt: 1,
      lastError: { at: 6, message: 'lost [IP]:10011' },
    });
  });

  it('backs off exponentially while the server is unreachable and resets after success', async () => {
    server.failConnects = 4;
    const attemptsAt: number[] = [];
    const original = server.createTransport;
    server.createTransport = () => {
      attemptsAt.push(Date.now());
      return original();
    };
    createConnection().start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(connection.state).toBe('connected');
    // Delays 1s, 2s, 4s, 8s (capped at maxBackoff) between the five attempts.
    expect(attemptsAt.slice(1).map((t, i) => t - (attemptsAt[i] ?? 0))).toEqual([
      1000, 2000, 4000, 8000,
    ]);

    // After a successful connect the next drop starts again with 1 s.
    server.dropConnection();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.state).toBe('connected');
  });

  it('caps the backoff delay', () => {
    createConnection();
    expect([1, 2, 3, 4, 5, 10].map((a) => connection.backoffFor(a))).toEqual([
      1000, 2000, 4000, 8000, 8000, 8000,
    ]);
  });

  it('sends keepalives and reconnects when a keepalive fails', async () => {
    createConnection({ keepAliveMs: 30_000 }).start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.commandLog.filter((c) => c.command === 'whoami')).toHaveLength(1);

    server.failPing = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connection.state).toBe('waiting');
    server.failPing = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.state).toBe('connected');
    expect(server.connectAttempts).toBe(2);
  });

  it('hides query clients in client lists and join events', async () => {
    createConnection().start();
    await vi.advanceTimersByTimeAsync(0);
    const joined: Ts3Client[] = [];
    connection.on('clientConnect', (c) => joined.push(c));

    server.join({ uid: 'human', nickname: 'Alice' });
    server.join({ uid: 'serveradmin', nickname: 'Query', type: CLIENT_TYPE_QUERY });

    expect(joined.map((c) => c.uid)).toEqual(['human']);
    expect((await connection.clientList()).map((c) => c.uid)).toEqual(['human']);
  });

  it('forwards leave and move events', async () => {
    createConnection().start();
    await vi.advanceTimersByTimeAsync(0);
    const events: string[] = [];
    connection.on('clientMoved', (e) =>
      events.push(`move ${String(e.clid)}→${String(e.channelId)}`),
    );
    connection.on('clientDisconnect', (e) => events.push(`leave ${String(e.clid)}`));
    const clid = server.join({ uid: 'u', nickname: 'A' });
    server.move(clid, 5);
    server.leave(clid);
    expect(events).toEqual([`move ${String(clid)}→5`, `leave ${String(clid)}`]);
  });

  it('stops reconnecting after stop()', async () => {
    createConnection().start();
    await vi.advanceTimersByTimeAsync(0);
    server.dropConnection();
    await connection.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.connectAttempts).toBe(1);
    expect(connection.state).toBe('stopped');
  });

  it('stops cleanly while connected', async () => {
    createConnection().start();
    await vi.advanceTimersByTimeAsync(0);
    await connection.stop();
    expect(server.connected).toBe(false);
  });

  it('routes commands through the rate-limited queue', async () => {
    createConnection().start();
    await vi.advanceTimersByTimeAsync(0);
    const calls = Array.from({ length: 12 }, () => connection.channelList());
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(calls);
    const starts = server.commandLog.filter((c) => c.command === 'channellist').map((c) => c.at);
    for (const [i, t] of starts.entries()) {
      expect(starts.slice(i).filter((s) => s < t + 1000).length).toBeLessThanOrEqual(5);
    }
  });
});
