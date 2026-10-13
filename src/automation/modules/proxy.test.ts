import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { replaceRanks } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { normalizeIp } from '../../domain/ip.js';
import { createSilentLogger } from '../../logging/logger.js';
import { Ts3Connection } from '../../ts3/connection.js';
import { FakeTs3Server } from '../../ts3/fake-transport.js';
import { IpProcessor } from '../../watcher/ip-processor.js';
import { SessionTracker } from '../../watcher/tracker.js';
import { AutomationHost } from '../host.js';
import { listAutomationLog } from '../log.js';
import {
  createProxycheckLookup,
  readProxycheckAnswer,
  type ProxyLookupResult,
} from '../proxycheck.js';
import { saveModuleSettings } from '../settings.js';
import { clearProxyVerdict, getProxyCheck, isPublicAddress, ProxyModule } from './proxy.js';

const VPN = '203.0.113.7';
const HOME = '198.51.100.20';
const SECRET = 'x'.repeat(32);

let now: number;
let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let tracker: SessionTracker;
let host: AutomationHost;
let ips: IpProcessor;
let module: ProxyModule;
let answers: Map<string, ProxyLookupResult>;
const lookup = vi.fn((address: string) =>
  Promise.resolve(answers.get(address) ?? ({ verdict: 'clean' } as const)),
);
const notify = vi.fn();
const warn = vi.fn();

function configure(settings: Record<string, unknown> = {}): void {
  saveModuleSettings(database.db, 'proxy', { enabled: true, dryRun: false, ...settings }, now);
}

async function join(nickname: string, ip: string, extra: Record<string, unknown> = {}) {
  const clid = server.join({ uid: `uid-${nickname}`, nickname, ...extra }, ip);
  await ips.idle();
  await module.idle();
  await host.idle();
  return clid;
}

const userOf = (clid: number) => host.get(clid)?.userId ?? 0;
const listed = () =>
  (database.sqlite.prepare('SELECT count(*) AS n FROM proxy_ips').get() as { n: number }).n;
const log = () =>
  listAutomationLog(database.sqlite, { limit: 30, offset: 0 })
    .items.map((row) => [row.action, row.result, row.detail])
    .reverse();

beforeEach(async () => {
  now = 1_789_800_000;
  lookup.mockClear();
  notify.mockReset();
  warn.mockReset();
  answers = new Map([[VPN, { verdict: 'proxy', kind: 'VPN' }]]);
  database = createTestDatabase();
  server = new FakeTs3Server();
  const logger = createSilentLogger();
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
    { logger },
  );
  tracker = new SessionTracker(database, logger);
  host = new AutomationHost(logger);
  module = new ProxyModule({
    database,
    commands: connection,
    logger: { ...logger, warn } as never,
    now: () => now,
    lookup,
    client: (clid) => host.get(clid),
    online: () => host.online,
    notifier: { notify },
  });
  ips = new IpProcessor({
    database,
    connection,
    countries: { country: () => undefined },
    hmacSecret: SECRET,
    logger,
    onAddress: (client, ip, ipHash) => {
      module.inspect(client, ip, ipHash);
    },
  });
  tracker.addListener(ips);
  tracker.addListener(host);
  host.register(module);
  connection.on('clientConnect', (client) => tracker.join(client, now));
  connection.on('clientDisconnect', (event) => {
    tracker.leave(event.clid, now);
  });
  connection.start();
  await vi.waitFor(() => {
    expect(connection.isConnected).toBe(true);
  });
});

afterEach(async () => {
  await connection.stop();
  database.close();
});

