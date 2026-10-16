/**
 * Achievements (T13.2): the catalog and pure functions that turn the facts of one person into
 * reached tiers. The job (`src/achievements/job.ts`) gathers the facts and stores the result;
 * nothing here touches the database or the server.
 *
 * Every achievement reports its current value and, per tier, when the tier was reached (or
 * `null`). The value drives the progress bar on the player page; the times drive the date shown
 * next to a badge. Names and descriptions live in the web translation file, keyed by `id`.
 */
import { berlinDay, berlinDayStart, berlinOffset, HOUR_S } from './time.js';

export const ACHIEVEMENT_GROUPS = [
  'playtime',
  'loyalty',
  'streak',
  'session',
  'time',
  'social',
  'server',
  'secret',
] as const;
export type AchievementGroup = (typeof ACHIEVEMENT_GROUPS)[number];

/** How the value and the thresholds are shown: hours and days are converted in the frontend. */
export type AchievementUnit = 'seconds' | 'days' | 'years' | 'count';

/** One calendar day of a person (all linked accounts added up). */
export interface DayFact {
  /** Berlin calendar day, YYYYMMDD. */
  day: number;
  onlineS: number;
  /** Time that counts for ranks on this day: live online time after the legacy cutoff. */
  rankS: number;
  activeS: number;
  afkS: number;
  sessions: number;
  longestSessionS: number;
}

export interface SessionFact {
  joinAt: number;
  /** Open sessions end at `now`. */
  leaveAt: number;
}

export interface PersonFacts {
  now: number;
  /** Earliest first visit of all accounts. */
  firstSeen: number;
  /** Ranking time taken over from the old ranking system (rule 12). */
  legacyS: number;
  /** When the legacy time counts: the cutoff, or the first visit if no cutoff is set. */
  legacyAt: number;
  /** Ascending by day. */
  days: readonly DayFact[];
  /** Ascending by join time. */
  sessions: readonly SessionFact[];
  /** First visit of every distinct channel, ascending. */
  channelFirstSeen: readonly number[];
  /** First use of every distinct nickname, ascending. */
  nicknameFirstSeen: readonly number[];
  /** Time spent together with every other person of the network (range "all"), seconds. */
  contactSeconds: readonly number[];
  /** Among the first persons ever seen on the server. */
  pioneer: boolean;
  /** When the rank job decided the top rank of the ladder for this person, if it did. */
  topRankAt: number | null;
  /** Hours (UTC start) in which the server reached a new all-time high of users. */
  recordHours: readonly number[];
  /** Owns a private channel of the private-channel module, since. */
  privateChannelAt: number | null;
  /** Vouched for a player in the invite flow of the proxy check, first time. */
  sponsorAt: number | null;
  /** Last seen with the TeamSpeak app for Android or iOS. */
  mobileAt: number | null;
}

export interface AchievementEvaluation {
  value: number;
  /** Per tier: when it was reached, or null. */
  reached: (number | null)[];
}

export interface AchievementDefinition {
  id: string;
  group: AchievementGroup;
  unit: AchievementUnit;
  /** Ascending thresholds, one per tier (in `unit`; a single 1 for yes/no achievements). */
  tiers: readonly number[];
  /** Shown as "???" until somebody has it. */
  secret: boolean;
  /** Needs live tracking (activity states); imported history has none. */
  liveOnly: boolean;
  evaluate(facts: PersonFacts): AchievementEvaluation;
}

const DAY_S = 86_400;
const H = HOUR_S;

/** Days since 1970-01-01 for a YYYYMMDD day (calendar arithmetic without time zones). */
export function dayNumber(day: number): number {
  return (
    Date.UTC(Math.floor(day / 10000), (Math.floor(day / 100) % 100) - 1, day % 100) / 1000 / DAY_S
  );
}

/** 0 = Sunday … 6 = Saturday. */
function weekday(day: number): number {
  return (dayNumber(day) + 4) % 7;
}

/**
 * For a running total that grows by `steps` (time, amount), when each threshold was reached.
 * `initial` counts from `initialAt` on (legacy time).
 */
