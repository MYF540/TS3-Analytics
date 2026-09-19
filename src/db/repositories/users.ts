import { desc, eq, sql } from 'drizzle-orm';
import { nicknames, users } from '../schema.js';
import type { DbExecutor, UnixSeconds } from './types.js';

export type User = typeof users.$inferSelect;
export type Nickname = typeof nicknames.$inferSelect;

export interface UserSighting {
  uid: string;
  seenAt: UnixSeconds;
  dbid?: number | undefined;
  platform?: string | undefined;
  version?: string | undefined;
  country?: string | undefined;
}

/**
 * Inserts the user or updates an existing one (matched by UID, never by nickname).
 * `first_seen`/`last_seen` only ever widen; unknown optional fields keep their stored value.
 * Returns the internal user id.
 */
export function upsertUser(db: DbExecutor, sighting: UserSighting): number {
  const row = db
    .insert(users)
    .values({
      uid: sighting.uid,
      dbid: sighting.dbid ?? null,
      firstSeen: sighting.seenAt,
      lastSeen: sighting.seenAt,
      platform: sighting.platform ?? null,
      version: sighting.version ?? null,
      country: sighting.country ?? null,
    })
    .onConflictDoUpdate({
      target: users.uid,
      set: {
        dbid: sql`coalesce(excluded.dbid, ${users.dbid})`,
        firstSeen: sql`min(${users.firstSeen}, excluded.first_seen)`,
        lastSeen: sql`max(${users.lastSeen}, excluded.last_seen)`,
        platform: sql`coalesce(excluded.platform, ${users.platform})`,
        version: sql`coalesce(excluded.version, ${users.version})`,
        country: sql`coalesce(excluded.country, ${users.country})`,
      },
    })
    .returning({ id: users.id })
    .get();
  return row.id;
}

export function getUserByUid(db: DbExecutor, uid: string): User | undefined {
  return db.select().from(users).where(eq(users.uid, uid)).get();
}

export function getUserById(db: DbExecutor, id: number): User | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

/** Records that `userId` used `nick` at `seenAt`. Re-using an old nick updates its `last_seen`. */
export function recordNickname(
  db: DbExecutor,
  userId: number,
  nick: string,
  seenAt: UnixSeconds,
): void {
  db.insert(nicknames)
    .values({ userId, nick, firstSeen: seenAt, lastSeen: seenAt })
    .onConflictDoUpdate({
      target: [nicknames.userId, nicknames.nick],
      set: {
        firstSeen: sql`min(${nicknames.firstSeen}, excluded.first_seen)`,
        lastSeen: sql`max(${nicknames.lastSeen}, excluded.last_seen)`,
      },
    })
    .run();
}

/** Nickname history, most recently used first. */
export function getNicknames(db: DbExecutor, userId: number): Nickname[] {
  return db
    .select()
    .from(nicknames)
    .where(eq(nicknames.userId, userId))
    .orderBy(desc(nicknames.lastSeen), desc(nicknames.id))
    .all();
}

export function getCurrentNickname(db: DbExecutor, userId: number): string | undefined {
  return getNicknames(db, userId)[0]?.nick;
}