describe('checking a new player', () => {
  it('asks the service, lists the address and acts on a hit', async () => {
    configure({ action: 'kick' });
    const clid = await join('Evader', VPN);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(VPN);
    expect(server.clients.has(clid)).toBe(false);
    expect(listed()).toBe(1);
    expect(log()).toEqual([
      ['proxy.detected', 'done', 'VPN (Online-Dienst)'],
      ['kick', 'done', 'VPN (Online-Dienst)'],
    ]);
    expect(notify).toHaveBeenCalledWith('proxy.detected', expect.stringContaining('Evader'));
  });

  it('remembers a clean player and never asks about them again', async () => {
    configure({ action: 'kick' });
    const clid = await join('Alice', HOME);
    expect(getProxyCheck(database.db, userOf(clid))).toEqual({ verdict: 'clean', checkedAt: now });
    server.leave(clid);
    // Even from an address the service would flag.
    const again = await join('Alice', VPN);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(server.clients.has(again)).toBe(true);
  });

  it('recognises a listed address without asking the service', async () => {
    configure({ action: 'kick' });
    await join('Evader', VPN);
    lookup.mockClear();
    const second = await join('Zweitaccount', VPN);
    expect(lookup).not.toHaveBeenCalled();
    expect(server.clients.has(second)).toBe(false);
    expect(log().at(-1)).toEqual(['kick', 'done', 'VPN (lokale Liste)']);
  });

  it('checks a flagged player again on the next join', async () => {
    configure();
    const clid = await join('Evader', VPN);
    server.leave(clid);
    const again = await join('Evader', HOME);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(getProxyCheck(database.db, userOf(again))?.verdict).toBe('clean');
  });

  it('does nothing while the service is down and tries again next time', async () => {
    configure({ action: 'kick' });
    answers.set(VPN, { verdict: 'unavailable', reason: 'timeout' });
    const clid = await join('Evader', VPN);
    expect(server.clients.has(clid)).toBe(true);
    expect(getProxyCheck(database.db, userOf(clid))).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    server.leave(clid);
    answers.set(VPN, { verdict: 'proxy', kind: 'VPN' });
    const again = await join('Evader', VPN);
    expect(server.clients.has(again)).toBe(false);
    // One warning per ten minutes, not one per join.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skips exempt groups, exempt players and private addresses', async () => {
    configure({ action: 'kick', exemptGroupIds: [6] });
    await join('Admin', VPN, { serverGroups: [6] });
    await join('Lokal', '192.168.1.20');
    const special = await join('Sonderfall', HOME);
    server.leave(special);
    database.sqlite.prepare('DELETE FROM proxy_checks').run();
    configure({ action: 'kick', exemptUserIds: [3] });
    lookup.mockClear();
    const again = await join('Sonderfall', VPN);
    expect(userOf(again)).toBe(3);
    expect(lookup).not.toHaveBeenCalled();
    expect(server.moderation).toEqual([]);
  });

  it('asks nobody while the module is off', async () => {
    configure({ enabled: false });
    await join('Evader', VPN);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('what happens on a hit', () => {
  it('sets the configured group and tells the player', async () => {
    configure({ action: 'group', groupId: 50 });
    const clid = await join('Evader', VPN, { dbid: 101 });
    expect(server.groupCommands).toEqual([{ command: 'add', dbid: 101, groupId: 50 }]);
    expect(server.moderation).toEqual([
      {
        command: 'message',
        clid,
        text: 'VPN oder Proxy erkannt. Bitte melde dich bei einem Admin.',
      },
    ]);
  });

  it('never sets a group of the rank ladder', async () => {
    replaceRanks(database.sqlite, [{ name: 'Neuling', requiredS: 3600, serverGroupId: 50 }], now);
    configure({ action: 'group', groupId: 50 });
    await join('Evader', VPN);
    expect(server.groupCommands).toEqual([]);
  });

  it('bans for a limited time', async () => {
    configure({ action: 'ban', banDurationS: 7200 });
    await join('Evader', VPN);
    expect(server.bans).toMatchObject([{ uid: 'uid-Evader', durationS: 7200 }]);
  });

  it('tells the team groups', async () => {
    configure({ notifyGroupIds: [6] });
    const admin = await join('Admin', HOME, { serverGroups: [6] });
    await join('Evader', VPN);
    expect(server.moderation).toEqual([
      { command: 'message', clid: admin, text: 'VPN/Proxy erkannt bei Evader.' },
    ]);
  });

  it('records the hit but sends nothing in test mode', async () => {
    configure({ dryRun: true, action: 'kick' });
    const clid = await join('Evader', VPN);
    expect(server.clients.has(clid)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    expect(log()).toEqual([
      ['proxy.detected', 'dry', 'VPN (Online-Dienst)'],
      ['kick', 'dry', 'VPN (Online-Dienst)'],
    ]);
  });

  it('undoes a false alarm: the player is clean and the address leaves the list', async () => {
    configure();
    const clid = await join('Evader', VPN);
    expect(clearProxyVerdict(database.db, userOf(clid), now)).toBe(1);
    expect(listed()).toBe(0);
    expect(getProxyCheck(database.db, userOf(clid))?.verdict).toBe('clean');
  });
});

describe('rule 1', () => {
  it('keeps the plain address out of database, log and automation log', async () => {
    configure({ action: 'kick', notifyGroupIds: [6] });
    await join('Admin', HOME, { serverGroups: [6] });
    await join('Evader', VPN);
    const tables = database.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%_fts%'")
      .all() as { name: string }[];
    const dump = tables
      .map(({ name }) => JSON.stringify(database.sqlite.prepare(`SELECT * FROM "${name}"`).all()))
      .join('\n');
    for (const address of [VPN, HOME]) {
      expect(dump).not.toContain(address);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(address);
      expect(JSON.stringify(server.moderation)).not.toContain(address);
    }
  });
});

describe('proxycheck.io', () => {
  it('reads the answers of the service', () => {
    const answer = (entry: unknown, status = 'ok') => ({ status, [VPN]: entry });
    expect(readProxycheckAnswer(answer({ proxy: 'yes', type: 'VPN' }), VPN)).toEqual({
      verdict: 'proxy',
      kind: 'VPN',
    });
    expect(readProxycheckAnswer(answer({ proxy: 'no' }, 'warning'), VPN)).toEqual({
      verdict: 'clean',
    });
    expect(readProxycheckAnswer({ status: 'denied', message: 'x' }, VPN)).toMatchObject({
      verdict: 'unavailable',
    });
    expect(readProxycheckAnswer({ status: 'ok' }, VPN)).toMatchObject({ verdict: 'unavailable' });
    expect(readProxycheckAnswer('nope', VPN)).toMatchObject({ verdict: 'unavailable' });
  });

  it('sends address and key, and never throws', async () => {
    const urls: string[] = [];
    const fake = vi.fn((url: unknown) => {
      urls.push(String(url));
      return Promise.resolve(Response.json({ status: 'ok', [VPN]: { proxy: 'no' } }));
    });
    const ask = createProxycheckLookup({ apiKey: 'abc123', fetch: fake });
    expect(await ask(VPN)).toEqual({ verdict: 'clean' });
    expect(urls).toEqual([`https://proxycheck.io/v2/${VPN}?vpn=1&key=abc123`]);

    const failing = createProxycheckLookup({
      apiKey: undefined,
      fetch: () => Promise.reject(new Error(`connect to ${VPN} failed`)),
    });
    expect(await failing(VPN)).toEqual({ verdict: 'unavailable', reason: 'request failed' });
    const refused = createProxycheckLookup({
      apiKey: undefined,
      fetch: () => Promise.resolve(new Response('', { status: 429 })),
    });
    expect(await refused(VPN)).toEqual({ verdict: 'unavailable', reason: 'HTTP 429' });
  });

  it('knows which addresses are worth asking about', () => {
    const isPublic = (address: string) => {
      const ip = normalizeIp(address);
      return ip !== undefined && isPublicAddress(ip);
    };
    expect(['203.0.113.7', '8.8.8.8', '2001:db8::1'].map(isPublic)).toEqual([true, true, true]);
    expect(
      [
        '127.0.0.1',
        '10.1.2.3',
        '172.20.0.1',
        '192.168.0.5',
        '100.64.0.1',
        '::1',
        'fd00::1',
        'fe80::1',
      ].map(isPublic),
    ).toEqual(Array(8).fill(false));
  });
});
