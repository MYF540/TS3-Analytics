import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { recordNickname, upsertUser } from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import type { FlagCandidate } from '../domain/flags.js';
import { createSilentLogger } from '../logging/logger.js';
import { Ts3Connection } from '../ts3/connection.js';
import { FakeTs3Server } from '../ts3/fake-transport.js';
import { applyBanList } from '../watcher/bans.js';
import { ConnectionAlerts, OUTAGE_ALERT_AFTER_MS } from './connection.js';
import { alertNewBans, alertNewFlags } from './dispatch.js';
import { AlertNotifier } from './notifier.js';

let database: AppDatabase;
let notifier: AlertNotifier;
let notify: MockInstance<AlertNotifier['notify']>;

beforeEach(() => {
  database = createTestDatabase();
  notifier = new AlertNotifier({ db: database.db, logger: createSilentLogger() });
  notify = vi.spyOn(notifier, 'notify').mockImplementation(() => undefined);
});

afterEach(() => {
  database.close();
  vi.useRealTimers();
});

const texts = () => notify.mock.calls.map((call) => [call[0], call[1]]);

describe('flag and ban alerts', () => {
  it('reports new high and medium flags with escaped nicknames, not info or the first run', () => {
    const alt = upsertUser(database.db, { uid: 'alt=', seenAt: 1 });
    const banned = upsertUser(database.db, { uid: 'banned=', seenAt: 1 });
    recordNickname(database.db, alt, '*Alt*', 1);
    recordNickname(database.db, banned, 'Troll', 1);
    const flag = (kind: FlagCandidate['kind'], level: FlagCandidate['level']): FlagCandidate => ({
      kind,
      level,
      userId: alt,
      relatedUserId: banned,
      banId: null,
      pairKey: kind,
      evidence: { sharedIps: 1, sharedSubnets: 1, lastSeen: 1 },
    });
    const newFlags = [
      flag('ban_ip', 'high'),
      flag('ban_subnet', 'medium'),
      flag('shared_ip', 'info'),
    ];
    alertNewFlags(notifier, database.sqlite, { detected: 3, created: 3, newFlags, initial: true });
    expect(notify).not.toHaveBeenCalled();
    alertNewFlags(notifier, database.sqlite, { detected: 3, created: 3, newFlags, initial: false });
    expect(texts()).toEqual([
      [
        'flag.high',
        '🔴 **Hinweis (hoch):** \\*Alt\\* nutzt dieselbe IP-Adresse wie der gebannte Spieler Troll.',
      ],
      [
        'flag.medium',
        '🟠 **Hinweis (mittel):** \\*Alt\\* ist im selben Subnetz wie der gebannte Spieler Troll.',
      ],
    ]);
  });

  it('reports new bans after the initial mirror', () => {
    const base = {
      ip: undefined,
      name: undefined,
      uid: undefined,
      lastNickname: undefined,
      reason: undefined,
      invokerName: 'Admin',
      invokerUid: undefined,
      createdAt: 1,
      durationS: 0,
      enforcements: 0,
    };
    const first = applyBanList(
      database,
      [{ ...base, banId: 1, lastNickname: 'Alt' }],
      'x'.repeat(32),
      10,
    );
    alertNewBans(notifier, database.sqlite, first);
    expect(notify).not.toHaveBeenCalled();
    const second = applyBanList(
      database,
      [
        { ...base, banId: 1, lastNickname: 'Alt' },
        { ...base, banId: 2, lastNickname: 'Spammer', reason: 'Werbung', durationS: 7200 },
      ],
      'x'.repeat(32),
      20,
    );
    alertNewBans(notifier, database.sqlite, second);
    expect(texts()).toEqual([
      ['ban.added', '⛔ **Neuer Ban:** Spammer · Dauer: 2 h · Grund: Werbung · von Admin'],
    ]);
  });
});

describe('ConnectionAlerts', () => {
  it('reports outages longer than two minutes and the recovery', async () => {
    vi.useFakeTimers({ now: 0 });
    const server = new FakeTs3Server(() => Date.now());
    const connection = new Ts3Connection(
      server.createTransport,
      { commandsPerSecond: 5, jitter: 0, initialBackoffMs: 1000, maxBackoffMs: 1000 },
      { logger: createSilentLogger() },
    );
    const alerts = new ConnectionAlerts(connection, notifier);
    alerts.start();
    connection.start();
    await vi.advanceTimersByTimeAsync(0);

    // A short reconnect is not reported.
    server.dropConnection();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.isConnected).toBe(true);

    server.failConnects = 1_000;
    server.dropConnection();
    await vi.advanceTimersByTimeAsync(OUTAGE_ALERT_AFTER_MS);
    expect(texts()).toEqual([['bot.connection', expect.stringContaining('Bot offline')]]);

    server.failConnects = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(texts().at(-1)).toEqual(['bot.connection', expect.stringContaining('wieder verbunden')]);
    alerts.stop();
    await connection.stop();
  });
});
