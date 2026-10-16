import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { createSilentLogger } from '../../logging/logger.js';
import { Ts3Connection } from '../../ts3/connection.js';
import { FakeTs3Server } from '../../ts3/fake-transport.js';
import { IpProcessor } from '../../watcher/ip-processor.js';
import { loadActivitySettings, saveActivitySettings } from '../../watcher/settings.js';
import { SessionTracker } from '../../watcher/tracker.js';
import { AutomationHost, type BotClient } from '../host.js';
import { listAutomationLog } from '../log.js';
import type { ProxyLookupResult } from '../proxycheck.js';
import { saveModuleSettings } from '../settings.js';
import { candidateMessages, getVouch, sponsorCandidates } from './proxy-invite.js';
import { ProxyModule } from './proxy.js';

const VPN = '203.0.113.7';
const HOME = '198.51.100.20';
const BLOCKED = 50;
const TRUSTED = 51;
const MEMBER = 20;
const GAMING = 2;
const AFK = 9;

let now: number;
let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let tracker: SessionTracker;
let host: AutomationHost;
let ips: IpProcessor;
let module: ProxyModule;
const lookup = vi.fn((address: string): Promise<ProxyLookupResult> =>
  Promise.resolve(address === VPN ? { verdict: 'proxy', kind: 'VPN' } : { verdict: 'clean' }),
);

function configure(settings: Record<string, unknown> = {}, invite: Record<string, unknown> = {}) {
  saveModuleSettings(
    database.db,
    'proxy',
    {
      enabled: true,
      dryRun: false,
      action: 'invite',
      groupId: BLOCKED,
      invite: { whitelistGroupId: TRUSTED, ...invite },
      ...settings,
    },
    now,
  );
}

async function settle(): Promise<void> {
  await ips.idle();
  await module.idle();
  await host.idle();
}

async function join(nickname: string, ip = HOME, extra: Record<string, unknown> = {}) {
  const clid = server.join({ uid: `uid-${nickname}`, nickname, ...extra }, ip);
  await settle();
  return clid;
}

async function say(clid: number, message: string): Promise<void> {
  server.privateMessage(clid, message);
  await settle();
}

async function poll(): Promise<void> {
  tracker.sync(await connection.clientList(), now);
  await settle();
}

const messages = (clid: number) =>
  server.moderation.filter((m) => m.command === 'message' && m.clid === clid).map((m) => m.text);
const groups = (clid: number) => server.clients.get(clid)?.serverGroups ?? [];
const userOf = (clid: number) => host.get(clid)?.userId ?? 0;
const logged = () =>
  listAutomationLog(database.sqlite, { limit: 60, offset: 0 })
    .items.map((row) => row.action)
    .reverse();

beforeEach(async () => {
  now = 1_789_800_000;
  lookup.mockClear();
  database = createTestDatabase();
  server = new FakeTs3Server();
  server.addChannel(GAMING, 'Gaming');
  server.addChannel(AFK, 'AFK');
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
    logger,
    now: () => now,
    lookup,
    client: (clid) => host.get(clid),
    online: () => host.online,
    notifier: { notify: vi.fn() },
  });
  ips = new IpProcessor({
    database,
    connection,
    countries: { country: () => undefined },
    hmacSecret: 'x'.repeat(32),
    logger,
    onAddress: (client, ip, ipHash) => {
      module.inspect(client, ip, ipHash);
    },
  });
  tracker.addListener(ips);
  tracker.addListener(host);
  host.register(module);
  connection.on('clientConnect', (client) => tracker.join(client, now));
  connection.on('clientMoved', (event) => {
    tracker.move(event.clid, event.channelId, now, event);
  });
  connection.on('clientDisconnect', (event) => {
    tracker.leave(event.clid, now);
  });
  connection.on('textMessage', (event) => {
    host.onTextMessage(event, now);
  });
  connection.start();
  await vi.waitFor(() => {
    expect(connection.isConnected).toBe(true);
  });
  saveActivitySettings(
    database.db,
    { ...loadActivitySettings(database.db), afkChannelIds: [AFK] },
    now,
  );
});

