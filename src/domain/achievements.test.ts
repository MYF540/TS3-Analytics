import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENTS,
  achievementById,
  achievementProgress,
  crossings,
  dayNumber,
  emptyFacts,
  evaluateAchievements,
  type AchievementEvaluation,
  type DayFact,
  type PersonFacts,
  type SessionFact,
} from './achievements.js';
import { berlinDay, berlinDayStart, nextDay } from './time.js';

const H = 3600;
const DAY = 86_400;
const NOW = berlinDayStart(20261016) + 12 * H;

function day(dayValue: number, extra: Partial<DayFact> = {}): DayFact {
  return {
    day: dayValue,
    onlineS: H,
    rankS: H,
    activeS: 0,
    afkS: 0,
    sessions: 1,
    longestSessionS: H,
    ...extra,
  };
}

/** `count` consecutive days starting at `from`, each with `extra`. */
function days(from: number, count: number, extra: Partial<DayFact> = {}): DayFact[] {
  const result: DayFact[] = [];
  let d = from;
  for (let i = 0; i < count; i += 1) {
    result.push(day(d, extra));
    d = nextDay(d);
  }
  return result;
}

/** A session at Berlin local time `hh:mm` on `dayValue`, lasting `seconds`. */
function session(dayValue: number, hh: number, mm: number, seconds: number): SessionFact {
  const joinAt = berlinDayStart(dayValue) + hh * H + mm * 60;
  return { joinAt, leaveAt: joinAt + seconds };
}

function facts(extra: Partial<PersonFacts> = {}): PersonFacts {
  return { ...emptyFacts(NOW, berlinDayStart(20200101)), ...extra };
}

function evaluate(id: string, input: PersonFacts): AchievementEvaluation {
  const achievement = achievementById(id);
  if (!achievement) throw new Error(id);
  return achievement.evaluate(input);
}

const tiersOf = (id: string, input: PersonFacts) =>
  evaluate(id, input).reached.map((at) => at !== null);

describe('catalog', () => {
  it('has unique ids and ascending thresholds', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ACHIEVEMENTS) {
      expect(a.tiers.length, a.id).toBeGreaterThan(0);
      for (let i = 1; i < a.tiers.length; i += 1) {
        expect(a.tiers[i], a.id).toBeGreaterThan(a.tiers[i - 1] ?? 0);
      }
      expect(a.secret, a.id).toBe(a.group === 'secret');
    }
  });

  it('gives nothing to a person without any activity', () => {
    expect(evaluateAchievements(emptyFacts(NOW))).toEqual([]);
  });
});

describe('crossings', () => {
  it('reaches a threshold exactly, not one second below', () => {
    expect(crossings([10], [[100, 9]]).reached).toEqual([null]);
    expect(crossings([10], [[100, 10]]).reached).toEqual([100]);
    expect(
      crossings(
        [10, 20],
        [
          [100, 9],
          [200, 15],
        ],
      ).reached,
    ).toEqual([200, 200]);
  });

  it('counts the initial amount from its own time on', () => {
    expect(crossings([10, 20], [[500, 5]], 12, 50)).toEqual({ value: 17, reached: [50, null] });
  });
});

describe('playtime', () => {
  it('Stammgast counts ranking time, including legacy time', () => {
    const below = facts({ days: days(20260101, 9, { rankS: H }) });
    expect(tiersOf('regular', below)).toEqual([false, false, false, false, false]);
    const exact = facts({ days: days(20260101, 10, { rankS: H }) });
    expect(evaluate('regular', exact).reached[0]).toBe(berlinDayStart(20260110));

    const legacy = facts({
      legacyS: 100 * H,
      legacyAt: 1_700_000_000,
      days: days(20260101, 1, { rankS: H }),
    });
    const result = evaluate('regular', legacy);
    expect(result.value).toBe(101 * H);
    expect(result.reached.slice(0, 3)).toEqual([1_700_000_000, 1_700_000_000, null]);
  });

  it('Stammgast ignores imported time (it has no ranking time)', () => {
    const imported = facts({ days: days(20200101, 30, { onlineS: 10 * H, rankS: 0 }) });
    expect(evaluate('regular', imported).value).toBe(0);
  });

  it('Aktivposten counts only active time', () => {
    const input = facts({ days: days(20260101, 50, { activeS: H, rankS: 2 * H }) });
    expect(tiersOf('active', input)).toEqual([true, false, false]);
    expect(evaluate('active', input).reached[0]).toBe(berlinDayStart(20260219));
  });
});

