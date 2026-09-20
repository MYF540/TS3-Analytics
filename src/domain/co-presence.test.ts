import { describe, expect, it } from 'vitest';
import { buildCoPresence, type CoPresenceSegment } from './co-presence.js';

const T0 = 1_700_000_000;
const H = 3600;
const WINDOW = { from: T0, to: T0 + 30 * 86_400 };
const OPTIONS = { ...WINDOW, minEncounterS: 0, minPairS: 0 };

function seg(subject: number, channelId: number, startAt: number, seconds: number) {
  return { subject, channelId, startAt, endAt: startAt + seconds };
}

/** The sweep line needs its input ordered, just like the query delivers it. */
function ordered(...segments: CoPresenceSegment[]): CoPresenceSegment[] {
  return [...segments].sort((a, b) => a.startAt - b.startAt);
}

describe('buildCoPresence', () => {
  it('counts the overlap of two players in the same channel', () => {
    const result = buildCoPresence(
      ordered(seg(1, 5, T0, 2 * H), seg(2, 5, T0 + H, 2 * H)),
      OPTIONS,
    );
    expect(result.edges).toEqual([{ a: 1, b: 2, seconds: H, encounters: 1 }]);
    expect(result.nodes.get(1)).toBe(2 * H);
    expect(result.nodes.get(2)).toBe(2 * H);
  });

  it('ignores players in different channels at the same time', () => {
    const result = buildCoPresence(ordered(seg(1, 5, T0, 2 * H), seg(2, 6, T0, 2 * H)), OPTIONS);
    expect(result.edges).toEqual([]);
    expect(result.nodes.size).toBe(2);
  });

  it('does not connect segments that only touch', () => {
    const result = buildCoPresence(ordered(seg(1, 5, T0, H), seg(2, 5, T0 + H, H)), OPTIONS);
    expect(result.edges).toEqual([]);
  });

  it('adds up several encounters of the same pair', () => {
    const result = buildCoPresence(
      ordered(
        seg(1, 5, T0, H),
        seg(2, 5, T0, H),
        seg(1, 5, T0 + 86_400, 2 * H),
        seg(2, 5, T0 + 86_400, 2 * H),
      ),
      OPTIONS,
    );
    expect(result.edges).toEqual([{ a: 1, b: 2, seconds: 3 * H, encounters: 2 }]);
  });

  it('connects everybody in a channel with everybody else', () => {
    const result = buildCoPresence(
      ordered(seg(1, 5, T0, 3 * H), seg(2, 5, T0, 3 * H), seg(3, 5, T0, 3 * H)),
      OPTIONS,
    );
    expect(result.edges.map((e) => [e.a, e.b, e.seconds])).toEqual([
      [1, 2, 3 * H],
      [1, 3, 3 * H],
      [2, 3, 3 * H],
    ]);
  });

  it('keeps the pair the same no matter who was there first', () => {
    const result = buildCoPresence(ordered(seg(9, 5, T0, 2 * H), seg(4, 5, T0 + H, H)), OPTIONS);
    expect(result.edges[0]).toMatchObject({ a: 4, b: 9 });
  });

  it('never links a person with itself (two accounts of one player)', () => {
    const result = buildCoPresence(ordered(seg(1, 5, T0, 2 * H), seg(1, 5, T0, 2 * H)), OPTIONS);
    expect(result.edges).toEqual([]);
    // Both segments still count towards the node – the double counting is explained in the UI.
    expect(result.nodes.get(1)).toBe(4 * H);
  });

  it('clips segments to the window', () => {
    const result = buildCoPresence(
      ordered(seg(1, 5, T0 - 2 * H, 4 * H), seg(2, 5, T0 - H, 4 * H)),
      OPTIONS,
    );
    expect(result.nodes.get(1)).toBe(2 * H);
    expect(result.edges[0]?.seconds).toBe(2 * H);
  });

  it('leaves out segments that are completely outside the window', () => {
    const result = buildCoPresence(
      ordered(seg(1, 5, T0 - 10 * H, H), seg(2, 5, T0 - 10 * H, H)),
      OPTIONS,
    );
    expect(result.nodes.size).toBe(0);
    expect(result.edges).toEqual([]);
  });

  it('drops encounters that are too short and counts them', () => {
    const result = buildCoPresence(
      ordered(
        seg(1, 5, T0, H),
        seg(2, 5, T0 + H - 60, H), // only one minute with player 1
        seg(3, 6, T0, H),
        seg(4, 6, T0, H), // a full hour in another channel
      ),
      { ...OPTIONS, minEncounterS: 300 },
    );
    expect(result.edges.map((e) => [e.a, e.b])).toEqual([[3, 4]]);
    expect(result.droppedEncounters).toBe(1);
  });

  it('drops pairs below the minimum total and counts them', () => {
    const result = buildCoPresence(
      ordered(seg(1, 5, T0, 10 * 60), seg(2, 5, T0, 10 * 60), seg(3, 5, T0, 10 * 60)),
      { ...OPTIONS, minPairS: H },
    );
    expect(result.edges).toEqual([]);
    expect(result.droppedPairs).toBe(3);
  });

  it('sorts the strongest pair first', () => {
    const result = buildCoPresence(
      ordered(seg(1, 5, T0, 3 * H), seg(2, 5, T0, 3 * H), seg(3, 6, T0, H), seg(4, 6, T0, H)),
      OPTIONS,
    );
    expect(result.edges.map((e) => e.seconds)).toEqual([3 * H, H]);
  });

  it('handles many people in one channel without losing a pair', () => {
    const segments = ordered(...Array.from({ length: 20 }, (_, i) => seg(i + 1, 5, T0 + i, 2 * H)));
    const result = buildCoPresence(segments, OPTIONS);
    expect(result.edges).toHaveLength((20 * 19) / 2);
  });

  it('refuses input that is not ordered by time', () => {
    expect(() => buildCoPresence([seg(1, 5, T0 + H, H), seg(2, 5, T0, H)], OPTIONS)).toThrow(
      /ordered/,
    );
  });
});
