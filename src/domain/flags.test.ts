import { describe, expect, it } from 'vitest';
import { detectFlags, MAX_SHARED_IP_USERS, type ActiveBan, type SeenIp } from './flags.js';

const seen = (userId: number, ip: string, subnet: string, lastSeen = 100): SeenIp => ({
  userId,
  ipHash: ip,
  subnetHash: subnet,
  lastSeen,
});

const uidBan = (banId: number, userId: number): ActiveBan => ({
  banId,
  userId,
  ipHash: null,
  subnetHash: null,
});

function summary(flags: ReturnType<typeof detectFlags>) {
  return flags
    .map((f) => [f.kind, f.level, f.userId, f.relatedUserId, f.banId] as const)
    .sort((a, b) => a.join().localeCompare(b.join()));
}

describe('detectFlags', () => {
  it('flags the same IP as a banned UID as high', () => {
    const flags = detectFlags(
      [seen(1, 'ip-a', 'net-a', 200), seen(2, 'ip-a', 'net-a', 300)],
      [uidBan(10, 1)],
    );
    expect(summary(flags)).toEqual([['ban_ip', 'high', 2, 1, null]]);
    expect(flags[0]).toMatchObject({
      pairKey: 'ban:2:u1',
      evidence: { sharedIps: 1, sharedSubnets: 1, lastSeen: 300 },
    });
  });

  it('flags the same subnet as a banned UID as medium', () => {
    const flags = detectFlags(
      [seen(1, 'ip-a', 'net-a'), seen(2, 'ip-b', 'net-a')],
      [uidBan(10, 1)],
    );
    expect(summary(flags)).toEqual([['ban_subnet', 'medium', 2, 1, null]]);
  });

  it('flags the same IP as another UID as info', () => {
    const flags = detectFlags([seen(3, 'ip-a', 'net-a'), seen(1, 'ip-a', 'net-a')], []);
    expect(summary(flags)).toEqual([['shared_ip', 'info', 1, 3, null]]);
    expect(flags[0]?.pairKey).toBe('shared:1:3');
  });

  it('matches IP-only bans by their own hashes', () => {
    const flags = detectFlags(
      [seen(2, 'ip-x', 'net-x'), seen(3, 'ip-y', 'net-x'), seen(4, 'ip-z', 'net-z')],
      [{ banId: 7, userId: null, ipHash: 'ip-x', subnetHash: 'net-x' }],
    );
    expect(summary(flags)).toEqual([
      ['ban_ip', 'high', 2, null, 7],
      ['ban_subnet', 'medium', 3, null, 7],
    ]);
    expect(flags.find((f) => f.userId === 2)?.pairKey).toBe('ban:2:b7');
  });

  it('keeps only the strongest flag per pair and never flags banned users', () => {
    const flags = detectFlags(
      [
        seen(1, 'ip-a', 'net-a'),
        seen(1, 'ip-b', 'net-b'),
        seen(2, 'ip-a', 'net-a'),
        seen(2, 'ip-c', 'net-b'),
        seen(5, 'ip-a', 'net-a'),
      ],
      [uidBan(10, 1), uidBan(11, 5)],
    );
    // User 2 shares ip-a with both banned users; banned users 1 and 5 share ip-a too.
    expect(summary(flags)).toEqual([
      ['ban_ip', 'high', 2, 1, null],
      ['ban_ip', 'high', 2, 5, null],
    ]);
    expect(flags.find((f) => f.relatedUserId === 1)?.evidence).toMatchObject({
      sharedIps: 1,
      sharedSubnets: 2,
    });
  });

  it('merges several bans of the same user into one identity', () => {
    const flags = detectFlags(
      [seen(1, 'ip-a', 'net-a'), seen(2, 'ip-b', 'net-b')],
      [uidBan(10, 1), { banId: 11, userId: 1, ipHash: 'ip-b', subnetHash: 'net-b' }],
    );
    expect(summary(flags)).toEqual([['ban_ip', 'high', 2, 1, null]]);
  });

  it('ignores IPs shared by too many users (NAT, public networks)', () => {
    const many = Array.from({ length: MAX_SHARED_IP_USERS + 1 }, (_, i) =>
      seen(i + 1, 'ip-nat', 'net-nat'),
    );
    expect(detectFlags(many, [])).toEqual([]);
    // A ban still matches on such an IP.
    expect(detectFlags(many, [uidBan(1, 1)])).toHaveLength(MAX_SHARED_IP_USERS);
  });

  it('counts several shared IPs of a pair in one flag', () => {
    const flags = detectFlags(
      [
        seen(1, 'ip-a', 'net-a', 10),
        seen(2, 'ip-a', 'net-a', 20),
        seen(1, 'ip-b', 'net-b', 50),
        seen(2, 'ip-b', 'net-b', 40),
      ],
      [],
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]?.evidence).toEqual({ sharedIps: 2, sharedSubnets: 0, lastSeen: 50 });
  });
});