describe('loyalty', () => {
  const firstSeen = berlinDayStart(20200310) + 18 * H;

  it('Urgestein needs a visit on or after the anniversary', () => {
    const before = facts({ firstSeen, sessions: [session(20210309, 18, 0, H)] });
    expect(tiersOf('years', before)).toEqual([false, false, false, false]);
    const after = facts({ firstSeen, sessions: [session(20210311, 18, 0, H)] });
    expect(evaluate('years', after).reached[0]).toBe(berlinDayStart(20210311) + 18 * H);
    expect(evaluate('years', after).value).toBe(1);
    const fiveYears = facts({ firstSeen, sessions: [session(20250401, 18, 0, H)] });
    expect(tiersOf('years', fiveYears)).toEqual([true, true, true, false]);
  });

  it('Urgestein counts a session that runs over the anniversary', () => {
    const over = facts({ firstSeen, sessions: [session(20210310, 17, 0, 2 * H)] });
    expect(evaluate('years', over).reached[0]).toBe(firstSeen + 365 * DAY);
  });

  it('Pionier and Veteran are flags', () => {
    expect(tiersOf('pioneer', facts())).toEqual([false]);
    expect(evaluate('pioneer', facts({ pioneer: true })).reached).toEqual([
      berlinDayStart(20200101),
    ]);
    expect(evaluate('legacy', facts({ legacyS: 1, legacyAt: 123 })).reached).toEqual([123]);
  });

  it('Comeback needs a pause of 180 full days', () => {
    const almost = facts({ days: [day(20250101), day(dayAfter(20250101, 180))] });
    expect(evaluate('comeback', almost)).toEqual({ value: 179, reached: [null] });
    const back = facts({ days: [day(20250101), day(dayAfter(20250101, 181))] });
    expect(evaluate('comeback', back)).toEqual({
      value: 180,
      reached: [berlinDayStart(dayAfter(20250101, 181))],
    });
  });
});

function dayAfter(start: number, n: number): number {
  return berlinDay(berlinDayStart(start) + n * DAY + 12 * H);
}

describe('streaks', () => {
  it('Dauerbrenner counts consecutive days with at least 15 minutes', () => {
    expect(tiersOf('streak', facts({ days: days(20260101, 6) }))).toEqual([false, false, false]);
    const seven = facts({ days: days(20260101, 7) });
    expect(evaluate('streak', seven)).toEqual({
      value: 7,
      reached: [berlinDayStart(20260107), null, null],
    });
    // A short day breaks the streak.
    const broken = facts({
      days: [...days(20260101, 3), day(20260104, { onlineS: 14 * 60 }), ...days(20260105, 4)],
    });
    expect(evaluate('streak', broken).value).toBe(4);
  });

  it('Dauerbrenner runs across month, year and DST boundaries', () => {
    expect(evaluate('streak', facts({ days: days(20251225, 30) })).value).toBe(30);
    expect(evaluate('streak', facts({ days: days(20260320, 14) })).value).toBe(14);
  });

  it('Wochenendkrieger counts consecutive weekends once each', () => {
    // 2026-01-03 is a Saturday.
    const weekends = (count: number) =>
      Array.from({ length: count }, (_, i) => [
        day(dayAfter(20260103, i * 7)),
        day(dayAfter(20260103, i * 7 + 1)),
      ]).flat();
    expect(evaluate('weekend', facts({ days: weekends(9) }))).toMatchObject({
      value: 9,
      reached: [null],
    });
    expect(evaluate('weekend', facts({ days: weekends(10) })).reached[0]).toBe(
      berlinDayStart(dayAfter(20260103, 63)),
    );
    // Weekdays do not count, a skipped weekend breaks the run.
    const gap = [...weekends(3), day(dayAfter(20260103, 35))];
    expect(evaluate('weekend', facts({ days: gap })).value).toBe(3);
    expect(evaluate('weekend', facts({ days: days(20260105, 5) })).value).toBe(0);
  });

  it('weekday arithmetic matches the calendar', () => {
    expect(dayNumber(19700101)).toBe(0);
    expect(dayNumber(20260103) - dayNumber(20260101)).toBe(2);
  });
});