export function crossings(
  thresholds: readonly number[],
  steps: Iterable<readonly [number, number]>,
  initial = 0,
  initialAt = 0,
): AchievementEvaluation {
  const reached: (number | null)[] = thresholds.map(() => null);
  let total = initial;
  const mark = (at: number) => {
    thresholds.forEach((threshold, i) => {
      if (reached[i] === null && total >= threshold) reached[i] = at;
    });
  };
  if (initial > 0) mark(initialAt);
  for (const [at, amount] of steps) {
    total += amount;
    mark(at);
  }
  return { value: total, reached };
}

/** Each threshold is reached at the n-th event (events ascending). */
function nth(thresholds: readonly number[], events: readonly number[]): AchievementEvaluation {
  return {
    value: events.length,
    reached: thresholds.map((n) => events[n - 1] ?? null),
  };
}

/** A yes/no achievement. */
function once(at: number | null, value = at === null ? 0 : 1): AchievementEvaluation {
  return { value, reached: [at] };
}

function* perDay(
  days: readonly DayFact[],
  pick: (day: DayFact) => number,
): Generator<[number, number]> {
  for (const day of days) {
    const amount = pick(day);
    if (amount > 0) yield [berlinDayStart(day.day), amount];
  }
}

/** A day counts for streaks with at least this much online time. */
export const STREAK_MIN_S = 15 * 60;

/** Longest run of consecutive days, and when each threshold was reached. */
export function dayStreak(
  thresholds: readonly number[],
  days: readonly DayFact[],
): AchievementEvaluation {
  const reached: (number | null)[] = thresholds.map(() => null);
  let best = 0;
  let current = 0;
  let previous: number | undefined;
  for (const day of days) {
    if (day.onlineS < STREAK_MIN_S) continue;
    const n = dayNumber(day.day);
    current = previous !== undefined && n === previous + 1 ? current + 1 : 1;
    previous = n;
    best = Math.max(best, current);
    thresholds.forEach((threshold, i) => {
      if (reached[i] === null && current >= threshold) reached[i] = berlinDayStart(day.day);
    });
  }
  return { value: best, reached };
}

/** Consecutive weekends (Saturday or Sunday) with a streak day. */
export function weekendStreak(
  thresholds: readonly number[],
  days: readonly DayFact[],
): AchievementEvaluation {
  const reached: (number | null)[] = thresholds.map(() => null);
  let best = 0;
  let current = 0;
  let previousWeek: number | undefined;
  for (const day of days) {
    if (day.onlineS < STREAK_MIN_S) continue;
    const wd = weekday(day.day);
    if (wd !== 0 && wd !== 6) continue;
    // Saturday and the following Sunday belong to the same weekend.
    const week = Math.floor((dayNumber(day.day) + (wd === 0 ? -1 : 0) + 4) / 7);
    if (week === previousWeek) continue;
    current = previousWeek !== undefined && week === previousWeek + 1 ? current + 1 : 1;
    previousWeek = week;
    best = Math.max(best, current);
    thresholds.forEach((threshold, i) => {
      if (reached[i] === null && current >= threshold) reached[i] = berlinDayStart(day.day);
    });
  }
  return { value: best, reached };
}

/** Back after at least this many days without a single minute online. */
export const COMEBACK_GAP_DAYS = 180;

function comeback(days: readonly DayFact[]): AchievementEvaluation {
  let longest = 0;
  let at: number | null = null;
  let previous: number | undefined;
  for (const day of days) {
    if (day.onlineS <= 0) continue;
    const n = dayNumber(day.day);
    if (previous !== undefined) {
      const gap = n - previous - 1;
      longest = Math.max(longest, gap);
      if (at === null && gap >= COMEBACK_GAP_DAYS) at = berlinDayStart(day.day);
    }
    previous = n;
  }
  return { value: longest, reached: [at] };
}

/** Seen again on or after the n-th anniversary of the first visit. */
function yearsOnServer(thresholds: readonly number[], facts: PersonFacts): AchievementEvaluation {
  const first = new Date(facts.firstSeen * 1000);
  const anniversary = (years: number) =>
    Date.UTC(
      first.getUTCFullYear() + years,
      first.getUTCMonth(),
      first.getUTCDate(),
      first.getUTCHours(),
      first.getUTCMinutes(),
      first.getUTCSeconds(),
    ) / 1000;
  const lastSession = facts.sessions.reduce((max, s) => Math.max(max, s.leaveAt), facts.firstSeen);
  const reached = thresholds.map((years) => {
    const due = anniversary(years);
    if (lastSession < due) return null;
    const session = facts.sessions.find((s) => s.leaveAt >= due);
    return session ? Math.max(due, session.joinAt) : null;
  });
  // Full years between the first visit and the last time seen.
  let value = 0;
  while (anniversary(value + 1) <= lastSession) value += 1;
  return { value, reached };
}

