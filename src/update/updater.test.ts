import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { createTestDatabase } from '../db/testing.js';
import { isNewer, normalizeVersion, parseVersion } from '../domain/version.js';
import { createSilentLogger } from '../logging/logger.js';
import { UpdateError, Updater, type Launcher, type UpdaterOptions } from './updater.js';

const NOW = 1_789_800_000;

let database: AppDatabase;
let root: string;
const launch = vi.fn<Launcher>(() => Promise.resolve());

/** A GitHub answer for `releases/latest`. */
function release(changes: Record<string, unknown> = {}) {
  return {
    tag_name: 'v1.2.0',
    html_url: 'https://github.com/example/app/releases/tag/v1.2.0',
    published_at: '2026-10-01T10:00:00Z',
    body: 'Neu: alles besser.',
    draft: false,
    prerelease: false,
    ...changes,
  };
}

function updater(options: Partial<UpdaterOptions> & { answer?: unknown; status?: number } = {}) {
  const { answer = release(), status = 200, ...rest } = options;
  const request = vi.fn<(url: string) => Promise<Response>>(() =>
    Promise.resolve(Response.json(answer, { status })),
  );
  const instance = new Updater({
    db: database.db,
    logger: createSilentLogger(),
    currentVersion: '1.1.0',
    repo: 'example/app',
    root,
    serviceName: 'ts3-analytics',
    now: () => NOW,
    fetch: request as unknown as typeof fetch,
    launch,
    platform: 'win32',
    ...rest,
  });
  return { instance, request };
}

/** Makes `root` look like an installation that can update itself – no git checkout needed. */
function installable(): void {
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'setup.ps1'), '');
}

beforeEach(() => {
  database = createTestDatabase();
  root = mkdtempSync(join(tmpdir(), 'ts3-update-'));
  launch.mockClear();
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe('checking for releases', () => {
  it('asks GitHub for the latest release of the repository and remembers it', async () => {
    const { instance, request } = updater();
    expect(instance.latest()).toBeUndefined();
    expect(await instance.check()).toEqual({
      version: '1.2.0',
      url: 'https://github.com/example/app/releases/tag/v1.2.0',
      publishedAt: Date.parse('2026-10-01T10:00:00Z') / 1000,
      notes: 'Neu: alles besser.',
      checkedAt: NOW,
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/example/app/releases/latest',
    );
    expect(instance.latest()?.version).toBe('1.2.0');
    expect(instance.updateAvailable()).toBe(true);
  });

  it('sees no update in the version that is running or an older one', async () => {
    for (const tag of ['v1.1.0', 'v1.0.9']) {
      const { instance } = updater({ answer: release({ tag_name: tag }) });
      await instance.check();
      expect(instance.updateAvailable()).toBe(false);
    }
  });

  it('refuses drafts, pre-releases and anything that is not a release version', async () => {
    for (const answer of [
      release({ draft: true }),
      release({ prerelease: true }),
      release({ tag_name: 'v1.2.0-beta.1' }),
      release({ tag_name: 'main' }),
      { message: 'Not Found' },
    ]) {
      const { instance } = updater({ answer });
      await expect(instance.check()).rejects.toThrow(UpdateError);
      expect(instance.latest()).toBeUndefined();
    }
  });

  it('keeps what it knew when GitHub cannot be reached', async () => {
    await updater().instance.check();
    const { instance } = updater({ status: 503 });
    await expect(instance.check()).rejects.toMatchObject({ code: 'UPDATE_CHECK_FAILED' });
    expect(instance.latest()?.version).toBe('1.2.0');
  });

  it('cuts overlong release notes', async () => {
    const { instance } = updater({ answer: release({ body: 'x'.repeat(10_000) }) });
    expect((await instance.check()).notes).toHaveLength(4000);
  });
});

describe('installing', () => {
  it('hands the release of the last check to the setup script', async () => {
    installable();
    const { instance } = updater();
    await instance.check();
    expect(await instance.install()).toBe('v1.2.0');
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      'cmd.exe /d /c powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass ' +
        `-File "${join(root, 'scripts', 'setup.ps1')}" update -Version v1.2.0 ` +
        `-ServiceName ts3-analytics -Repo example/app -Yes > "${join(root, 'data', 'logs', 'update.log')}" 2>&1`,
      root,
    );
  });

  it('starts nothing without a newer release', async () => {
    installable();
    const none = updater().instance;
    await expect(none.install()).rejects.toMatchObject({ code: 'UPDATE_NOT_AVAILABLE' });
    const same = updater({ answer: release({ tag_name: 'v1.1.0' }) }).instance;
    await same.check();
    await expect(same.install()).rejects.toMatchObject({ code: 'UPDATE_NOT_AVAILABLE' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('says why an installation cannot update itself', async () => {
    expect(updater({ platform: 'linux' }).instance.installBlocker()).toBe('platform');
    expect(updater().instance.installBlocker()).toBe('no_script');
    const { instance } = updater();
    await instance.check();
    await expect(instance.install()).rejects.toMatchObject({ code: 'UPDATE_UNSUPPORTED' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('never puts an odd service name on a command line', async () => {
    installable();
    const { instance } = updater({ serviceName: 'x & calc' });
    await instance.check();
    await expect(instance.install()).rejects.toMatchObject({ code: 'UPDATE_UNSUPPORTED' });
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('status of the last run', () => {
  it('reads what the setup script wrote, with or without a byte order mark', () => {
    const { instance } = updater();
    expect(instance.lastRun()).toBeUndefined();
    mkdirSync(join(root, 'data'));
    const status = { state: 'failed', version: 'v1.2.0', at: NOW, message: 'Build schlug fehl' };
    writeFileSync(
      join(root, 'data', 'update-status.json'),
      `${String.fromCharCode(0xfeff)}${JSON.stringify(status)}`,
    );
    expect(instance.lastRun()).toEqual(status);
    writeFileSync(join(root, 'data', 'update-status.json'), '{ kaputt');
    expect(instance.lastRun()).toBeUndefined();
  });
});

describe('versions', () => {
  it('reads release versions only', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(normalizeVersion(' 1.2.3 ')).toBe('1.2.3');
    for (const text of ['1.2', 'v1.2.3-rc.1', '1.2.3.4', 'main', '']) {
      expect(parseVersion(text)).toBeUndefined();
    }
  });

  it('compares number by number', () => {
    expect(isNewer('1.10.0', '1.9.9')).toBe(true);
    expect(isNewer('v2.0.0', '1.99.99')).toBe(true);
    expect(isNewer('1.1.1', '1.1.0')).toBe(true);
    expect(isNewer('1.1.0', '1.1.0')).toBe(false);
    expect(isNewer('1.0.9', '1.1.0')).toBe(false);
    expect(isNewer('1.2.0', 'unbekannt')).toBe(false);
  });
});
