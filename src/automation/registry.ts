import type { z } from 'zod';
import type { DbExecutor } from '../db/repositories/index.js';
import type { AutomationModule } from '../db/schema.js';
import { channelsSettingsSchema } from './modules/channels.js';
import { nicknameSettingsSchema } from './modules/nickname.js';
import { privateSettingsSchema } from './modules/private.js';
import { rulesSettingsSchema } from './modules/rules.js';
import { staffSettingsSchema } from './modules/staff.js';
import { supportSettingsSchema } from './modules/support.js';
import { loadModuleSettings, type ModuleBase } from './settings.js';

/** A bot module that exists in this version, with the schema of its settings. */
export interface ModuleDescriptor {
  id: AutomationModule;
  schema: z.ZodType<ModuleBase>;
}

/** Filled in as the modules of phase 10 arrive; the order is the order on the page. */
export const MODULES: readonly ModuleDescriptor[] = [
  { id: 'nickname', schema: nicknameSettingsSchema },
  { id: 'support', schema: supportSettingsSchema },
  { id: 'staff', schema: staffSettingsSchema },
  { id: 'channels', schema: channelsSettingsSchema },
  { id: 'private', schema: privateSettingsSchema },
  { id: 'rules', schema: rulesSettingsSchema },
];

export interface ModuleState {
  id: AutomationModule;
  enabled: boolean;
  dryRun: boolean;
}

/** Whether each module is switched on and whether it is still in test mode. */
export function moduleStates(
  db: DbExecutor,
  modules: readonly ModuleDescriptor[] = MODULES,
): ModuleState[] {
  return modules.map(({ id, schema }) => {
    const { enabled, dryRun } = loadModuleSettings(db, id, schema);
    return { id, enabled, dryRun };
  });
}
