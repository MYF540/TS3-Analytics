import { and, eq } from 'drizzle-orm';
import type { DbExecutor } from '../db/repositories/index.js';
import { managedChannels, type ChannelOwner } from '../db/schema.js';

export interface ManagedChannel {
  channelId: number;
  scope: string;
  ownerUserId: number | null;
  createdAt: number;
}

/** Channels a module created or adopted (rule 13), optionally of one area or lobby. */
export function listManaged(
  db: DbExecutor,
  module: ChannelOwner,
  scope?: string,
): ManagedChannel[] {
  return db
    .select({
      channelId: managedChannels.channelId,
      scope: managedChannels.scope,
      ownerUserId: managedChannels.ownerUserId,
      createdAt: managedChannels.createdAt,
    })
    .from(managedChannels)
    .where(
      scope === undefined
        ? eq(managedChannels.module, module)
        : and(eq(managedChannels.module, module), eq(managedChannels.scope, scope)),
    )
    .orderBy(managedChannels.channelId)
    .all();
}

export function addManaged(
  db: DbExecutor,
  entry: {
    channelId: number;
    module: ChannelOwner;
    scope: string;
    ownerUserId?: number | undefined;
    createdAt: number;
  },
): void {
  db.insert(managedChannels)
    .values({ ...entry, ownerUserId: entry.ownerUserId ?? null })
    .onConflictDoUpdate({
      target: managedChannels.channelId,
      set: { module: entry.module, scope: entry.scope, ownerUserId: entry.ownerUserId ?? null },
    })
    .run();
}

export function removeManaged(db: DbExecutor, channelId: number): void {
  db.delete(managedChannels).where(eq(managedChannels.channelId, channelId)).run();
}
