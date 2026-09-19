import type Database from 'better-sqlite3';

/**
 * UID linking (T5.3). A person groups several users; statistics are grouped by its primary user.
 * All functions expect to run inside a transaction when they change several rows (the callers in
 * the API do that).
 */

export interface PersonMember {
  userId: number;
  uid: string;
  nickname: string | null;
  addedAt: number;
  addedBy: string;
}

export interface Person {
  id: number;
  primaryUserId: number;
  members: PersonMember[];
}

export class PersonLinkError extends Error {
  constructor(readonly code: 'SAME_USER' | 'NOT_LINKED' | 'NOT_A_MEMBER') {
    super(code);
    this.name = 'PersonLinkError';
  }
}

function personIdOf(sqlite: Database.Database, userId: number): number | undefined {
  return sqlite
    .prepare('SELECT person_id FROM person_members WHERE user_id = ?')
    .pluck()
    .get(userId) as number | undefined;
}

export function getPersonOfUser(sqlite: Database.Database, userId: number): Person | undefined {
  const personId = personIdOf(sqlite, userId);
  if (personId === undefined) return undefined;
  const primaryUserId = sqlite
    .prepare('SELECT primary_user_id FROM persons WHERE id = ?')
    .pluck()
    .get(personId) as number;
  const members = sqlite
    .prepare(
      `SELECT m.user_id AS userId, u.uid,
              (SELECT n.nick FROM nicknames n WHERE n.user_id = m.user_id
               ORDER BY n.last_seen DESC, n.id DESC LIMIT 1) AS nickname,
              m.added_at AS addedAt, m.added_by AS addedBy
       FROM person_members m JOIN users u ON u.id = m.user_id
       WHERE m.person_id = ?
       ORDER BY m.user_id = ? DESC, m.added_at, m.user_id`,
    )
    .all(personId, primaryUserId) as PersonMember[];
  return { id: personId, primaryUserId, members };
}

/** All user ids that belong to the same person as `userId` (just `[userId]` if unlinked). */
export function personUserIds(sqlite: Database.Database, userId: number): number[] {
  const ids = sqlite
    .prepare(
      `SELECT m2.user_id FROM person_members m1
       JOIN person_members m2 ON m2.person_id = m1.person_id
       WHERE m1.user_id = ? ORDER BY m2.user_id`,
    )
    .pluck()
    .all(userId) as number[];
  return ids.length > 0 ? ids : [userId];
}

/**
 * Links `otherUserId` to the person of `userId`. Creates a person with `userId` as primary if
 * needed; if both already belong to different persons, they are merged into the person of
 * `userId` (its primary user stays primary). Returns the person id.
 */
export function linkUsers(
  sqlite: Database.Database,
  userId: number,
  otherUserId: number,
  actor: string,
  now: number,
): number {
  if (userId === otherUserId) throw new PersonLinkError('SAME_USER');
  let personId = personIdOf(sqlite, userId);
  const otherPersonId = personIdOf(sqlite, otherUserId);
  if (personId !== undefined && personId === otherPersonId) return personId;

  if (personId === undefined) {
    personId = sqlite
      .prepare(
        'INSERT INTO persons (primary_user_id, created_at, created_by) VALUES (?, ?, ?) RETURNING id',
      )
      .pluck()
      .get(userId, now, actor) as number;
    addMember(sqlite, personId, userId, actor, now);
  }
  if (otherPersonId === undefined) {
    addMember(sqlite, personId, otherUserId, actor, now);
  } else {
    sqlite
      .prepare('UPDATE person_members SET person_id = ? WHERE person_id = ?')
      .run(personId, otherPersonId);
    sqlite.prepare('DELETE FROM persons WHERE id = ?').run(otherPersonId);
  }
  return personId;
}

function addMember(
  sqlite: Database.Database,
  personId: number,
  userId: number,
  actor: string,
  now: number,
): void {
  sqlite
    .prepare(
      'INSERT INTO person_members (user_id, person_id, added_at, added_by) VALUES (?, ?, ?, ?)',
    )
    .run(userId, personId, now, actor);
}

/**
 * Removes a user from its person. If it was the primary user, the longest-standing remaining
 * member becomes primary; a person with a single member left is dissolved.
 */
export function unlinkUser(sqlite: Database.Database, userId: number): void {
  const personId = personIdOf(sqlite, userId);
  if (personId === undefined) throw new PersonLinkError('NOT_LINKED');
  sqlite.prepare('DELETE FROM person_members WHERE user_id = ?').run(userId);
  const remaining = sqlite
    .prepare('SELECT user_id FROM person_members WHERE person_id = ? ORDER BY added_at, user_id')
    .pluck()
    .all(personId) as number[];
  if (remaining.length <= 1) {
    sqlite.prepare('DELETE FROM persons WHERE id = ?').run(personId);
    return;
  }
  sqlite
    .prepare('UPDATE persons SET primary_user_id = ? WHERE id = ? AND primary_user_id = ?')
    .run(remaining[0], personId, userId);
}

/** Makes `userId` the primary user of its person. */
export function setPrimaryUser(sqlite: Database.Database, userId: number): void {
  const personId = personIdOf(sqlite, userId);
  if (personId === undefined) throw new PersonLinkError('NOT_A_MEMBER');
  sqlite.prepare('UPDATE persons SET primary_user_id = ? WHERE id = ?').run(userId, personId);
}
