import type { AppDatabase } from '../db/client.js';
import type { AdminRole } from '../db/schema.js';
import { createSilentLogger } from '../logging/logger.js';
import { SESSION_COOKIE } from './auth/plugin.js';
import { createSession } from './auth/service.js';
import type { ApiContext } from './context.js';

/** API context for tests: silent logger, no watcher, fixed clock unless overridden. */
export function createTestContext(
  database: AppDatabase,
  overrides: Partial<ApiContext> = {},
): ApiContext {
  return {
    database,
    logger: createSilentLogger(),
    ts3: undefined,
    live: undefined,
    bot: undefined,
    moderation: undefined,
    now: () => 1_789_800_000,
    startedAt: 1_789_799_000,
    auth: { sessionTtlS: 12 * 3600, cookieSecure: false },
    ...overrides,
  };
}

let counter = 0;

/**
 * Creates an account with the given role and a session for it, without argon2 (fast), and
 * returns the `cookie` header value for `app.inject`.
 */
export function sessionCookie(context: ApiContext, role: AdminRole = 'viewer'): string {
  counter++;
  const username = `test-${role}-${String(counter)}`;
  const { id } = context.database.sqlite
    .prepare(
      `INSERT INTO admin_users (username, password_hash, role, created_at)
       VALUES (?, 'not-a-real-hash', ?, ?) RETURNING id`,
    )
    .get(username, role, context.now()) as { id: number };
  const token = createSession(context.database.db, id, context.now(), context.auth.sessionTtlS);
  return `${SESSION_COOKIE}=${token}`;
}
