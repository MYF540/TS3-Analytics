import { describe, expect, it } from 'vitest';
import {
  adoptable,
  numberedName,
  planPool,
  rankOf,
  type PoolChannel,
  type PoolRules,
} from './channel-pool.js';

const talk: PoolRules = {
  naming: { kind: 'numbered', prefix: 'Talk' },
  minFree: 1,
  maxChannels: 10,
};

let nextCid = 100;
function channel(name: string, clients = 0, managed = true, order = 0): PoolChannel {
  return { cid: nextCid++, name, order, clients, managed };
}

describe('planPool', () => {
  it('creates the first channel in an empty area', () => {
    expect(planPool([], talk)).toEqual({ create: [{ name: 'Talk 1', order: 0 }], delete: [] });
  });

  it('adds a channel once every managed one is occupied', () => {
    const one = channel('Talk 1', 2);
    expect(planPool([one], talk)).toEqual({
      create: [{ name: 'Talk 2', order: one.cid }],
      delete: [],
    });
  });

  it('does nothing while exactly the wanted number is free', () => {
    expect(planPool([channel('Talk 1', 2), channel('Talk 2')], talk)).toEqual({
      create: [],
      delete: [],
    });
  });

  it('removes surplus empty channels, the highest numbers first', () => {
    const channels = [
      channel('Talk 1'),
      channel('Talk 2', 1),
      channel('Talk 3'),
      channel('Talk 4'),
    ];
    expect(planPool(channels, talk).delete).toEqual([channels[3]?.cid, channels[2]?.cid]);
  });

  it('fills a gap in the numbering before counting on', () => {
    const one = channel('Talk 1', 1);
    const three = channel('Talk 3', 1, true, one.cid);
    expect(planPool([one, three], talk).create).toEqual([{ name: 'Talk 2', order: one.cid }]);
  });

  it('never deletes or reuses a channel it does not manage', () => {
    const foreign = channel('Talk 1', 0, false);
    const other = channel('Besprechung', 0, false, foreign.cid);
    const plan = planPool([foreign, other], talk);
    expect(plan.delete).toEqual([]);
    // "Talk 1" is taken; the new channel goes to the end of the area.
    expect(plan.create).toEqual([{ name: 'Talk 2', order: other.cid }]);
  });

  it('keeps several channels free when asked to', () => {
    const plan = planPool([channel('Talk 1', 1)], { ...talk, minFree: 3 });
    expect(plan.create.map((c) => c.name)).toEqual(['Talk 2', 'Talk 3', 'Talk 4']);
  });

  it('stops at the upper bound', () => {
    const full = [channel('Talk 1', 1), channel('Talk 2', 1)];
    expect(planPool(full, { ...talk, maxChannels: 2 }).create).toEqual([]);
    expect(planPool(full, { ...talk, minFree: 3, maxChannels: 3 }).create).toHaveLength(1);
  });

  it('takes names from a list and stops when the list is used up', () => {
    const rules: PoolRules = {
      naming: { kind: 'list', names: ['Rot', 'Grün', 'Blau'] },
      minFree: 1,
      maxChannels: 10,
    };
    const red = channel('Rot', 1);
    expect(planPool([red], rules).create).toEqual([{ name: 'Grün', order: red.cid }]);
    const all = [red, channel('Grün', 1), channel('Blau', 1)];
    expect(planPool(all, rules).create).toEqual([]);
    const spare = [channel('Rot'), channel('Grün'), channel('Blau', 1)];
    expect(planPool(spare, rules).delete).toEqual([spare[1]?.cid]);
  });
});

describe('naming', () => {
  it('recognises numbered names of the area only', () => {
    const naming = { kind: 'numbered', prefix: 'Talk' } as const;
    expect(rankOf('Talk 12', naming)).toBe(12);
    expect(rankOf('Talk 0', naming)).toBeUndefined();
    expect(rankOf('Talk 1a', naming)).toBeUndefined();
    expect(rankOf('Talkrunde 1', naming)).toBeUndefined();
    expect(rankOf('Express Talk 1', naming)).toBeUndefined();
  });

  it('keeps names within the server limit', () => {
    expect(numberedName('x'.repeat(50), 3)).toHaveLength(40);
  });

  it('offers unmanaged channels that fit the scheme for adoption', () => {
    const channels = [
      channel('Talk 1', 0, false),
      channel('Talk 2', 0, true),
      channel('Lobby', 0, false),
    ];
    expect(adoptable(channels, talk.naming).map((c) => c.name)).toEqual(['Talk 1']);
  });
});
