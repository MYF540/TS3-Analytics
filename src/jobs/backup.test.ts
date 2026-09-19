import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { upsertUser } from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { listBackups, runBackup } from './backup.js';

let database: AppDatabase;
let dir: string;
const NOW = Date.UTC(2026, 8, 20, 1, 2, 3) / 1000;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), 'ts3a-backup-'));
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runBackup', () => {
  it('writes a checked copy with a timestamped name', async () => {
    upsertUser(database.db, { uid: 'a=', seenAt: 1 });
    const result = await runBackup(database, { dir, keep: 14, now: NOW });
    expect(result.file).toBe(join(dir, 'ts3-analytics-20260920-010203.sqlite'));
    expect(result.bytes).toBeGreaterThan(0);
    const copy = new Database(result.file, { readonly: true });
    expect(copy.prepare('SELECT uid FROM users').pluck().all()).toEqual(['a=']);
    copy.close();
    expect(readdirSync(dir).some((name) => name.endsWith('.partial'))).toBe(false);
  });

  it('keeps only the newest backups and ignores other files', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    for (let i = 0; i < 4; i++) {
      await runBackup(database, { dir, keep: 2, now: NOW + i * 86_400 });
    }
    expect(listBackups(dir)).toEqual([
      'ts3-analytics-20260923-010203.sqlite',
      'ts3-analytics-20260922-010203.sqlite',
    ]);
    expect(readdirSync(dir)).toContain('notes.txt');
  });
});