/** Berlin local time of day of `ts`, seconds after midnight. */
function localSecondOfDay(ts: number): number {
  return (((ts + berlinOffset(ts)) % DAY_S) + DAY_S) % DAY_S;
}

/** A session counts as a night session with at least this much time between 0 and 5 o'clock. */
export const NIGHT_MIN_S = 30 * 60;

function isNightSession(session: SessionFact): boolean {
  // Midnight of the join day, then every following midnight the session reaches.
  let midnight = session.joinAt - localSecondOfDay(session.joinAt);
  while (midnight < session.leaveAt) {
    const overlap =
      Math.min(session.leaveAt, midnight + 5 * H) - Math.max(session.joinAt, midnight);
    if (overlap >= NIGHT_MIN_S) return true;
    midnight += DAY_S;
  }
  return false;
}

function isEarlySession(session: SessionFact): boolean {
  const second = localSecondOfDay(session.joinAt);
  return second >= 5 * H && second < 7 * H;
}

function newYearMidnights(facts: PersonFacts): number[] {
  const first = facts.sessions[0];
  if (!first) return [];
  const last = facts.sessions.reduce((max, s) => Math.max(max, s.leaveAt), 0);
  const from = new Date(first.joinAt * 1000).getUTCFullYear();
  const to = new Date(last * 1000).getUTCFullYear() + 1;
  const result: number[] = [];
  for (let year = from; year <= to; year += 1) {
    const midnight = berlinDayStart(year * 10000 + 101);
    // Generous on both ends; the callers check the sessions themselves.
    if (midnight >= first.joinAt - DAY_S && midnight <= last + DAY_S) result.push(midnight);
  }
  return result;
}

function newYear(facts: PersonFacts): AchievementEvaluation {
  const hits = newYearMidnights(facts).filter((midnight) =>
    facts.sessions.some((s) => s.joinAt <= midnight && s.leaveAt > midnight),
  );
  return { value: hits.length, reached: [hits[0] ?? null] };
}

/** Connected within the first two minutes of a new year. */
function midnightJoin(facts: PersonFacts): AchievementEvaluation {
  const hit = newYearMidnights(facts).find((midnight) =>
    facts.sessions.some((s) => s.joinAt >= midnight && s.joinAt < midnight + 120),
  );
  return once(hit ?? null);
}

/** Online on a later anniversary of the first visit (29 February counts on 28 February). */
function anniversaryVisit(facts: PersonFacts): AchievementEvaluation {
  const first = berlinDay(facts.firstSeen);
  const firstDay = dayNumber(first);
  const month = Math.floor(first / 100) % 100;
  const dom = first % 100;
  const hits = facts.days.filter((d) => {
    if (d.onlineS <= 0 || dayNumber(d.day) <= firstDay) return false;
    const m = Math.floor(d.day / 100) % 100;
    const dd = d.day % 100;
    if (m !== month) return false;
    if (dd === dom) return true;
    // Leap day: in other years the 28th is the day.
    const year = Math.floor(d.day / 10000);
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return month === 2 && dom === 29 && !leap && dd === 28;
  });
  return { value: hits.length, reached: [hits[0] ? berlinDayStart(hits[0].day) : null] };
}

function recordNight(facts: PersonFacts): AchievementEvaluation {
  const hits = facts.recordHours.filter((hour) =>
    facts.sessions.some((s) => s.joinAt < hour + H && s.leaveAt > hour),
  );
  return { value: hits.length, reached: [hits[0] ?? null] };
}

/**
 * Thresholds of time-based achievements are in seconds, so the catalog reads like the UI
 * (`hours(100)` = 100 h) while the database keeps its convention.
 */
const hours = (...values: number[]) => values.map((v) => v * H);

/** Bumped whenever thresholds change, so the job re-evaluates everybody once. */
export const CATALOG_VERSION = 1;

