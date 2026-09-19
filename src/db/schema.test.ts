import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, runMigrations, type AppDatabase } from './client.js';
import * as schema from './schema.js';

const options = { path: IN_MEMORY, cacheSizeMb: 16, mmapSizeMb: 0 };

const tables = (Object.values(schema) as unknown[]).filter((value): value is SQLiteTable =>
  is(value, SQLiteTable),
);

const journal = JSON.parse(
  readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: unknown[] };

const WITHOUT_ROWID = new Set([
  'user_daily_stats',
  'ip_seen',
  'settings',
  'admin_sessions',
  'user_tags',
]);

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

describe('migrations', () => {
  let database: AppDatabase;

  beforeEach(() => {
    database = openDatabase(options);
    runMigrations(database);
  });

  afterEach(() => {
    database.close();
  });

  it('are idempotent', () => {
    expect(() => {
      runMigrations(database);
    }).not.toThrow();
  });

  it('create every schema table as STRICT, with WITHOUT ROWID where intended', () => {
    const list = database.sqlite
      .prepare(`SELECT name, strict, wr FROM pragma_table_list WHERE schema = 'main'`)
      .all() as { name: string; strict: number; wr: number }[];
    const byName = new Map(list.map((t) => [t.name, t]));

    expect(tables.length).toBe(22);
    for (const table of tables) {
      const { name } = getTableConfig(table);
      expect(byName.get(name), name).toMatchObject({
        strict: 1,
        wr: WITHOUT_ROWID.has(name) ? 1 : 0,
      });
    }
  });

  it('match the Drizzle schema column by column', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      const actual = database.sqlite
        .prepare(`SELECT name, type, "notnull", pk FROM pragma_table_info(?)`)
        .all(config.name) as ColumnInfo[];
      const expected = config.columns.map((c) => ({
        name: c.name,
        type: c.getSQLType().toUpperCase(),
        notnull: c.notNull || c.primary ? 1 : 0,
      }));
      expect(
        actual.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull || (c.pk ? 1 : 0) })),
        config.name,
      ).toEqual(expect.arrayContaining(expected));
      expect(actual, config.name).toHaveLength(expected.length);
    }
  });

  it('create every index declared in the Drizzle schema', () => {
    const existing = new Set(
      (
        database.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    for (const table of tables) {
      for (const idx of getTableConfig(table).indexes) {
        expect(existing.has(idx.config.name), idx.config.name).toBe(true);
      }
    }
  });

  it('enforce column types (STRICT) and CHECK constraints', () => {
    const { sqlite } = database;
    expect(() =>
      sqlite
        .prepare(`INSERT INTO users (uid, first_seen, last_seen) VALUES ('u1', 'yesterday', 0)`)
        .run(),
    ).toThrow(/cannot store TEXT value in INTEGER column/);

    sqlite
      .prepare(`INSERT INTO users (id, uid, first_seen, last_seen) VALUES (1, 'u1', 0, 0)`)
      .run();
    expect(() =>
      sqlite
        .prepare(`INSERT INTO sessions (user_id, join_at, source) VALUES (1, 100, 'guess')`)
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      sqlite.prepare(`INSERT INTO sessions (user_id, join_at, leave_at) VALUES (1, 100, 50)`).run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO activity_segments (user_id, start_at, end_at, state) VALUES (1, 0, 10, 'busy')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('enforce foreign keys and cascade user deletion', () => {
    const { sqlite } = database;
    expect(() =>
      sqlite.prepare(`INSERT INTO sessions (user_id, join_at) VALUES (999, 0)`).run(),
    ).toThrow(/FOREIGN KEY constraint failed/);

    sqlite
      .prepare(`INSERT INTO users (id, uid, first_seen, last_seen) VALUES (1, 'u1', 0, 0)`)
      .run();
    sqlite.prepare(`INSERT INTO sessions (user_id, join_at) VALUES (1, 0)`).run();
    sqlite
      .prepare(`INSERT INTO nicknames (user_id, nick, first_seen, last_seen) VALUES (1, 'a', 0, 0)`)
      .run();
    sqlite.prepare(`DELETE FROM users WHERE id = 1`).run();
    expect(sqlite.prepare(`SELECT count(*) AS n FROM sessions`).get()).toEqual({ n: 0 });
    expect(sqlite.prepare(`SELECT count(*) AS n FROM nicknames`).get()).toEqual({ n: 0 });
  });

  it('keep the nickname full-text index in sync (trigram substring search)', () => {
    const { sqlite } = database;
    const search = (term: string) =>
      (
        sqlite
          .prepare(
            `SELECT n.nick FROM nicknames_fts f JOIN nicknames n ON n.id = f.rowid
             WHERE nicknames_fts MATCH ? ORDER BY n.nick`,
          )
          .all(`"${term}"`) as { nick: string }[]
      ).map((r) => r.nick);

    sqlite
      .prepare(`INSERT INTO users (id, uid, first_seen, last_seen) VALUES (1, 'u1', 0, 0)`)
      .run();
    const insert = sqlite.prepare(
      `INSERT INTO nicknames (id, user_id, nick, first_seen, last_seen) VALUES (?, 1, ?, 0, 0)`,
    );
    insert.run(1, 'HelloKitty');
    insert.run(2, 'xX_Sniper_Xx');

    expect(search('kitt')).toEqual(['HelloKitty']);
    expect(search('snip')).toEqual(['xX_Sniper_Xx']);

    sqlite.prepare(`UPDATE nicknames SET nick = 'GoodbyeKitty' WHERE id = 1`).run();
    expect(search('hello')).toEqual([]);
    expect(search('bye')).toEqual(['GoodbyeKitty']);

    sqlite.prepare(`DELETE FROM nicknames WHERE id = 2`).run();
    expect(search('snip')).toEqual([]);
  });
});

describe('openDatabase', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('creates the file and applies the PRAGMAs from AGENTS.md', () => {
    dir = mkdtempSync(join(tmpdir(), 'ts3-db-'));
    const database = openDatabase({
      path: join(dir, 'nested', 'test.sqlite'),
      cacheSizeMb: 32,
      mmapSizeMb: 64,
    });
    try {
      const pragma = (name: string): unknown => database.sqlite.pragma(name, { simple: true });
      expect(pragma('journal_mode')).toBe('wal');
      expect(pragma('synchronous')).toBe(1); // NORMAL
      expect(pragma('foreign_keys')).toBe(1);
      expect(pragma('temp_store')).toBe(2); // MEMORY
      expect(pragma('cache_size')).toBe(-32 * 1024);
      expect(pragma('mmap_size')).toBe(64 * 1024 * 1024);

      runMigrations(database);
      expect(
        database.sqlite.prepare(`SELECT count(*) AS n FROM __drizzle_migrations`).get(),
      ).toEqual({ n: journal.entries.length });
    } finally {
      database.close();
    }
  });
});
