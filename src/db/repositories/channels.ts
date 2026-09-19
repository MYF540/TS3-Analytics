import { sql } from 'drizzle-orm';
import { channels } from '../schema.js';
import type { DbExecutor, UnixSeconds } from './types.js';

export interface ChannelSighting {
  id: number;
  name: string;
  seenAt: UnixSeconds;
}

/** Inserts or renames channels (by TS3 cid). Pass the whole channel list in one call. */
export function upsertChannels(db: DbExecutor, sightings: readonly ChannelSighting[]): void {
  if (sightings.length === 0) return;
  db.insert(channels)
    .values(sightings.map((c) => ({ id: c.id, name: c.name, lastSeen: c.seenAt })))
    .onConflictDoUpdate({
      target: channels.id,
      set: {
        name: sql`excluded.name`,
        lastSeen: sql`max(${channels.lastSeen}, excluded.last_seen)`,
      },
    })
    .run();
}

export interface Channel {
  id: number;
  name: string;
  lastSeen: UnixSeconds;
}

/** All known channels (including ones deleted on the server), ordered by name. */
export function listChannels(db: DbExecutor): Channel[] {
  return db
    .select({ id: channels.id, name: channels.name, lastSeen: channels.lastSeen })
    .from(channels)
    .orderBy(sql`${channels.name} COLLATE NOCASE`, channels.id)
    .all();
}
