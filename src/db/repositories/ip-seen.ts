import { sql } from 'drizzle-orm';
import { ipSeen } from '../schema.js';
import type { DbExecutor, UnixSeconds } from './types.js';

export interface IpSighting {
  userId: number;
  /** HMAC of the full IP. Never pass the plain IP here. */
  ipHash: Buffer;
  /** HMAC of the /24 or /64 subnet. */
  subnetHash: Buffer;
  country: string | null;
  seenAt: UnixSeconds;
}

export function upsertIpSeen(db: DbExecutor, sighting: IpSighting): void {
  db.insert(ipSeen)
    .values({
      userId: sighting.userId,
      ipHash: sighting.ipHash,
      subnetHash: sighting.subnetHash,
      country: sighting.country,
      firstSeen: sighting.seenAt,
      lastSeen: sighting.seenAt,
      seenCount: 1,
    })
    .onConflictDoUpdate({
      target: [ipSeen.userId, ipSeen.ipHash],
      set: {
        country: sql`coalesce(excluded.country, ${ipSeen.country})`,
        firstSeen: sql`min(${ipSeen.firstSeen}, excluded.first_seen)`,
        lastSeen: sql`max(${ipSeen.lastSeen}, excluded.last_seen)`,
        seenCount: sql`${ipSeen.seenCount} + 1`,
      },
    })
    .run();
}