describe('sessions and times of day', () => {
  it('Marathon uses the longest session of a day', () => {
    const input = facts({
      days: [
        day(20260101, { longestSessionS: 4 * H - 1 }),
        day(20260102, { longestSessionS: 8 * H }),
      ],
    });
    expect(evaluate('marathon', input)).toEqual({
      value: 8 * H,
      reached: [berlinDayStart(20260102), berlinDayStart(20260102), null],
    });
  });

  it('Nachteule counts sessions with 30 minutes between 0 and 5 o’clock Berlin time', () => {
    const nights = (count: number, hh: number, mm: number, seconds: number) =>
      Array.from({ length: count }, (_, i) => session(dayAfter(20260105, i), hh, mm, seconds));
    expect(evaluate('night-owl', facts({ sessions: nights(25, 4, 31, H) })).value).toBe(0);
    expect(evaluate('night-owl', facts({ sessions: nights(25, 4, 30, H) })).value).toBe(25);
    // Starting the evening before and staying past midnight counts too.
    const late = nights(25, 23, 0, 2 * H);
    expect(evaluate('night-owl', facts({ sessions: late })).reached[0]).toBe(late[24]?.joinAt);
    expect(evaluate('night-owl', facts({ sessions: nights(24, 1, 0, H) })).reached).toEqual([null]);
  });

  it('Nachteule uses Berlin time in summer and winter', () => {
    const summer = session(20260715, 0, 0, H);
    const winter = session(20260115, 0, 0, H);
    const result = evaluate('night-owl', facts({ sessions: [winter, summer] }));
    expect(result.value).toBe(2);
    // 23:00 local in summer is 21:00 UTC: not a night session.
    const evening = session(20260715, 22, 0, H);
    expect(evaluate('night-owl', facts({ sessions: [evening] })).value).toBe(0);
  });

  it('Frühaufsteher counts joins between 5 and 7 o’clock', () => {
    const at = (hh: number, mm: number) =>
      Array.from({ length: 25 }, (_, i) => session(dayAfter(20260301, i), hh, mm, H));
    expect(evaluate('early-bird', facts({ sessions: at(4, 59) })).value).toBe(0);
    expect(evaluate('early-bird', facts({ sessions: at(5, 0) })).value).toBe(25);
    expect(evaluate('early-bird', facts({ sessions: at(6, 59) })).value).toBe(25);
    expect(evaluate('early-bird', facts({ sessions: at(7, 0) })).value).toBe(0);
  });

  it('Silvester needs to be online at midnight', () => {
    const midnight = berlinDayStart(20260101);
    const over = facts({ sessions: [{ joinAt: midnight - H, leaveAt: midnight + 60 }] });
    expect(evaluate('new-year', over).reached).toEqual([midnight]);
    const left = facts({ sessions: [{ joinAt: midnight - H, leaveAt: midnight }] });
    expect(evaluate('new-year', left).reached).toEqual([null]);
  });

  it('the secret midnight achievement needs a join in the first two minutes', () => {
    const midnight = berlinDayStart(20260101);
    expect(
      evaluate('midnight', facts({ sessions: [{ joinAt: midnight + 119, leaveAt: midnight + H }] }))
        .reached,
    ).toEqual([midnight]);
    expect(
      evaluate('midnight', facts({ sessions: [{ joinAt: midnight + 120, leaveAt: midnight + H }] }))
        .reached,
    ).toEqual([null]);
  });

  it('Geburtstagskind needs a visit on a later anniversary of the first day', () => {
    const firstSeen = berlinDayStart(20240310) + 20 * H;
    const sameDay = facts({ firstSeen, days: [day(20240310)] });
    expect(evaluate('anniversary', sameDay).reached).toEqual([null]);
    const later = facts({ firstSeen, days: [day(20240310), day(20250309), day(20250310)] });
    expect(evaluate('anniversary', later).reached).toEqual([berlinDayStart(20250310)]);
  });

  it('Geburtstagskind of a leap day counts on 28 February', () => {
    const firstSeen = berlinDayStart(20240229) + 20 * H;
    const input = facts({ firstSeen, days: [day(20250228)] });
    expect(evaluate('anniversary', input).reached).toEqual([berlinDayStart(20250228)]);
  });
});

