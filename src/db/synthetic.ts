/**
 * Synthetic data generator for performance tests (T1.4). Produces realistic-looking but entirely
 * fake users, sessions and activity segments. Never used against the production database.
 */
import type Database from 'better-sqlite3';
import { berlinDay, berlinDayStart, nextDay } from '../domain/time.js';
import type { ActivityState } from './schema.js';

export interface SyntheticOptions {
  years: number;
  regularUsers: number;
  casualUsers: number;
  seed: number;
  /** End of the generated period (UTC seconds), exclusive. */
  endAt: number;
  onProgress?: ((message: string) => void) | undefined;
}

export interface SyntheticResult {
  users: number;
  sessions: number;
  segments: number;
  nicknames: number;
}

/** Mulberry32: small, fast, deterministic PRNG. */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const CHANNELS = [
  'Lobby',
  'Talk 1',
  'Talk 2',
  'Talk 3',
  'Gaming | CS2',
  'Gaming | Valorant',
  'Gaming | Minecraft',
  'Gaming | LoL',
  'Gaming | Rust',
  'Musik',
  'Chill',
  'Support',
  'Team intern',
  'Eventraum',
  'Radio',
];
const AFK_CHANNEL_ID = 99;

const NICK_PARTS = [
  'Shadow',
  'Pixel',
  'Nova',
  'Wolf',
  'Frost',
  'Blitz',
  'Echo',
  'Viper',
  'Storm',
  'Raven',
  'Ghost',
  'Titan',
  'Luna',
  'Hunter',
  'Byte',
  'Dragon',
  'Sniper',
  'Kitty',
  'Panda',
  'Fox',
];

/** Weights for the Berlin start hour of a session: quiet at night, peak in the evening. */
const HOUR_WEIGHTS = [
  2, 1, 1, 0.5, 0.3, 0.3, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 3.5, 4, 5, 6, 8, 10, 12, 12, 10, 7, 4,
];
const HOUR_TOTAL = HOUR_WEIGHTS.reduce((a, b) => a + b, 0);

