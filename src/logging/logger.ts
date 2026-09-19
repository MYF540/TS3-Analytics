import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import {
  pino,
  stdSerializers,
  stdTimeFunctions,
  transport as pinoTransport,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';
import type { Config } from '../config/config.js';

export type { Logger } from 'pino';

export const REDACTED = '[REDACTED]';
export const IP_PLACEHOLDER = '[IP]';

/**
 * Field names whose values never reach a log line, at any of the first three nesting levels.
 * Covers credentials and IP addresses (AGENTS.md rules 1 and 2).
 */
export const REDACTED_KEYS = [
  'password',
  'passwd',
  'queryPassword',
  'secret',
  'hmacSecret',
  'token',
  'apiKey',
  'authorization',
  'cookie',
  'ip',
  'ipAddress',
  'clientIp',
  'client_ip',
  'connection_client_ip',
  'remoteAddress',
  'webhookUrl',
] as const;

const REDACT_PATHS = REDACTED_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

// Candidates are validated with node:net isIP, so the patterns may over-match.
const IPV6_CANDIDATE =
  /(?<![\w:.])[0-9a-f]*:[0-9a-f:]*(?:\d{1,3}(?:\.\d{1,3}){3})?(?![\w:]|\.\d)/gi;
const IPV4_CANDIDATE = /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?!\w|\.\d)/g;

export const WEBHOOK_PLACEHOLDER = '[WEBHOOK]';
/** Discord webhook URLs contain their token (AGENTS.md rule 2). */
const WEBHOOK_URL = /https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/[\w/-]+/gi;

/**
 * Replaces every IPv4/IPv6 address in free text, e.g. inside error messages from the query, and
 * Discord webhook URLs (they contain a secret token).
 */
export function scrubIps(text: string): string {
  return text
    .replace(WEBHOOK_URL, WEBHOOK_PLACEHOLDER)
    .replace(IPV6_CANDIDATE, (match) => (isIP(match) === 6 ? IP_PLACEHOLDER : match))
    .replace(IPV4_CANDIDATE, (match) => (isIP(match) === 4 ? IP_PLACEHOLDER : match));
}

const MAX_SCRUB_DEPTH = 5;

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubIps(value);
  if (depth >= MAX_SCRUB_DEPTH || value === null || typeof value !== 'object') return value;
  // Errors keep their prototype so pino's err serializer (which scrubs them) still applies.
  if (value instanceof Error) return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = scrubValue(item, depth + 1);
  return result;
}

/** Shared pino options: redaction of sensitive keys and IP scrubbing of all string values. */
export function loggerOptions(level: Config['logging']['level']): LoggerOptions {
  return {
    level,
    timestamp: stdTimeFunctions.isoTime,
    base: null,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: {
      err: (err: Error) => scrubValue(stdSerializers.err(err), 0),
    },
    formatters: {
      log: (object) => scrubValue(object, 0) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((arg) => (typeof arg === 'string' ? scrubIps(arg) : arg));
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
  };
}

/** Logger writing to an arbitrary stream; used by tests and tools. */
export function createStreamLogger(
  level: Config['logging']['level'],
  stream: DestinationStream,
): Logger {
  return pino(loggerOptions(level), stream);
}

export const LOG_FILE_BASENAME = 'ts3-analytics';

/**
 * Application logger: console (pretty on a TTY) plus a daily rotated file in `logging.dir`
 * (`ts3-analytics.<yyyy-MM-dd>.<n>.log`). Files older than `retentionDays` are removed.
 */
export function createLogger(logging: Config['logging']): Logger {
  const pretty = logging.pretty ?? process.stdout.isTTY;
  const transport = pinoTransport({
    targets: [
      pretty
        ? {
            target: 'pino-pretty',
            level: logging.level,
            options: {
              destination: 1,
              translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
              ignore: 'pid,hostname',
            },
          }
        : { target: 'pino/file', level: logging.level, options: { destination: 1 } },
      {
        target: 'pino-roll',
        level: logging.level,
        options: {
          file: join(resolve(logging.dir), LOG_FILE_BASENAME),
          frequency: 'daily',
          dateFormat: 'yyyy-MM-dd',
          mkdir: true,
          limit: { count: logging.retentionDays, removeOtherLogFiles: true },
        },
      },
    ],
  });
  return pino(loggerOptions(logging.level), transport);
}

/** Logger that discards everything; for tests. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
