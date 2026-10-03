import { z } from 'zod';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';
import type { AutomationModule } from '../db/schema.js';

/**
 * What every bot module shares (phase 10). Off by default, and once switched on it starts in
 * test mode: it only records what it would do until an admin turns the test mode off (rule 7).
 */
export const moduleBase = z.object({
  enabled: z.boolean().default(false),
  dryRun: z.boolean().default(true),
  /** Members of these server groups are left alone by the module. */
  exemptGroupIds: z.array(z.number().int().positive()).max(100).default([]),
});

export type ModuleBase = z.infer<typeof moduleBase>;

export const settingKey = (module: AutomationModule): string => `automation.${module}`;

/** Stored settings of a module; its defaults while nothing was saved yet. */
export function loadModuleSettings<T>(
  db: DbExecutor,
  module: AutomationModule,
  schema: z.ZodType<T>,
): T {
  return getSetting(db, settingKey(module), schema) ?? schema.parse({});
}

export function saveModuleSettings(
  db: DbExecutor,
  module: AutomationModule,
  settings: unknown,
  now: number,
): void {
  setSetting(db, settingKey(module), settings, now);
}

/** True when the client is in one of the module's exempt groups. */
export function isExempt(settings: ModuleBase, serverGroups: readonly number[]): boolean {
  return serverGroups.some((group) => settings.exemptGroupIds.includes(group));
}