export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  {
    id: 'regular',
    group: 'playtime',
    unit: 'seconds',
    tiers: hours(10, 100, 500, 1000, 2500),
    secret: false,
    liveOnly: false,
    evaluate(facts) {
      return crossings(
        this.tiers,
        perDay(facts.days, (d) => d.rankS),
        facts.legacyS,
        facts.legacyAt,
      );
    },
  },
  {
    id: 'active',
    group: 'playtime',
    unit: 'seconds',
    tiers: hours(50, 250, 1000),
    secret: false,
    liveOnly: true,
    evaluate(facts) {
      return crossings(
        this.tiers,
        perDay(facts.days, (d) => d.activeS),
      );
    },
  },
  {
    id: 'years',
    group: 'loyalty',
    unit: 'years',
    tiers: [1, 2, 5, 10],
    secret: false,
    liveOnly: false,
    evaluate(facts) {
      return yearsOnServer(this.tiers, facts);
    },
  },
  {
    id: 'pioneer',
    group: 'loyalty',
    unit: 'count',
    tiers: [1],
    secret: false,
    liveOnly: false,
    evaluate: (facts) => once(facts.pioneer ? facts.firstSeen : null),
  },
  {
    id: 'legacy',
    group: 'loyalty',
    unit: 'count',
    tiers: [1],
    secret: false,
    liveOnly: false,
    evaluate: (facts) => once(facts.legacyS > 0 ? facts.legacyAt : null),
  },
  {
    id: 'comeback',
    group: 'loyalty',
    unit: 'days',
    tiers: [COMEBACK_GAP_DAYS],
    secret: false,
    liveOnly: false,
    evaluate: (facts) => comeback(facts.days),
  },
  {
    id: 'streak',
    group: 'streak',
    unit: 'days',
    tiers: [7, 30, 100],
    secret: false,
    liveOnly: false,
    evaluate(facts) {
      return dayStreak(this.tiers, facts.days);
    },
  },
  {
    id: 'weekend',
    group: 'streak',
    unit: 'count',
    tiers: [10],
    secret: false,
    liveOnly: false,
    evaluate(facts) {
      return weekendStreak(this.tiers, facts.days);
    },
  },
  {
    id: 'marathon',
    group: 'session',
    unit: 'seconds',
    tiers: hours(4, 8, 12),
    secret: false,
    liveOnly: false,
    evaluate(facts) {
      const reached = this.tiers.map((threshold) => {
        const day = facts.days.find((d) => d.longestSessionS >= threshold);
        return day ? berlinDayStart(day.day) : null;
      });
      const value = facts.days.reduce((max, d) => Math.max(max, d.longestSessionS), 0);
      return { value, reached };
    },
  },
  {
    id: 'night-owl',
    group: 'time',
    unit: 'count',
    tiers: [25],
    secret: false,
    liveOnly: false,
    evaluate(facts) {
      return nth(
        this.tiers,
        facts.sessions.filter(isNightSession).map((s) => s.joinAt),
      );
    },
  },
  {
    id: 'early-bird',
    group: 'time',
    unit: 'count',
    tiers: [25],
    secret: false,
    liveOnly: false,
    evaluate(facts) {
      return nth(
        this.tiers,
        facts.sessions.filter(isEarlySession).map((s) => s.joinAt),
      );
    },
  },
  {
    id: 'new-year',
    group: 'time',
    unit: 'count',
    tiers: [1],
    secret: false,
    liveOnly: false,
    evaluate: newYear,
  },
  {
    id: 'anniversary',
    group: 'time',
    unit: 'count',
    tiers: [1],
    secret: false,
    liveOnly: false,
    evaluate: anniversaryVisit,
  },
  {
    id: 'sociable',
    group: 'social',
    unit: 'count',
    tiers: [10, 25, 50],
    secret: false,
    liveOnly: true,
    evaluate(facts) {
      const value = facts.contactSeconds.filter((s) => s >= H).length;
      return { value, reached: this.tiers.map((n) => (value >= n ? facts.now : null)) };
    },
  },
  {
    id: 'inseparable',
    group: 'social',
    unit: 'seconds',
    tiers: hours(250),
    secret: false,
    liveOnly: true,
    evaluate(facts) {
      const value = facts.contactSeconds.reduce((max, s) => Math.max(max, s), 0);
      return { value, reached: this.tiers.map((t) => (value >= t ? facts.now : null)) };
    },
  },
  {
    id: 'record-night',
    group: 'social',
    unit: 'count',
    tiers: [1],
    secret: false,
    liveOnly: false,
    evaluate: recordNight,
  },
  {
    id: 'sponsor',
    group: 'social',
    unit: 'count',
    tiers: [1],
    secret: false,
    liveOnly: true,
    evaluate: (facts) => once(facts.sponsorAt),
  },
  {
    id: 'explorer',
    group: 'server',
    unit: 'count',
    tiers: [25],
    secret: false,
    liveOnly: true,
    evaluate(facts) {
      return nth(this.tiers, facts.channelFirstSeen);
    },
  },
  {
    id: 'summit',
    group: 'server',
    unit: 'count',
    tiers: [1],
    secret: false,
    liveOnly: false,
    evaluate: (facts) => once(facts.topRankAt),
  },
  {
    id: 'landlord',
    group: 'server',
    unit: 'count',
    tiers: [1],
    secret: false,
    liveOnly: true,
    evaluate: (facts) => once(facts.privateChannelAt),
  },
  {
    id: 'mobile',
    group: 'server',
    unit: 'count',
    tiers: [1],
    secret: false,
    liveOnly: true,
    evaluate: (facts) => once(facts.mobileAt),
  },
  {
    id: 'midnight',
    group: 'secret',
    unit: 'count',
    tiers: [1],
    secret: true,
    liveOnly: false,
    evaluate: midnightJoin,
  },
  {
    id: 'jubilee',
    group: 'secret',
    unit: 'count',
    tiers: [1000],
    secret: true,
    liveOnly: false,
    evaluate(facts) {
      return crossings(
        this.tiers,
        perDay(facts.days, (d) => d.sessions),
      );
    },
  },
  {
    id: 'nicknames',
    group: 'secret',
    unit: 'count',
    tiers: [10],
    secret: true,
    liveOnly: false,
    evaluate(facts) {
      return nth(this.tiers, facts.nicknameFirstSeen);
    },
  },
  {
    id: 'sleepyhead',
    group: 'secret',
    unit: 'seconds',
    tiers: hours(100),
    secret: true,
    liveOnly: true,
    evaluate(facts) {
      return crossings(
        this.tiers,
        perDay(facts.days, (d) => d.afkS),
      );
    },
  },
];

