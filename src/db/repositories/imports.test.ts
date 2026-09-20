import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLegacy, saveLegacy } from '../../import/settings.js';
import type { AppDatabase } from '../client.js';
import { createTestDatabase } from '../testing.js';
import {
  failImportRun,
  findImportRun,
  finishImportRun,
  isImportDone,
  listImportRuns,
  startImportRun,
  updateImportRun,
} from './imports.js';

const NOW = 1_789_800_000;

let database: AppDatabase;

beforeEach(() => {
  database = createTestDatabase();
});

afterEach(() => {
  database.close();
});

const file = (size: number) => ({ source: 'logs' as const, file: 'ts3server_2019.log', size });

describe('import runs', () => {
  it('starts at offset 0 and records progress', () => {
    const run = startImportRun(database.sqlite, file(1000), NOW);
    expect(run).toMatchObject({ offset: 0, status: 'running', linesRead: 0 });
    updateImportRun(
      database.sqlite,
      run.id,
      { offset: 400, linesRead: 12, linesSkipped: 3, sessionsWritten: 2, problems: 1 },
      NOW + 5,
    );
    finishImportRun(database.sqlite, run.id, NOW + 6);
    expect(findImportRun(database.sqlite, 'logs', run.file)).toMatchObject({
      offset: 400,
      linesRead: 12,
      linesSkipped: 3,
      sessionsWritten: 2,
      problems: 1,
      status: 'done',
    });
  });

  it('continues a file that grew, keeping the offset', () => {
    const first = startImportRun(database.sqlite, file(1000), NOW);
    updateImportRun(
      database.sqlite,
      first.id,
      { offset: 1000, linesRead: 40, linesSkipped: 0, sessionsWritten: 8, problems: 0 },
      NOW,
    );
    finishImportRun(database.sqlite, first.id, NOW);
    const second = startImportRun(database.sqlite, file(1500), NOW + 60);
    expect(second).toMatchObject({ id: first.id, offset: 1000, size: 1500, status: 'running' });
  });

  it('starts over when the file shrank', () => {
    const first = startImportRun(database.sqlite, file(1000), NOW);
    updateImportRun(
      database.sqlite,
      first.id,
      { offset: 900, linesRead: 40, linesSkipped: 0, sessionsWritten: 8, problems: 0 },
      NOW,
    );
    const second = startImportRun(database.sqlite, file(500), NOW + 60);
    expect(second).toMatchObject({ id: first.id, offset: 0, size: 500, linesRead: 0 });
  });

  it('starts over after a failed run', () => {
    const first = startImportRun(database.sqlite, file(1000), NOW);
    updateImportRun(
      database.sqlite,
      first.id,
      { offset: 700, linesRead: 30, linesSkipped: 0, sessionsWritten: 5, problems: 0 },
      NOW,
    );
    failImportRun(database.sqlite, first.id, 'Datei nicht lesbar', NOW + 1);
    expect(findImportRun(database.sqlite, 'logs', first.file)).toMatchObject({
      status: 'failed',
      error: 'Datei nicht lesbar',
    });
    expect(startImportRun(database.sqlite, file(1000), NOW + 2)).toMatchObject({
      offset: 0,
      status: 'running',
      error: null,
    });
  });

  it('keeps the two sources apart', () => {
    startImportRun(database.sqlite, file(1000), NOW);
    startImportRun(database.sqlite, { source: 'ranking', file: 'sinusbot.sqlite', size: 20 }, NOW);
    expect(listImportRuns(database.sqlite).length).toBe(2);
    expect(listImportRuns(database.sqlite, 'ranking').map((r) => r.file)).toEqual([
      'sinusbot.sqlite',
    ]);
  });

  it('knows when a file needs no second run', () => {
    const run = startImportRun(database.sqlite, file(1000), NOW);
    updateImportRun(
      database.sqlite,
      run.id,
      { offset: 1000, linesRead: 1, linesSkipped: 0, sessionsWritten: 0, problems: 0 },
      NOW,
    );
    finishImportRun(database.sqlite, run.id, NOW);
    const done = findImportRun(database.sqlite, 'logs', run.file);
    expect(isImportDone(done, 1000)).toBe(true);
    expect(isImportDone(done, 1200)).toBe(false);
    expect(isImportDone(undefined, 1000)).toBe(false);
  });

  it('refuses an offset beyond the file size', () => {
    const run = startImportRun(database.sqlite, file(1000), NOW);
    expect(() => {
      updateImportRun(
        database.sqlite,
        run.id,
        { offset: 1001, linesRead: 0, linesSkipped: 0, sessionsWritten: 0, problems: 0 },
        NOW,
      );
    }).toThrow();
  });
});

describe('legacy settings', () => {
  it('starts empty and stores the cutoff', () => {
    expect(loadLegacy(database.db)).toEqual({ cutoff: null, importedAt: null });
    saveLegacy(database.db, { cutoff: NOW, importedAt: NOW + 1 }, NOW);
    expect(loadLegacy(database.db)).toEqual({ cutoff: NOW, importedAt: NOW + 1 });
  });
});

describe('users', () => {
  it('has no legacy time by default', () => {
    const id = database.sqlite
      .prepare(`INSERT INTO users (uid, first_seen, last_seen) VALUES ('uid-a', ?, ?) RETURNING id`)
      .pluck()
      .get(NOW, NOW) as number;
    expect(
      database.sqlite
        .prepare(`SELECT legacy_seconds AS s, legacy_rank AS r FROM users WHERE id = ?`)
        .get(id),
    ).toEqual({ s: 0, r: null });
  });
});
