import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from './config.js';

const VALID_SECRET = 'x'.repeat(32);

const minimalEnv = {
  TS3_QUERY_USER: 'analytics',
  TS3_QUERY_PASSWORD: 'query-pass',
  HMAC_SECRET: VALID_SECRET,
};

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected parseConfig to throw a ConfigError');
}

describe('parseConfig', () => {
  it('applies defaults for optional values', () => {
    const config = parseConfig(minimalEnv);
    expect(config).toEqual({
      ts3: {
        host: '127.0.0.1',
        queryPort: 10022,
        queryUser: 'analytics',
        queryPassword: 'query-pass',
        serverId: 1,
        botNickname: 'TS3 Analytics',
        queryRateLimit: 5,
      },
      security: { hmacSecret: VALID_SECRET },
      web: { host: '127.0.0.1', port: 8080 },
      paths: { geoipDb: './data/GeoLite2-Country.mmdb' },
      database: { path: './data/ts3-analytics.sqlite', cacheSizeMb: 64, mmapSizeMb: 256 },
      retention: { ipDays: 90 },
      watcher: { pollIntervalS: 60, flushIntervalS: 300 },
      logging: { level: 'info', dir: './data/logs', retentionDays: 14, pretty: undefined },
    });
  });

  it('parses explicit values and coerces numbers', () => {
    const config = parseConfig({
      ...minimalEnv,
      TS3_HOST: '10.0.0.5',
      TS3_QUERY_PORT: '10023',
      TS3_SERVER_ID: '2',
      TS3_BOT_NICKNAME: 'Stats',
      TS3_QUERY_RATE_LIMIT: '2.5',
      WEB_HOST: '::1',
      WEB_PORT: '3000',
      GEOIP_DB_PATH: 'geo.mmdb',
      SQLITE_PATH: 'db.sqlite',
      SQLITE_CACHE_SIZE_MB: '128',
      SQLITE_MMAP_SIZE_MB: '0',
      IP_RETENTION_DAYS: '30',
      LOG_LEVEL: 'debug',
      LOG_DIR: 'logs',
      LOG_RETENTION_DAYS: '7',
      LOG_PRETTY: 'false',
    });
    expect(config.ts3).toMatchObject({
      host: '10.0.0.5',
      queryPort: 10023,
      serverId: 2,
      botNickname: 'Stats',
      queryRateLimit: 2.5,
    });
    expect(config.web).toEqual({ host: '::1', port: 3000 });
    expect(config.paths).toEqual({ geoipDb: 'geo.mmdb' });
    expect(config.database).toEqual({ path: 'db.sqlite', cacheSizeMb: 128, mmapSizeMb: 0 });
    expect(config.retention.ipDays).toBe(30);
    expect(config.logging).toEqual({
      level: 'debug',
      dir: 'logs',
      retentionDays: 7,
      pretty: false,
    });
  });

  it('treats empty values as unset', () => {
    const config = parseConfig({ ...minimalEnv, TS3_QUERY_PORT: '', WEB_HOST: '' });
    expect(config.ts3.queryPort).toBe(10022);
    expect(config.web.host).toBe('127.0.0.1');
  });

  it('returns a frozen config', () => {
    const config = parseConfig(minimalEnv);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.ts3)).toBe(true);
  });

  it('rejects a missing HMAC secret with a clear message', () => {
    const error = configError({ ...minimalEnv, HMAC_SECRET: undefined });
    expect(error.problems).toEqual([expect.stringMatching(/^HMAC_SECRET: is required/)]);
  });

  it('rejects an empty HMAC secret', () => {
    const error = configError({ ...minimalEnv, HMAC_SECRET: '' });
    expect(error.problems).toEqual([expect.stringMatching(/^HMAC_SECRET: is required/)]);
  });

  it('rejects an HMAC secret shorter than 32 characters without echoing it', () => {
    const shortSecret = 'short-secret-value-31-chars-xxx';
    expect(shortSecret).toHaveLength(31);
    const error = configError({ ...minimalEnv, HMAC_SECRET: shortSecret });
    expect(error.problems).toEqual(['HMAC_SECRET: must be at least 32 characters long']);
    expect(error.message).not.toContain(shortSecret);
  });

  it('rejects missing query credentials', () => {
    const error = configError({ HMAC_SECRET: VALID_SECRET });
    expect(error.problems).toEqual([
      'TS3_QUERY_USER: is required',
      'TS3_QUERY_PASSWORD: is required',
    ]);
  });

  it('rejects a non-loopback web host', () => {
    const error = configError({ ...minimalEnv, WEB_HOST: '0.0.0.0' });
    expect(error.problems).toEqual([expect.stringMatching(/^WEB_HOST: must be a loopback/)]);
  });

  it.each([
    ['TS3_QUERY_PORT', 'abc'],
    ['TS3_QUERY_PORT', '70000'],
    ['WEB_PORT', '0'],
    ['TS3_SERVER_ID', '0'],
    ['TS3_QUERY_RATE_LIMIT', '-1'],
    ['IP_RETENTION_DAYS', '1.5'],
    ['LOG_LEVEL', 'verbose'],
    ['LOG_PRETTY', 'maybe'],
    ['POLL_INTERVAL_S', '5'],
    ['SEGMENT_FLUSH_INTERVAL_S', '10'],
  ])('rejects invalid %s=%s', (key, value) => {
    const error = configError({ ...minimalEnv, [key]: value });
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toMatch(new RegExp(`^${key}: `));
  });

  it('reports all problems at once', () => {
    const error = configError({ WEB_PORT: 'x' });
    expect(error.problems).toHaveLength(4);
    expect(error.message).toMatch(/^Invalid configuration:\n {2}- /);
  });
});

describe('loadConfig', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function writeEnvFile(content: string): string {
    dir = mkdtempSync(join(tmpdir(), 'ts3-config-'));
    const file = join(dir, '.env');
    writeFileSync(file, content);
    return file;
  }

  it('reads values from the .env file', () => {
    const envFile = writeEnvFile(
      [
        '# comment',
        'TS3_QUERY_USER=analytics',
        'TS3_QUERY_PASSWORD="p@ss word"',
        `HMAC_SECRET=${VALID_SECRET}`,
        'WEB_PORT=9000',
      ].join('\n'),
    );
    const config = loadConfig({ envFile, env: {} });
    expect(config.ts3.queryPassword).toBe('p@ss word');
    expect(config.web.port).toBe(9000);
  });

  it('lets environment variables override the file', () => {
    const envFile = writeEnvFile(
      `TS3_QUERY_USER=analytics\nTS3_QUERY_PASSWORD=x\nHMAC_SECRET=${VALID_SECRET}\nWEB_PORT=9000`,
    );
    const config = loadConfig({ envFile, env: { WEB_PORT: '9100' } });
    expect(config.web.port).toBe(9100);
  });

  it('works without a .env file when the environment is complete', () => {
    const config = loadConfig({ envFile: 'does-not-exist.env', env: minimalEnv });
    expect(config.ts3.queryUser).toBe('analytics');
  });

  it('fails when neither file nor environment provide required values', () => {
    expect(() => loadConfig({ envFile: 'does-not-exist.env', env: {} })).toThrow(ConfigError);
  });
});