afterEach(async () => {
  await connection.stop();
  database.close();
});

describe('invite flow', () => {
  it('restricts the player and asks who they belong to, with a numbered list', async () => {
    configure();
    await join('Zoe');
    await join('Anna');
    const guest = await join('Gast', VPN);
    expect(groups(guest)).toContain(BLOCKED);
    expect(messages(guest)).toEqual([
      expect.stringContaining('Zu wem gehörst du?'),
      '1 – Anna\n2 – Zoe',
    ]);
  });

  it('asks the chosen player and, on a yes, frees the guest and moves them over', async () => {
    configure();
    const anna = await join('Anna', HOME, { channelId: GAMING });
    const guest = await join('Gast', VPN, { dbid: 301 });
    await say(guest, '1');
    expect(messages(anna)).toEqual([
      'Gast ist über ein VPN oder einen Proxy verbunden und sagt, er gehört zu dir. Antworte mir mit „ja“, wenn das stimmt, sonst mit „nein“.',
    ]);
    expect(messages(guest).at(-1)).toBe('Anna wurde gefragt. Bitte warte auf die Antwort.');

    await say(anna, 'Ja');
    expect(groups(guest)).toContain(TRUSTED);
    expect(groups(guest)).not.toContain(BLOCKED);
    expect(server.clients.get(guest)?.channelId).toBe(GAMING);
    expect(getVouch(database.db, userOf(guest))).toEqual({
      sponsorUserId: userOf(anna),
      at: now,
    });
    expect(messages(guest).at(-1)).toBe('Anna hat für dich gebürgt. Du bist freigeschaltet.');
    expect(messages(anna).at(-1)).toContain('du bürgst für diesen Spieler');
    expect(logged()).toContain('proxy.vouched');
  });

  it('does not move the guest into an AFK channel', async () => {
    configure();
    const anna = await join('Anna', HOME, { channelId: AFK });
    const guest = await join('Gast', VPN);
    await say(guest, '1');
    await say(anna, 'ja');
    expect(groups(guest)).toContain(TRUSTED);
    expect(server.clients.get(guest)?.channelId).toBe(1);
  });

  it('leaves a vouched player alone from then on', async () => {
    configure();
    const anna = await join('Anna');
    const guest = await join('Gast', VPN);
    await say(guest, '1');
    await say(anna, 'ja');
    server.leave(guest);
    lookup.mockClear();
    server.moderation.length = 0;

    const again = await join('Gast', VPN, { serverGroups: [8, TRUSTED] });
    expect(lookup).not.toHaveBeenCalled();
    expect(groups(again)).not.toContain(BLOCKED);
    expect(messages(again)).toEqual([]);
  });

  it('relies on its own record when no whitelist group is set', async () => {
    configure({}, { whitelistGroupId: null });
    const anna = await join('Anna');
    const guest = await join('Gast', VPN);
    await say(guest, '1');
    await say(anna, 'ja');
    expect(groups(guest)).toEqual([8]);
    server.leave(guest);
    server.moderation.length = 0;
    const again = await join('Gast', VPN);
    expect(groups(again)).not.toContain(BLOCKED);
    expect(messages(again)).toEqual([]);
  });

  it('lets the guest pick somebody else after a no, up to the limit', async () => {
    configure({}, { maxAttempts: 2 });
    const anna = await join('Anna');
    const zoe = await join('Zoe');
    const guest = await join('Gast', VPN);
    await say(guest, '1');
    await say(anna, 'nein');
    expect(messages(guest).at(-1)).toBe(
      'Anna hat nicht bestätigt. Du kannst eine andere Nummer wählen.',
    );
    expect(groups(guest)).toContain(BLOCKED);

    await say(guest, '2');
    await say(zoe, 'nein');
    expect(messages(guest).at(-1)).toBe(
      'Das waren zu viele Versuche. Bitte melde dich bei einem Admin.',
    );
    const before = messages(anna).length;
    await say(guest, '1');
    expect(messages(anna)).toHaveLength(before);
    expect(getVouch(database.db, userOf(guest))).toBeUndefined();
  });

  it('repeats the question to the guest for anything that is not a number on the list', async () => {
    configure();
    await join('Anna');
    const guest = await join('Gast', VPN);
    for (const text of ['hallo', '0', '7']) await say(guest, text);
    expect(messages(guest).filter((m) => m?.includes('Zu wem gehörst du?'))).toHaveLength(4);
  });

  it('ignores a yes from somebody who was not asked, and chatter from the sponsor', async () => {
    configure();
    const anna = await join('Anna');
    const zoe = await join('Zoe');
    const guest = await join('Gast', VPN);
    await say(guest, '1');
    await say(zoe, 'ja');
    await say(anna, 'wer ist das?');
    expect(groups(guest)).toContain(BLOCKED);
    await say(anna, 'ja');
    expect(groups(guest)).not.toContain(BLOCKED);
  });

  it('gives up on a sponsor who does not answer in time', async () => {
    configure({}, { timeoutS: 120 });
    const anna = await join('Anna');
    const guest = await join('Gast', VPN);
    await say(guest, '1');
    now += 119;
    await poll();
    expect(messages(guest)).toHaveLength(3);
    now += 1;
    await poll();
    expect(messages(guest).at(-1)).toBe(
      'Anna hat nicht geantwortet. Du kannst eine andere Nummer wählen.',
    );
    // A late yes no longer counts.
    await say(anna, 'ja');
    expect(groups(guest)).toContain(BLOCKED);
  });

  it('tells the guest when the sponsor leaves instead of answering', async () => {
    configure();
    const anna = await join('Anna');
    const guest = await join('Gast', VPN);
    await say(guest, '1');
    server.leave(anna);
    await settle();
    expect(messages(guest).at(-1)).toBe(
      'Anna hat nicht geantwortet. Du kannst eine andere Nummer wählen.',
    );
  });

  it('only offers members of the sponsor groups, and says so when nobody is there', async () => {
    configure({}, { sponsorGroupIds: [MEMBER] });
    await join('Fremder');
    const lonely = await join('Gast', VPN);
    expect(messages(lonely)).toEqual([expect.stringContaining('niemand online')]);

    await join('Mitglied', HOME, { serverGroups: [8, MEMBER] });
    server.leave(lonely);
    const guest = await join('Gast', VPN, { serverGroups: [8, BLOCKED] });
    expect(messages(guest).at(-1)).toBe('1 – Mitglied');
  });

  it('never lists another restricted player as a possible sponsor', async () => {
    configure();
    await join('Anna');
    await join('Auch Gast', VPN);
    const guest = await join('Gast', '203.0.113.7');
    expect(messages(guest).at(-1)).toBe('1 – Anna');
  });

  it('takes the restriction away from a player who comes back without a proxy', async () => {
    configure();
    await join('Anna');
    const guest = await join('Gast', VPN, { dbid: 301 });
    expect(groups(guest)).toContain(BLOCKED);
    server.leave(guest);
    const again = await join('Gast', HOME, { dbid: 301, serverGroups: [8, BLOCKED] });
    expect(groups(again)).not.toContain(BLOCKED);
  });

  it('only records what it would do in test mode', async () => {
    configure({ dryRun: true });
    await join('Anna');
    const guest = await join('Gast', VPN);
    await say(guest, '1');
    expect(groups(guest)).not.toContain(BLOCKED);
    expect(server.moderation).toEqual([]);
    expect(logged()).toEqual(['proxy.detected', 'group.add', 'proxy.invite']);
  });
});

