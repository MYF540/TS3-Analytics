import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { settings } from '../schema.js';
import type { DbExecutor, UnixSeconds } from './types.js';

export class InvalidSettingError extends Error {
  constructor(readonly key: string) {
    super(`Stored setting "${key}" does not match its expected schema`);
    this.name = 'InvalidSettingError';
  }
}

/** Reads a JSON setting and validates it. Returns `undefined` if the key is not set. */
export function getSetting<T>(db: DbExecutor, key: string, schema: z.ZodType<T>): T | undefined {
  const row = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  if (!row) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    throw new InvalidSettingError(key);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new InvalidSettingError(key);
  return result.data;
}

export function setSetting(db: DbExecutor, key: string, value: unknown, now: UnixSeconds): void {
  const json = JSON.stringify(value);
  db.insert(settings)
    .values({ key, value: json, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: json, updatedAt: now } })
    .run();
}
