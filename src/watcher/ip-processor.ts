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
  /** Joins collected during a client-list sync; their IPs are fetched with one command (T2.9). */
  private batch: { client: OnlineClient; at: number }[] | undefined;

  constructor(private readonly deps: IpProcessorDeps) {}

  onJoined(client: OnlineClient, _source: unknown, at: number): void {
    if (this.batch) {
      this.batch.push({ client, at });
      return;
    }
    this.track(this.processOne(client, at));
  }

  /** Starts collecting joins (e.g. the clients discovered by the initial sync). */
  beginBatch(): void {
    this.batch ??= [];
  }

  /** Processes collected joins: one `clientlist -ip` for several, `clientinfo` for a single one. */
  endBatch(): void {
    const batch = this.batch ?? [];
    this.batch = undefined;
    if (batch.length === 1 && batch[0]) this.track(this.processOne(batch[0].client, batch[0].at));
    else if (batch.length > 1) this.track(this.processMany(batch));
  }

  private track(task: Promise<void>): void {
    const tracked = task.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Resolves when all started lookups are done (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async processOne(client: OnlineClient, at: number): Promise<void> {
    try {
      const raw = await this.deps.connection.command((t) => t.clientIp(client.clid));
      this.store(client, raw, at);
    } catch (error) {
      // The error never contains the address; messages are additionally scrubbed by the logger.
      this.deps.logger.warn({ err: error, clid: client.clid }, 'IP processing failed');
    }
  }

  private async processMany(batch: readonly { client: OnlineClient; at: number }[]): Promise<void> {
    try {
      const ips = await this.deps.connection.command((t) => t.clientIps());
      for (const { client, at } of batch) this.store(client, ips.get(client.clid), at);
      ips.clear();
    } catch (error) {
      this.deps.logger.warn({ err: error, clients: batch.length }, 'IP processing failed');
    }
  }

  /** Hashes and stores one address. `raw` must not outlive this call. */
  private store(client: OnlineClient, raw: string | undefined, at: number): void {
    const { database, countries, hmacSecret, logger } = this.deps;
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
  }
}
