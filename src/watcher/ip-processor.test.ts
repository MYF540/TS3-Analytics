import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { createTestDatabase } from '../db/testing.js';
import { hashIp, normalizeIp } from '../domain/ip.js';
import { staticCountryLookup } from '../geoip/country-lookup.js';
import { createStreamLogger, type Logger } from '../logging/logger.js';
import { Ts3Connection } from '../ts3/connection.js';
import { FakeTs3Server } from '../ts3/fake-transport.js';
import { Watcher } from './watcher.js';

// Documentation ranges only (RFC 5737 / RFC 3849).
const IPV4_A = '192.0.2.44';
const IPV4_B = '192.0.2.200'; // same /24 as A
const IPV4_C = '198.51.100.7';
const IPV6_A = '2001:db8:1:2::abcd';
const IPV6_A_ALT = '2001:0db8:0001:0002:0:0:0:abcd'; // same address, other notation
const ALL_IPS = [
  IPV4_A,
  IPV4_B,
  IPV4_C,
  IPV6_A,
  '2001:db8:1:2:0:0:0:abcd',
  '2001:0db8:0001:0002:0000:0000:0000:abcd', // canonical form used for hashing
];
const SECRET = 'test-secret-with-at-least-32-characters!';
const T0 = 1_780_000_020;

let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let watcher: Watcher;
let logOutput: string[];
let logger: Logger;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function hashesOf(raw: string) {
  const ip = normalizeIp(raw);
  if (!ip) throw new Error('invalid');
  return hashIp(ip, SECRET);
}

const ipRows = () =>
  database.sqlite
    .prepare(
      `SELECT u.uid, i.ip_hash, i.subnet_hash, i.country, i.seen_count
       FROM ip_seen i JOIN users u ON u.id = i.user_id ORDER BY u.uid, i.first_seen`,
    )
    .all() as {
    uid: string;
    ip_hash: Buffer;
    subnet_hash: Buffer;
    country: string | null;
    seen_count: number;
  }[];

beforeEach(async () => {
  database = createTestDatabase();
  server = new FakeTs3Server();
  logOutput = [];
  logger = createStreamLogger(
    'trace',
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logOutput.push(chunk.toString());
        callback();
      },
    }),
  );
  connection = new Ts3Connection(server.createTransport, { commandsPerSecond: 1000 }, { logger });
  watcher = new Watcher({
    database,
    connection,
    logger,
    now: () => T0,
    autoPoll: false,
    ip: {
      countries: staticCountryLookup({ [IPV4_A]: 'DE', [IPV4_C]: 'AT' }),
      hmacSecret: SECRET,
    },
  });
  watcher.start();
  connection.start();
  await settle();
});

afterEach(async () => {
  watcher.stop();
  await connection.stop();
  database.close();
});

async function join(uid: string, ip: string): Promise<number> {
  const clid = server.join({ uid, nickname: uid }, ip);
  await settle();
  await watcher.ip?.idle();
  return clid;
}

describe('IP processing', () => {
  it('stores HMACs of IPv4 address and /24 plus the country', async () => {
    await join('alice', IPV4_A);
    const [row] = ipRows();
    const expected = hashesOf(IPV4_A);
    expect(row?.ip_hash.equals(expected.ipHash)).toBe(true);
    expect(row?.subnet_hash.equals(expected.subnetHash)).toBe(true);
    expect(row?.country).toBe('DE');
    expect(database.sqlite.prepare('SELECT country FROM users').get()).toEqual({ country: 'DE' });
  });

  it('gives the same IP the same hash and counts it', async () => {
    const clid = await join('alice', IPV4_A);
    server.leave(clid);
    await join('alice', IPV4_A);
    expect(ipRows()).toMatchObject([{ uid: 'alice', seen_count: 2 }]);
  });

  it('gives the same subnet the same subnet hash', async () => {
    await join('alice', IPV4_A);
    await join('bob', IPV4_B);
    await join('carol', IPV4_C);
    const [alice, bob, carol] = ipRows();
    expect(alice?.subnet_hash.equals(bob?.subnet_hash ?? Buffer.alloc(0))).toBe(true);
    expect(alice?.ip_hash.equals(bob?.ip_hash ?? Buffer.alloc(0))).toBe(false);
    expect(alice?.subnet_hash.equals(carol?.subnet_hash ?? Buffer.alloc(0))).toBe(false);
  });

  it('handles IPv6 and treats different notations as the same address', async () => {
    const clid = await join('dave', IPV6_A);
    server.leave(clid);
    await join('dave', IPV6_A_ALT);
    const rows = ipRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ip_hash.equals(hashesOf(IPV6_A).ipHash)).toBe(true);
    expect(rows[0]).toMatchObject({ seen_count: 2, country: null });
  });

  it('survives clients without a usable IP', async () => {
    await join('erin', 'not-an-ip');
    server.join({ uid: 'frank', nickname: 'frank' }); // no IP at all
    await settle();
    await watcher.ip?.idle();
    expect(ipRows()).toEqual([]);
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 2 });
  });

  it('never stores or logs a plain IP address', async () => {
    await join('alice', IPV4_A);
    await join('bob', IPV4_B);
    await join('carol', IPV4_C);
    await join('dave', IPV6_A);
    await watcher.sync();

    // Every table, including FTS shadow tables, every column, as text and as bytes.
    const tables = database.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .pluck()
      .all() as string[];
    expect(tables.length).toBeGreaterThan(10);
    const needles = ALL_IPS;
    for (const table of tables) {
      for (const row of database.sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<
        string,
        unknown
      >[]) {
        for (const value of Object.values(row)) {
          const text = Buffer.isBuffer(value) ? value.toString('latin1') : String(value);
          for (const ip of needles) expect(text, table).not.toContain(ip);
        }
      }
    }
    expect(ipRows()).toHaveLength(4);

    const logs = logOutput.join('');
    expect(logs.length).toBeGreaterThan(0);
    for (const ip of needles) expect(logs).not.toContain(ip);
  });
});
