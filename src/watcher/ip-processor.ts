import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/client.js';
import { upsertIpSeen } from '../db/repositories/index.js';
import { users } from '../db/schema.js';
import { hashIp, normalizeIp } from '../domain/ip.js';
import type { CountryLookup } from '../geoip/country-lookup.js';
import type { Logger } from '../logging/logger.js';
import type { Ts3Connection } from '../ts3/connection.js';
import type { OnlineClient, TrackerListener } from './tracker.js';

export interface IpProcessorDeps {
  database: AppDatabase;
  connection: Ts3Connection;
  countries: CountryLookup;
  hmacSecret: string;
  logger: Logger;
}

/**
 * On every join: fetch the client IP (through the rate-limited queue), resolve the country, then
 * store only HMACs of IP and subnet. The plain address lives in a local variable of `process`
 * and is never stored, logged or passed on (AGENTS.md rule 1).
 */
export class IpProcessor implements TrackerListener {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: IpProcessorDeps) {}

  onJoined(client: OnlineClient, _source: unknown, at: number): void {
    const task = this.process(client, at).finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  /** Resolves when all started lookups are done (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async process(client: OnlineClient, at: number): Promise<void> {
    const { database, connection, countries, hmacSecret, logger } = this.deps;
    try {
      const raw = await connection.command((t) => t.clientIp(client.clid));
      const ip = raw === undefined ? undefined : normalizeIp(raw);
      if (!ip) {
        logger.debug({ clid: client.clid }, 'No usable IP address for client');
        return;
      }
      const country = countries.country(ip.address) ?? null;
      const { ipHash, subnetHash } = hashIp(ip, hmacSecret);
      database.sqlite.transaction(() => {
        upsertIpSeen(database.db, {
          userId: client.userId,
          ipHash,
          subnetHash,
          country,
          seenAt: at,
        });
        if (country) {
          database.db.update(users).set({ country }).where(eq(users.id, client.userId)).run();
        }
      })();
    } catch (error) {
      // The error never contains the address; messages are additionally scrubbed by the logger.
      logger.warn({ err: error, clid: client.clid }, 'IP processing failed');
    }
  }
}