describe('candidate list', () => {
  const client = (userId: number, nickname: string, serverGroups: number[] = [8]): BotClient => ({
    clid: userId,
    userId,
    dbid: userId,
    uid: `uid-${String(userId)}`,
    nickname,
    channelId: 1,
    serverGroups,
  });

  it('lists every person once, by name, without the player', () => {
    const player = client(1, 'Gast');
    const online = [player, client(2, 'zoe'), client(3, 'Anna'), { ...client(3, 'Anna'), clid: 9 }];
    const options = { blockGroupId: BLOCKED, sponsorGroupIds: [] };
    expect(sponsorCandidates(online, player, options)).toEqual([
      { userId: 3, nickname: 'Anna' },
      { userId: 2, nickname: 'zoe' },
    ]);
  });

  it('caps the list', () => {
    const player = client(1, 'Gast');
    const online = Array.from({ length: 200 }, (_, i) => client(i + 2, `Spieler ${String(i)}`));
    const options = { blockGroupId: null, sponsorGroupIds: [] };
    expect(sponsorCandidates(online, player, options)).toHaveLength(60);
  });

  it('splits a long list into messages the server accepts and defuses BBCode', () => {
    const candidates = Array.from({ length: 60 }, (_, i) => ({
      userId: i,
      nickname: `[b]Spieler mit langem Namen ${String(i)}`,
    }));
    const messages = candidateMessages(candidates);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 1024)).toBe(true);
    expect(messages[0]?.startsWith('1 – \\[b]Spieler')).toBe(true);
    expect(messages.join('\n').split('\n')).toHaveLength(60);
  });
});

