import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../client.js';
import { createTestDatabase } from '../testing.js';
import {
  getPersonOfUser,
  linkUsers,
  PersonLinkError,
  personUserIds,
  setPrimaryUser,
  unlinkUser,
} from './persons.js';
import { recordNickname, upsertUser } from './users.js';

let database: AppDatabase;
let a: number;
let b: number;
let c: number;
let d: number;

beforeEach(() => {
  database = createTestDatabase();
  [a, b, c, d] = ['A', 'B', 'C', 'D'].map((name, i) => {
    const id = upsertUser(database.db, { uid: `${name}=`, seenAt: 1000 });
    recordNickname(database.db, id, `Nick${name}`, 1000 + i);
    return id;
  }) as [number, number, number, number];
});

afterEach(() => {
  database.close();
});

const members = (userId: number) =>
  getPersonOfUser(database.sqlite, userId)?.members.map((m) => m.userId);

describe('persons', () => {
  it('creates a person with the first user as primary', () => {
    const id = linkUsers(database.sqlite, a, b, 'mod', 100);
    expect(getPersonOfUser(database.sqlite, b)).toEqual({
      id,
      primaryUserId: a,
      members: [
        { userId: a, uid: 'A=', nickname: 'NickA', addedAt: 100, addedBy: 'mod' },
        { userId: b, uid: 'B=', nickname: 'NickB', addedAt: 100, addedBy: 'mod' },
      ],
    });
    expect(personUserIds(database.sqlite, b)).toEqual([a, b]);
    expect(personUserIds(database.sqlite, c)).toEqual([c]);
    expect(getPersonOfUser(database.sqlite, c)).toBeUndefined();
  });

  it('adds to an existing person and merges two persons', () => {
    linkUsers(database.sqlite, a, b, 'mod', 100);
    linkUsers(database.sqlite, c, d, 'mod', 110);
    linkUsers(database.sqlite, b, c, 'mod', 120);
    expect(members(d)).toEqual([a, b, c, d]);
    expect(getPersonOfUser(database.sqlite, d)?.primaryUserId).toBe(a);
    expect(database.sqlite.prepare('SELECT count(*) FROM persons').pluck().get()).toBe(1);
    // Linking members of the same person again changes nothing.
    linkUsers(database.sqlite, d, a, 'mod', 130);
    expect(members(a)).toEqual([a, b, c, d]);
  });

  it('refuses to link a user with itself', () => {
    expect(() => linkUsers(database.sqlite, a, a, 'mod', 100)).toThrow(PersonLinkError);
  });

  it('promotes another member when the primary user leaves and dissolves pairs', () => {
    linkUsers(database.sqlite, a, b, 'mod', 100);
    linkUsers(database.sqlite, a, c, 'mod', 110);
    unlinkUser(database.sqlite, a);
    expect(getPersonOfUser(database.sqlite, b)).toMatchObject({ primaryUserId: b });
    expect(members(b)).toEqual([b, c]);
    unlinkUser(database.sqlite, c);
    expect(getPersonOfUser(database.sqlite, b)).toBeUndefined();
    expect(database.sqlite.prepare('SELECT count(*) FROM persons').pluck().get()).toBe(0);
    expect(() => {
      unlinkUser(database.sqlite, d);
    }).toThrow(PersonLinkError);
  });

  it('changes the primary user', () => {
    linkUsers(database.sqlite, a, b, 'mod', 100);
    setPrimaryUser(database.sqlite, b);
    expect(getPersonOfUser(database.sqlite, a)?.primaryUserId).toBe(b);
    expect(members(a)).toEqual([b, a]);
    expect(() => {
      setPrimaryUser(database.sqlite, c);
    }).toThrow(PersonLinkError);
  });
});