export const ACHIEVEMENT_IDS = ACHIEVEMENTS.map((a) => a.id);

export function achievementById(id: string): AchievementDefinition | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}

export interface ReachedTier {
  achievementId: string;
  /** 1-based. */
  tier: number;
  at: number;
}

/** Every tier the person has reached, of the given achievements (all when omitted). */
export function evaluateAchievements(
  facts: PersonFacts,
  achievements: readonly AchievementDefinition[] = ACHIEVEMENTS,
): ReachedTier[] {
  const result: ReachedTier[] = [];
  for (const achievement of achievements) {
    const { reached } = achievement.evaluate(facts);
    reached.forEach((at, i) => {
      if (at !== null) result.push({ achievementId: achievement.id, tier: i + 1, at });
    });
  }
  return result;
}

/** How far a person is: value now and the threshold of the next tier (null = all reached). */
export interface AchievementProgress {
  achievementId: string;
  value: number;
  nextThreshold: number | null;
}

export function achievementProgress(
  facts: PersonFacts,
  achievements: readonly AchievementDefinition[] = ACHIEVEMENTS,
): AchievementProgress[] {
  return achievements.map((achievement) => {
    const { value, reached } = achievement.evaluate(facts);
    const next = reached.findIndex((at) => at === null);
    return {
      achievementId: achievement.id,
      value,
      nextThreshold: next === -1 ? null : (achievement.tiers[next] ?? null),
    };
  });
}

/** Facts of a person who has done nothing yet; tests and callers override what they need. */
export function emptyFacts(now: number, firstSeen = now): PersonFacts {
  return {
    now,
    firstSeen,
    legacyS: 0,
    legacyAt: firstSeen,
    days: [],
    sessions: [],
    channelFirstSeen: [],
    nicknameFirstSeen: [],
    contactSeconds: [],
    pioneer: false,
    topRankAt: null,
    recordHours: [],
    privateChannelAt: null,
    sponsorAt: null,
    mobileAt: null,
  };
}