describe('English texts (T12.1)', () => {
  const english = { enabled: true };

  it('talks to guest and sponsor each in their own language', async () => {
    configure({ english });
    const anna = await join('Anna', HOME, { country: 'DE' });
    const guest = await join('Guest', VPN, { country: 'US' });
    expect(messages(guest)).toEqual([expect.stringContaining('Who do you belong to?'), '1 – Anna']);
    await say(guest, '1');
    expect(messages(anna)).toEqual([expect.stringContaining('Antworte mir mit „ja“')]);
    expect(messages(guest).at(-1)).toBe('Anna has been asked. Please wait for the answer.');
    await say(anna, 'ja');
    expect(messages(guest).at(-1)).toBe('Anna vouched for you. You are now unlocked.');
    expect(messages(anna).at(-1)).toContain('du bürgst für diesen Spieler');
  });

  it('understands the answer words of both languages', async () => {
    configure({ english });
    const john = await join('John', HOME, { country: 'GB' });
    const zoe = await join('Zoe', HOME, { country: 'AT' });
    const guest = await join('Gast', VPN, { country: 'DE' });
    await say(guest, '1');
    expect(messages(john)).toEqual([expect.stringContaining('Reply with "yes"')]);
    await say(john, 'nein');
    expect(messages(guest).at(-1)).toBe(
      'John hat nicht bestätigt. Du kannst eine andere Nummer wählen.',
    );
    await say(guest, '2');
    await say(zoe, 'YES');
    expect(groups(guest)).toContain(TRUSTED);
  });

  it('ignores English words while English is off', async () => {
    configure();
    const anna = await join('Anna', HOME, { country: 'US' });
    const guest = await join('Gast', VPN, { country: 'US' });
    expect(messages(guest)[0]).toContain('Zu wem gehörst du?');
    await say(guest, '1');
    await say(anna, 'yes');
    expect(groups(guest)).not.toContain(TRUSTED);
  });

  it('tells a waiting guest in their language that the sponsor left', async () => {
    configure({ english });
    const anna = await join('Anna', HOME, { country: 'DE' });
    const guest = await join('Guest', VPN, { country: 'NL' });
    await say(guest, '1');
    server.leave(anna);
    await settle();
    expect(messages(guest).at(-1)).toBe('Anna did not answer. You can choose another number.');
  });
});
