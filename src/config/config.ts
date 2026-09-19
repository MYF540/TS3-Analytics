import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';

export const HMAC_SECRET_MIN_LENGTH = 32;

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// Until a task explicitly allows remote access, the web server stays on loopback (AGENTS.md rule 8).
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;

/** Treats `KEY=` (empty value) in .env like a missing key, so defaults and "required" apply. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const port = z.coerce.number().int().min(1).max(65535);

const envSchema = z.object({
  TS3_HOST: optional(z.string().default('127.0.0.1')),
  TS3_QUERY_PORT: optional(port.default(10022)),
  TS3_QUERY_USER: optional(z.string({ error: 'is required' })),
  TS3_QUERY_PASSWORD: optional(z.string({ error: 'is required' })),
  TS3_SERVER_ID: optional(z.coerce.number().int().min(1).default(1)),
  TS3_BOT_NICKNAME: optional(z.string().max(30).default('TS3 Analytics')),
  TS3_QUERY_RATE_LIMIT: optional(z.coerce.number().positive().max(100).default(5)),
  HMAC_SECRET: optional(
    z
      .string({ error: 'is required (generate one with: openssl rand -hex 32)' })
      .min(HMAC_SECRET_MIN_LENGTH, {
        error: `must be at least ${String(HMAC_SECRET_MIN_LENGTH)} characters long`,
      }),
  ),
  WEB_HOST: optional(
    z
      .enum(LOOPBACK_HOSTS, { error: `must be a loopback address (${LOOPBACK_HOSTS.join(', ')})` })
      .default('127.0.0.1'),
  ),
  WEB_PORT: optional(port.default(8080)),
  GEOIP_DB_PATH: optional(z.string().default('./data/GeoLite2-Country.mmdb')),
  SQLITE_PATH: optional(z.string().default('./data/ts3-analytics.sqlite')),
  IP_RETENTION_DAYS: optional(z.coerce.number().int().min(1).default(90)),
  LOG_LEVEL: optional(z.enum(LOG_LEVELS).default('info')),
  LOG_DIR: optional(z.string().default('./data/logs')),
  LOG_RETENTION_DAYS: optional(z.coerce.number().int().min(1).default(14)),
  // Unset = pretty console output only when attached to a terminal.
  LOG_PRETTY: optional(z.stringbool().optional()),
});

export interface Config {
  readonly ts3: {
    readonly host: string;
    readonly queryPort: number;
    readonly queryUser: string;
    readonly queryPassword: string;
    readonly serverId: number;
    readonly botNickname: string;
    /** Maximum number of query commands per second. */
    readonly queryRateLimit: number;
  };
  readonly security: {
    readonly hmacSecret: string;
  };
  readonly web: {
    readonly host: string;
    readonly port: number;
  };
  readonly paths: {
    readonly geoipDb: string;
    readonly sqlite: string;
  };
  readonly retention: {
    readonly ipDays: number;
  };
  readonly logging: {
    readonly level: LogLevel;
    readonly dir: string;
    /** Number of daily log files kept in addition to the current one. */
    readonly retentionDays: number;
    /** `undefined` = decide automatically (pretty output when stdout is a TTY). */
    readonly pretty: boolean | undefined;
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates raw environment variables. Error messages name the variable but never its value,
 * so secrets cannot leak into console output or logs.
 */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const e = result.data;
  return Object.freeze({
    ts3: Object.freeze({
      host: e.TS3_HOST,
      queryPort: e.TS3_QUERY_PORT,
      queryUser: e.TS3_QUERY_USER,
      queryPassword: e.TS3_QUERY_PASSWORD,
      serverId: e.TS3_SERVER_ID,
      botNickname: e.TS3_BOT_NICKNAME,
      queryRateLimit: e.TS3_QUERY_RATE_LIMIT,
    }),
    security: Object.freeze({ hmacSecret: e.HMAC_SECRET }),
    web: Object.freeze({ host: e.WEB_HOST, port: e.WEB_PORT }),
    paths: Object.freeze({ geoipDb: e.GEOIP_DB_PATH, sqlite: e.SQLITE_PATH }),
    retention: Object.freeze({ ipDays: e.IP_RETENTION_DAYS }),
    logging: Object.freeze({
      level: e.LOG_LEVEL,
      dir: e.LOG_DIR,
      retentionDays: e.LOG_RETENTION_DAYS,
      pretty: e.LOG_PRETTY,
    }),
  });
}

export interface LoadConfigOptions {
  /** Path to the .env file. A missing file is fine when all values come from the environment. */
  envFile?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/** Loads `.env` and validates it. Real environment variables take precedence over the file. */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const envFile = options.envFile ?? '.env';
  const fileValues = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  return parseConfig({ ...fileValues, ...(options.env ?? process.env) });
}