describe('social and server', () => {
  it('Gesellig counts partners with at least one hour together', () => {
    const contacts = [...Array.from({ length: 9 }, () => H), H - 1];
    expect(evaluate('sociable', facts({ contactSeconds: contacts })).value).toBe(9);
    const ten = facts({ contactSeconds: [...contacts, H] });
    expect(evaluate('sociable', ten).reached).toEqual([NOW, null, null]);
  });

  it('Unzertrennlich needs 250 hours with the same person', () => {
    expect(tiersOf('inseparable', facts({ contactSeconds: [249 * H, 249 * H] }))).toEqual([false]);
    expect(tiersOf('inseparable', facts({ contactSeconds: [250 * H] }))).toEqual([true]);
  });

  it('Rekordnacht needs a session in a record hour', () => {
    const hour = berlinDayStart(20260301) + 20 * H;
    const input = (joinAt: number, leaveAt: number) =>
      facts({ recordHours: [hour], sessions: [{ joinAt, leaveAt }] });
    expect(evaluate('record-night', input(hour - H, hour)).reached).toEqual([null]);
    expect(evaluate('record-night', input(hour + H - 1, hour + 2 * H)).reached).toEqual([hour]);
  });

  it('Weltenbummler is reached with the 25th channel', () => {
    const channels = Array.from({ length: 25 }, (_, i) => 1000 + i);
    expect(
      evaluate('explorer', facts({ channelFirstSeen: channels.slice(0, 24) })).reached,
    ).toEqual([null]);
    expect(evaluate('explorer', facts({ channelFirstSeen: channels })).reached).toEqual([1024]);
  });

  it('flags from other modules carry their own date', () => {
    expect(evaluate('summit', facts({ topRankAt: 5 })).reached).toEqual([5]);
    expect(evaluate('landlord', facts({ privateChannelAt: 6 })).reached).toEqual([6]);
    expect(evaluate('sponsor', facts({ sponsorAt: 7 })).reached).toEqual([7]);
    expect(evaluate('mobile', facts({ mobileAt: 8 })).reached).toEqual([8]);
  });

  it('secret achievements: sessions, nicknames, AFK time', () => {
    const many = facts({ days: days(20240101, 100, { sessions: 10 }) });
    expect(evaluate('jubilee', many).reached).toEqual([berlinDayStart(dayAfter(20240101, 99))]);
    const nicks = Array.from({ length: 10 }, (_, i) => 100 + i);
    expect(evaluate('nicknames', facts({ nicknameFirstSeen: nicks })).reached).toEqual([109]);
    expect(tiersOf('sleepyhead', facts({ days: days(20240101, 99, { afkS: H }) }))).toEqual([
      false,
    ]);
  });
});

describe('evaluateAchievements and progress', () => {
  it('lists every reached tier with its time', () => {
    const input = facts({
      firstSeen: berlinDayStart(20260101),
      days: days(20260101, 7, { rankS: 2 * H }),
    });
    expect(evaluateAchievements(input)).toEqual([
      { achievementId: 'regular', tier: 1, at: berlinDayStart(20260105) },
      { achievementId: 'streak', tier: 1, at: berlinDayStart(20260107) },
    ]);
  });

  it('reports the next threshold, or null when everything is reached', () => {
    const input = facts({ days: days(20260101, 7, { rankS: 2 * H }) });
    const progress = achievementProgress(input);
    expect(progress.find((p) => p.achievementId === 'regular')).toEqual({
      achievementId: 'regular',
      value: 14 * H,
      nextThreshold: 100 * H,
    });
    const pioneer = achievementProgress(facts({ pioneer: true })).find(
      (p) => p.achievementId === 'pioneer',
    );
    expect(pioneer?.nextThreshold).toBeNull();
  });
});
