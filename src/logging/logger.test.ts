import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  createStreamLogger,
  IP_PLACEHOLDER,
  LOG_FILE_BASENAME,
  REDACTED,
  scrubIps,
} from './logger.js';

// Documentation/test ranges only (RFC 5737, RFC 3849).
const IPV4 = '192.0.2.44';
const IPV6 = '2001:db8::abcd:1';

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createStreamLogger('trace', stream);
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

describe('scrubIps', () => {
  it.each([
    [`connect from ${IPV4}`, `connect from ${IP_PLACEHOLDER}`],
    [`connect from ${IPV6}`, `connect from ${IP_PLACEHOLDER}`],
    [`[${IPV6}]:10022`, `[${IP_PLACEHOLDER}]:10022`],
    [`${IPV4}:10022`, `${IP_PLACEHOLDER}:10022`],
    ['mapped ::ffff:192.0.2.1 here', `mapped ${IP_PLACEHOLDER} here`],
    ['loopback ::1 and 127.0.0.1', `loopback ${IP_PLACEHOLDER} and ${IP_PLACEHOLDER}`],
    [`ends with ${IPV6}.`, `ends with ${IP_PLACEHOLDER}.`],
    [`ends with ${IPV4}.`, `ends with ${IP_PLACEHOLDER}.`],
  ])('replaces addresses in %j', (input, expected) => {
    expect(scrubIps(input)).toBe(expected);
  });

  it.each([
    'server version 3.13.8',
    'at 12:30:45',
    'uid abc123+def/ghi=',
    'Error::Something',
    'not an ip 999.1.1.1',
    'build 1.2.3.4.5',
  ])('keeps %j unchanged', (input) => {
    expect(scrubIps(input)).toBe(input);
  });
});

describe('createStreamLogger', () => {
  it('redacts ip and password fields', () => {
    const { logger, lines, records } = captureLogger();
    logger.info({ ip: IPV4, password: 'hunter2', user: 'alice' }, 'login');
    expect(records()[0]).toMatchObject({ ip: REDACTED, password: REDACTED, user: 'alice' });
    expect(lines.join('')).not.toContain('hunter2');
    expect(lines.join('')).not.toContain(IPV4);
  });

  it('redacts nested sensitive fields', () => {
    const { logger, lines, records } = captureLogger();
    logger.info({
      client: { connection_client_ip: IPV6, nickname: 'bob' },
      config: { ts3: { queryPassword: 'q-secret' }, security: { hmacSecret: 'h-secret' } },
    });
    expect(records()[0]).toMatchObject({
      client: { connection_client_ip: REDACTED, nickname: 'bob' },
      config: { ts3: { queryPassword: REDACTED }, security: { hmacSecret: REDACTED } },
    });
    const output = lines.join('');
    for (const secret of [IPV6, 'q-secret', 'h-secret']) expect(output).not.toContain(secret);
  });

  it('scrubs IP addresses from messages, format arguments and string fields', () => {
    const { logger, lines, records } = captureLogger();
    logger.warn({ detail: `flood from ${IPV4}` }, 'client %s connected from %s', 'bob', IPV6);
    expect(records()[0]).toMatchObject({
      msg: `client bob connected from ${IP_PLACEHOLDER}`,
      detail: `flood from ${IP_PLACEHOLDER}`,
    });
    expect(lines.join('')).not.toMatch(/192\.0\.2\.44|2001:db8/);
  });

  it('scrubs IP addresses from logged errors', () => {
    const { logger, lines, records } = captureLogger();
    logger.error({ err: new Error(`connection to ${IPV4} refused`) }, 'query failed');
    const err = records()[0]?.err as { message: string; stack: string };
    expect(err.message).toBe(`connection to ${IP_PLACEHOLDER} refused`);
    expect(err.stack).toContain(IP_PLACEHOLDER);
    expect(lines.join('')).not.toContain(IPV4);
  });

  it('respects the log level', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = createStreamLogger('warn', stream);
    logger.info('hidden');
    logger.warn('shown');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('shown');
  });
});

describe('createLogger', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('writes redacted JSON lines to a dated file in the log directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ts3-logs-'));
    const logDir = join(dir, 'logs');
    const logger = createLogger({ level: 'info', dir: logDir, retentionDays: 3, pretty: false });

    logger.info({ ip: IPV4, password: 'hunter2' }, 'file test');
    await new Promise<void>((done) => {
      logger.flush(() => {
        done();
      });
    });
    // Transport workers write asynchronously; poll until the line shows up.
    const deadline = Date.now() + 5000;
    let content = '';
    let files: string[] = [];
    while (Date.now() < deadline) {
      files = readdirSync(logDir, { recursive: false }).map(String);
      content = files.map((f) => readFileSync(join(logDir, f), 'utf8')).join('');
      if (content.includes('file test')) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(files).toEqual([expect.stringMatching(/^ts3-analytics\.\d{4}-\d{2}-\d{2}\.1\.log$/)]);
    expect(files[0]?.startsWith(LOG_FILE_BASENAME)).toBe(true);
    expect(content).toContain('file test');
    expect(content).toContain(REDACTED);
    expect(content).not.toContain(IPV4);
    expect(content).not.toContain('hunter2');
  });
});

describe('webhook scrubbing', () => {
  it('removes Discord webhook URLs from free text', () => {
    expect(
      scrubIps(
        'POST https://discord.com/api/webhooks/123/abcDEF-xyz failed (canary: https://canary.discordapp.com/api/webhooks/1/x)',
      ),
    ).toBe('POST [WEBHOOK] failed (canary: [WEBHOOK])');
  });
});
