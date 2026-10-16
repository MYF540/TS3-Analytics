import { z } from 'zod';
import type { AppDatabase } from '../db/client.js';
import { playerLanguage, type Language } from '../domain/language.js';

/**
 * The English counterpart of a module's player texts (T12.1): the given fields plus a switch
 * that is off by default, so settings saved before keep behaving exactly as they did.
 */
export function englishSection<S extends z.ZodRawShape>(shape: S) {
  const schema = z.object({ enabled: z.boolean().default(false), ...shape });
  // Generic shapes defeat zod's typing of the default; it is the schema's own output.
  return schema.default(schema.parse({}) as never);
}

/** The player's language, from the country stored for them (reported on connect, or GeoIP). */
export function clientLanguage(
  database: Pick<AppDatabase, 'sqlite'>,
  userId: number,
  englishEnabled: boolean,
): Language {
  if (!englishEnabled) return 'de';
  const row = database.sqlite.prepare('SELECT country FROM users WHERE id = ?').get(userId) as
    { country: string | null } | undefined;
  return playerLanguage(row?.country, true);
}