function pickHour(random: () => number): number {
  let r = random() * HOUR_TOTAL;
  for (let h = 0; h < 24; h++) {
    r -= HOUR_WEIGHTS[h] ?? 0;
    if (r <= 0) return h;
  }
  return 20;
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function randomUid(random: () => number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let uid = '';
  for (let i = 0; i < 27; i++) uid += alphabet.charAt(Math.floor(random() * 64));
  return `${uid}=`;
}

function randomNick(random: () => number): string {
  const nick = pick(random, NICK_PARTS) + pick(random, NICK_PARTS);
  return random() < 0.5 ? `${nick}${String(Math.floor(random() * 1000))}` : nick;
}

/** Session length in seconds: mostly 20 min – 4 h, sometimes very long (idle overnight). */
function sessionLength(random: () => number, casual: boolean): number {
  if (!casual && random() < 0.03) return 8 * 3600 + Math.floor(random() * 16 * 3600);
  const base = casual ? 600 + random() * 3600 : 1200 + random() * random() * 4 * 3600 * 2;
  return Math.floor(base);
}

interface Statements {
  user: Database.Statement;
  nick: Database.Statement;
  channel: Database.Statement;
  session: Database.Statement;
  segment: Database.Statement;
  lastSeen: Database.Statement;
}

function prepare(sqlite: Database.Database): Statements {
  return {
    user: sqlite.prepare(
      `INSERT INTO users (uid, dbid, first_seen, last_seen, platform, version, country)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    nick: sqlite.prepare(
      `INSERT OR IGNORE INTO nicknames (user_id, nick, first_seen, last_seen) VALUES (?, ?, ?, ?)`,
    ),
    channel: sqlite.prepare(`INSERT INTO channels (id, name, last_seen) VALUES (?, ?, ?)`),
    session: sqlite.prepare(
      `INSERT INTO sessions (user_id, join_at, leave_at, duration, source)
       VALUES (?, ?, ?, ?, 'live')`,
    ),
    segment: sqlite.prepare(
      `INSERT INTO activity_segments (user_id, session_id, start_at, end_at, channel_id, state, is_open)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ),
    lastSeen: sqlite.prepare(`UPDATE users SET last_seen = ? WHERE id = ?`),
  };
}

/**
 * Fills an empty, migrated database. Aggregates are not written here; run
 * `rebuildAggregates` afterwards (which also exercises the rebuild at scale).
 */
export function generateSyntheticData(
  sqlite: Database.Database,
  options: SyntheticOptions,
): SyntheticResult {
  const random = createRandom(options.seed);
  const stmts = prepare(sqlite);
  const startAt = options.endAt - Math.round(options.years * 365.25 * 86_400);
  const endDay = berlinDay(options.endAt - 1);
  const result: SyntheticResult = { users: 0, sessions: 0, segments: 0, nicknames: 0 };

  sqlite.transaction(() => {
    CHANNELS.forEach((name, i) => stmts.channel.run(i + 1, name, options.endAt));
    stmts.channel.run(AFK_CHANNEL_ID, 'AFK', options.endAt);
  })();

  const insertSession = (userId: number, joinAt: number, leaveAt: number, favorite: number) => {
    const sessionId = Number(
      stmts.session.run(userId, joinAt, leaveAt, leaveAt - joinAt).lastInsertRowid,
    );
    result.sessions++;
    let t = joinAt;
    let channel = favorite;
    while (t < leaveAt) {
      const end = Math.min(leaveAt, t + 300 + Math.floor(random() * 90 * 60));
      const r = random();
      const state: ActivityState = r < 0.62 ? 'active' : r < 0.87 ? 'idle' : 'afk';
      if (state === 'afk') channel = AFK_CHANNEL_ID;
      else if (random() < 0.3) channel = 1 + Math.floor(random() * CHANNELS.length);
      stmts.segment.run(userId, sessionId, t, end, channel, state);
      result.segments++;
      t = end;
    }
  };

  interface Profile {
    firstDay: number;
    lastDay: number;
    dailyChance: number;
    weekendBoost: number;
    favorite: number;
    casual: boolean;
  }

  const createUser = (profile: Profile): void => {
    const firstSeen = berlinDayStart(profile.firstDay);
    const userId = Number(
      stmts.user.run(
        randomUid(random),
        result.users + 1,
        firstSeen,
        firstSeen,
        pick(random, ['Windows', 'Windows', 'Windows', 'Linux', 'macOS', 'Android']),
        pick(random, ['3.6.1', '3.6.2', '5.0.0']),
        pick(random, ['DE', 'DE', 'DE', 'DE', 'AT', 'CH', 'NL', 'PL']),
      ).lastInsertRowid,
    );
    result.users++;

    // Nick history: 1–4 nicks over the user's lifetime.
    const nickCount = profile.casual ? 1 : 1 + Math.floor(random() * 4);
    const lifetime = berlinDayStart(profile.lastDay) - firstSeen;
    for (let i = 0; i < nickCount; i++) {
      const from = firstSeen + Math.floor((lifetime * i) / nickCount);
      const to = firstSeen + Math.floor((lifetime * (i + 1)) / nickCount);
      if (stmts.nick.run(userId, randomNick(random), from, to).changes > 0) result.nicknames++;
    }

    let lastLeave = 0;
    let lastSeen = firstSeen;
    for (let day = profile.firstDay; day <= profile.lastDay; day = nextDay(day)) {
      const dayStart = berlinDayStart(day);
      const weekday = new Date((dayStart + 12 * 3600) * 1000).getUTCDay();
      const chance =
        profile.dailyChance * (weekday === 0 || weekday === 6 ? profile.weekendBoost : 1);
      if (random() >= chance) continue;
      const count = profile.casual ? 1 : 1 + (random() < 0.35 ? 1 : 0) + (random() < 0.1 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const joinAt = Math.max(
          lastLeave + 60,
          dayStart + pickHour(random) * 3600 + Math.floor(random() * 3600),
        );
        const leaveAt = Math.min(joinAt + sessionLength(random, profile.casual), options.endAt - 1);
        if (leaveAt <= joinAt) continue;
        insertSession(userId, joinAt, leaveAt, profile.favorite);
        lastLeave = leaveAt;
        lastSeen = leaveAt;
      }
    }
    stmts.lastSeen.run(lastSeen, userId);
  };

  const totalDays = Math.max(1, Math.round((options.endAt - startAt) / 86_400));
  const dayAt = (fraction: number): number =>
    Math.min(endDay, berlinDay(startAt + Math.floor(fraction * totalDays) * 86_400 + 43_200));

  const batch = sqlite.transaction((profiles: Profile[]) => {
    profiles.forEach(createUser);
  });

  let pending: Profile[] = [];
  const flush = () => {
    batch(pending);
    pending = [];
  };

  for (let i = 0; i < options.regularUsers; i++) {
    const firstFraction = random() < 0.25 ? 0 : random() * 0.85;
    const churned = random() < 0.35;
    const lastFraction = churned ? firstFraction + random() * (1 - firstFraction) : 1;
    pending.push({
      firstDay: dayAt(firstFraction),
      lastDay: churned ? dayAt(lastFraction) : endDay,
      dailyChance: 0.25 + random() * 0.65,
      weekendBoost: 1 + random() * 0.4,
      favorite: 1 + Math.floor(random() * CHANNELS.length),
      casual: false,
    });
    if (pending.length === 25) {
      flush();
      options.onProgress?.(`regular users: ${String(i + 1)}/${String(options.regularUsers)}`);
    }
  }
  flush();

  for (let i = 0; i < options.casualUsers; i++) {
    const firstDay = dayAt(random());
    const spanDays = Math.floor(random() * 30);
    let lastDay = firstDay;
    for (let d = 0; d < spanDays && lastDay < endDay; d++) lastDay = nextDay(lastDay);
    pending.push({
      firstDay,
      lastDay,
      dailyChance: Math.min(1, (1 + random() * 6) / (spanDays + 1)),
      weekendBoost: 1.2,
      favorite: 1 + Math.floor(random() * CHANNELS.length),
      casual: true,
    });
    if (pending.length === 500) {
      flush();
      options.onProgress?.(`casual users: ${String(i + 1)}/${String(options.casualUsers)}`);
    }
  }
  flush();
  return result;
}
