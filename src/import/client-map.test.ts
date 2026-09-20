import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { createTestDatabase } from '../db/testing.js';
import {
  ClientMapError,
  DbidResolver,
  isClientUid,
  isPlaceholderUid,
  placeholderUid,
  readClientMap,
} from './client-map.js';

const dir = mkdtempSync(join(tmpdir(), 'ts3a-clients-'));
const NOW = 1_500_000_000;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Builds the part of ts3server.sqlitedb this module reads. */
function serverDatabase(
  name: string,
  rows: { dbid: number; serverId: number; uid: string | null; nick?: string | null }[],
): string {
  const path = join(dir, name);
  const sqlite = new Database(path);
  sqlite.exec(
    `CREATE TABLE clients (client_id integer PRIMARY KEY, server_id integer unsigned,
       client_unique_id varchar(40), client_nickname varchar(100),
       client_lastconnected integer unsigned)`,
  );
  const insert = sqlite.prepare(
    `INSERT INTO clients (client_id, server_id, client_unique_id, client_nickname,
       client_lastconnected) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const row of rows) insert.run(row.dbid, row.serverId, row.uid, row.nick ?? null, NOW);
  sqlite.close();
  return path;
}

const UID_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const UID_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBB=';

describe('isClientUid', () => {
  it('accepts a real UID and rejects a query login', () => {
    expect(isClientUid(UID_A)).toBe(true);
    expect(isClientUid('serveradmin')).toBe(false);
    expect(isClientUid('')).toBe(false);
    expect(isClientUid(placeholderUid(5))).toBe(false);
  });
});

describe('readClientMap', () => {
  it('reads the accounts of one virtual server', () => {
    const path = serverDatabase('eins.sqlitedb', [
      { dbid: 511, serverId: 4, uid: UID_A, nick: 'Alice' },
      { dbid: 512, serverId: 4, uid: UID_B, nick: 'Bob' },
      { dbid: 9, serverId: 7, uid: UID_A, nick: 'anderer Server' },
    ]);
    const map = readClientMap(path, { serverId: 4 });
    expect([...map.keys()]).toEqual([511, 512]);
    expect(map.get(511)).toEqual({
      dbid: 511,
      uid: UID_A,
      nickname: 'Alice',
      lastConnected: NOW,
    });
  });

  it('leaves out query accounts and rows without a UID', () => {
    const path = serverDatabase('query.sqlitedb', [
      { dbid: 1, serverId: 4, uid: 'serveradmin', nick: 'serveradmin' },
      { dbid: 2, serverId: 4, uid: null },
      { dbid: 3, serverId: 4, uid: UID_A },
    ]);
    expect([...readClientMap(path, { serverId: 4 }).keys()]).toEqual([3]);
  });

  it('explains a file that is not a server database', () => {
    const path = join(dir, 'leer.sqlitedb');
    new Database(path).close();
    expect(() => readClientMap(path, { serverId: 4 })).toThrow(ClientMapError);
    expect(() => readClientMap(join(dir, 'gibtsnicht.sqlitedb'), { serverId: 4 })).toThrow(
      ClientMapError,
    );
  });
});

describe('DbidResolver', () => {
  let database: AppDatabase;

  beforeEach(() => {
    database = createTestDatabase();
  });

  afterEach(() => {
    database.close();
  });

  const map = new Map([
    [511, { dbid: 511, uid: UID_A, nickname: 'Alice', lastConnected: NOW }],
    [512, { dbid: 512, uid: UID_B, nickname: null, lastConnected: 0 }],
  ]);

  it('creates a player with UID and nickname from the server database', () => {
    const resolver = new DbidResolver(database.db, map);
    const id = resolver.resolve(511, NOW, 'Name aus dem Log');
    expect(database.sqlite.prepare(`SELECT uid, dbid FROM users WHERE id = ?`).get(id)).toEqual({
      uid: UID_A,
      dbid: 511,
    });
    expect(
      database.sqlite.prepare(`SELECT nick FROM nicknames WHERE user_id = ?`).pluck().get(id),
    ).toBe('Alice');
    expect(resolver.counters).toEqual({ resolved: 1, placeholders: 0 });
  });

  it('falls back to the name from the log when the server database has none', () => {
    const resolver = new DbidResolver(database.db, map);
    const id = resolver.resolve(512, NOW, 'Bob aus dem Log');
    expect(
      database.sqlite.prepare(`SELECT nick FROM nicknames WHERE user_id = ?`).pluck().get(id),
    ).toBe('Bob aus dem Log');
  });

  it('creates a placeholder for an unknown database id and reports it', () => {
    const resolver = new DbidResolver(database.db, map);
    const id = resolver.resolve(4711, NOW, 'Verschwunden');
    const uid = database.sqlite.prepare(`SELECT uid FROM users WHERE id = ?`).pluck().get(id);
    expect(uid).toBe('unknown-dbid-4711');
    expect(isPlaceholderUid(uid as string)).toBe(true);
    expect(resolver.counters).toEqual({ resolved: 0, placeholders: 1 });
    expect([...resolver.unresolved]).toEqual([4711]);
  });

  it('asks the database only once per player', () => {
    const resolver = new DbidResolver(database.db, map);
    const first = resolver.resolve(511, NOW);
    const second = resolver.resolve(511, NOW + 600);
    expect(second).toBe(first);
    expect(resolver.counters.resolved).toBe(1);
    expect(database.sqlite.prepare(`SELECT count(*) FROM users`).pluck().get()).toBe(1);
  });
});
