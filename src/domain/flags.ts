/**
 * Alt and ban-evasion detection (T5.2). Works on IP/subnet hashes only (AGENTS.md rule 1) and is
 * pure: the caller loads the data and stores the result.
 */

export type FlagKind = 'ban_ip' | 'ban_subnet' | 'shared_ip';
export type FlagLevel = 'high' | 'medium' | 'info';

export const FLAG_LEVEL: Record<FlagKind, FlagLevel> = {
  ban_ip: 'high',
  ban_subnet: 'medium',
  shared_ip: 'info',
};

/** An IP address seen for a user; hashes as hex (or any stable string). */
export interface SeenIp {
  userId: number;
  ipHash: string;
  subnetHash: string;
  lastSeen: number;
}

/** An active ban: by UID (`userId` known), by IP, or both. */
export interface ActiveBan {
  banId: number;
  userId: number | null;
  ipHash: string | null;
  subnetHash: string | null;
}

export interface FlagCandidate {
  kind: FlagKind;
  level: FlagLevel;
  /** The suspicious (not banned) user. */
  userId: number;
  /** The banned user, or the other user of a shared IP. */
  relatedUserId: number | null;
  /** Set when the banned side is an IP ban without a known user. */
  banId: number | null;
  /** Stable identity of the pair; decisions (ignored, linked) are stored under it. */
  pairKey: string;
  evidence: { sharedIps: number; sharedSubnets: number; lastSeen: number };
}

/** IPs shared by more users than this are treated as public/NAT and do not create info flags. */
export const MAX_SHARED_IP_USERS = 10;

interface Identity {
  key: string;
  userId: number | null;
  banId: number | null;
  ipHashes: Set<string>;
  subnetHashes: Set<string>;
}

function groupBy<K>(rows: readonly SeenIp[], key: (row: SeenIp) => K): Map<K, SeenIp[]> {
  const map = new Map<K, SeenIp[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/** Everything that identifies a banned party: its own ban rules plus all IPs its UID used. */
function bannedIdentities(bans: readonly ActiveBan[], byUser: Map<number, SeenIp[]>): Identity[] {
  const identities = new Map<string, Identity>();
  for (const ban of bans) {
    const key = ban.userId === null ? `b${String(ban.banId)}` : `u${String(ban.userId)}`;
    let identity = identities.get(key);
    if (!identity) {
      identity = {
        key,
        userId: ban.userId,
        banId: ban.userId === null ? ban.banId : null,
        ipHashes: new Set(),
        subnetHashes: new Set(),
      };
      identities.set(key, identity);
      for (const seen of ban.userId === null ? [] : (byUser.get(ban.userId) ?? [])) {
        identity.ipHashes.add(seen.ipHash);
        identity.subnetHashes.add(seen.subnetHash);
      }
    }
    if (ban.ipHash) identity.ipHashes.add(ban.ipHash);
    if (ban.subnetHash) identity.subnetHashes.add(ban.subnetHash);
  }
  return [...identities.values()];
}

interface Tally {
  ips: Set<string>;
  subnets: Set<string>;
  lastSeen: number;
}

function tally(map: Map<number, Tally>, userId: number): Tally {
  let entry = map.get(userId);
  if (!entry) {
    entry = { ips: new Set(), subnets: new Set(), lastSeen: 0 };
    map.set(userId, entry);
  }
  return entry;
}

/**
 * Flags per pair, strongest kind only: a user sharing an IP with a banned party is `ban_ip`
 * (not also `ban_subnet` or `shared_ip`). Banned users are never flagged themselves.
 */
export function detectFlags(seen: readonly SeenIp[], bans: readonly ActiveBan[]): FlagCandidate[] {
  const byUser = groupBy(seen, (s) => s.userId);
  const byIp = groupBy(seen, (s) => s.ipHash);
  const bySubnet = groupBy(seen, (s) => s.subnetHash);
  const bannedUsers = new Set(bans.flatMap((b) => (b.userId === null ? [] : [b.userId])));
  const flags: FlagCandidate[] = [];

  for (const identity of bannedIdentities(bans, byUser)) {
    const hits = new Map<number, Tally>();
    for (const ip of identity.ipHashes) {
      for (const row of byIp.get(ip) ?? []) {
        if (bannedUsers.has(row.userId)) continue;
        const t = tally(hits, row.userId);
        t.ips.add(ip);
        t.lastSeen = Math.max(t.lastSeen, row.lastSeen);
      }
    }
    for (const subnet of identity.subnetHashes) {
      for (const row of bySubnet.get(subnet) ?? []) {
        if (bannedUsers.has(row.userId)) continue;
        const t = tally(hits, row.userId);
        t.subnets.add(subnet);
        t.lastSeen = Math.max(t.lastSeen, row.lastSeen);
      }
    }
    for (const [userId, t] of hits) {
      const kind: FlagKind = t.ips.size > 0 ? 'ban_ip' : 'ban_subnet';
      flags.push({
        kind,
        level: FLAG_LEVEL[kind],
        userId,
        relatedUserId: identity.userId,
        banId: identity.banId,
        pairKey: `ban:${String(userId)}:${identity.key}`,
        evidence: { sharedIps: t.ips.size, sharedSubnets: t.subnets.size, lastSeen: t.lastSeen },
      });
    }
  }

  const shared = new Map<string, { a: number; b: number; tally: Tally }>();
  for (const [ip, rows] of byIp) {
    const users = [...new Set(rows.map((r) => r.userId))].sort((x, y) => x - y);
    if (users.length < 2 || users.length > MAX_SHARED_IP_USERS) continue;
    const lastSeen = Math.max(...rows.map((r) => r.lastSeen));
    for (let i = 0; i < users.length; i++) {
      for (let j = i + 1; j < users.length; j++) {
        const a = users[i] as number;
        const b = users[j] as number;
        const id = pairId(a, b);
        // Pairs with a banned user are ban flags already (or both are banned: nothing to do).
        if (bannedUsers.has(a) || bannedUsers.has(b)) continue;
        let entry = shared.get(id);
        if (!entry) {
          entry = { a, b, tally: { ips: new Set(), subnets: new Set(), lastSeen: 0 } };
          shared.set(id, entry);
        }
        entry.tally.ips.add(ip);
        entry.tally.lastSeen = Math.max(entry.tally.lastSeen, lastSeen);
      }
    }
  }
  for (const [id, { a, b, tally: t }] of shared) {
    flags.push({
      kind: 'shared_ip',
      level: 'info',
      userId: a,
      relatedUserId: b,
      banId: null,
      pairKey: `shared:${id}`,
      evidence: { sharedIps: t.ips.size, sharedSubnets: 0, lastSeen: t.lastSeen },
    });
  }
  return flags;
}

function pairId(a: number, b: number): string {
  return a < b ? `${String(a)}:${String(b)}` : `${String(b)}:${String(a)}`;
}
