import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { playerNoteRevisions, playerNotes, tags, userTags, type TagColor } from '../schema.js';
import type { DbExecutor, UnixSeconds } from './types.js';

export interface Note {
  id: number;
  userId: number;
  authorId: number | null;
  authorName: string;
  body: string;
  createdAt: UnixSeconds;
  updatedAt: UnixSeconds;
  /** Number of earlier versions (edits). */
  revisions: number;
}

const noteColumns = {
  id: playerNotes.id,
  userId: playerNotes.userId,
  authorId: playerNotes.authorId,
  authorName: playerNotes.authorName,
  body: playerNotes.body,
  createdAt: playerNotes.createdAt,
  updatedAt: playerNotes.updatedAt,
  // Qualified explicitly: Drizzle renders `${playerNotes.id}` as a bare "id" here, which would
  // resolve to the revision id inside the subquery.
  revisions: sql<number>`(SELECT count(*) FROM player_note_revisions r WHERE r.note_id = "player_notes"."id")`,
};

/** Current (not deleted) notes of a player, newest first. */
export function listNotes(db: DbExecutor, userId: number): Note[] {
  return db
    .select(noteColumns)
    .from(playerNotes)
    .where(and(eq(playerNotes.userId, userId), isNull(playerNotes.deletedAt)))
    .orderBy(desc(playerNotes.createdAt), desc(playerNotes.id))
    .all();
}

export function getNote(db: DbExecutor, noteId: number): Note | undefined {
  return db
    .select(noteColumns)
    .from(playerNotes)
    .where(and(eq(playerNotes.id, noteId), isNull(playerNotes.deletedAt)))
    .get();
}

export function createNote(
  db: DbExecutor,
  note: { userId: number; authorId: number | null; authorName: string; body: string },
  now: UnixSeconds,
): Note {
  const { id } = db
    .insert(playerNotes)
    .values({ ...note, createdAt: now, updatedAt: now })
    .returning({ id: playerNotes.id })
    .get();
  return { ...note, id, createdAt: now, updatedAt: now, revisions: 0 };
}

function keepRevision(db: DbExecutor, note: Note, editorName: string, now: UnixSeconds): void {
  db.insert(playerNoteRevisions)
    .values({ noteId: note.id, body: note.body, editorName, replacedAt: now })
    .run();
}

/** Replaces the text; the previous version is kept as a revision. */
export function updateNote(
  db: DbExecutor,
  note: Note,
  body: string,
  editorName: string,
  now: UnixSeconds,
): Note {
  keepRevision(db, note, editorName, now);
  db.update(playerNotes).set({ body, updatedAt: now }).where(eq(playerNotes.id, note.id)).run();
  return { ...note, body, updatedAt: now, revisions: note.revisions + 1 };
}

/** Soft delete: hidden from the player page, text kept as the last revision. */
export function deleteNote(db: DbExecutor, note: Note, editorName: string, now: UnixSeconds): void {
  keepRevision(db, note, editorName, now);
  db.update(playerNotes).set({ deletedAt: now }).where(eq(playerNotes.id, note.id)).run();
}

export function listRevisions(db: DbExecutor, noteId: number) {
  return db
    .select({
      body: playerNoteRevisions.body,
      editorName: playerNoteRevisions.editorName,
      replacedAt: playerNoteRevisions.replacedAt,
    })
    .from(playerNoteRevisions)
    .where(eq(playerNoteRevisions.noteId, noteId))
    .orderBy(desc(playerNoteRevisions.replacedAt), desc(playerNoteRevisions.id))
    .all();
}

export interface Tag {
  id: number;
  name: string;
  color: TagColor;
}

export function listTags(db: DbExecutor): (Tag & { users: number })[] {
  return db
    .select({ id: tags.id, name: tags.name, color: tags.color, users: count(userTags.userId) })
    .from(tags)
    .leftJoin(userTags, eq(userTags.tagId, tags.id))
    .groupBy(tags.id)
    .orderBy(sql`lower(${tags.name})`)
    .all();
}

export function getTag(db: DbExecutor, tagId: number): Tag | undefined {
  return db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(tags)
    .where(eq(tags.id, tagId))
    .get();
}

export function findTagByName(db: DbExecutor, name: string): Tag | undefined {
  return db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(tags)
    .where(sql`lower(${tags.name}) = lower(${name.trim()})`)
    .get();
}

export function createTag(db: DbExecutor, name: string, color: TagColor, now: UnixSeconds): Tag {
  const { id } = db
    .insert(tags)
    .values({ name: name.trim(), color, createdAt: now })
    .returning({ id: tags.id })
    .get();
  return { id, name: name.trim(), color };
}

export function updateTag(
  db: DbExecutor,
  tagId: number,
  changes: { name?: string | undefined; color?: TagColor | undefined },
): void {
  db.update(tags)
    .set({
      ...(changes.name === undefined ? {} : { name: changes.name.trim() }),
      ...(changes.color === undefined ? {} : { color: changes.color }),
    })
    .where(eq(tags.id, tagId))
    .run();
}

export function deleteTag(db: DbExecutor, tagId: number): void {
  db.delete(tags).where(eq(tags.id, tagId)).run();
}

export function getUserTags(db: DbExecutor, userId: number): Tag[] {
  return db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(userTags)
    .innerJoin(tags, eq(tags.id, userTags.tagId))
    .where(eq(userTags.userId, userId))
    .orderBy(sql`lower(${tags.name})`)
    .all();
}

/** Replaces the tags of a player; returns which tag ids were added and removed. */
export function setUserTags(
  db: DbExecutor,
  userId: number,
  tagIds: readonly number[],
  addedBy: string,
  now: UnixSeconds,
): { added: number[]; removed: number[] } {
  const current = new Set(getUserTags(db, userId).map((t) => t.id));
  const wanted = new Set(tagIds);
  const added = [...wanted].filter((id) => !current.has(id));
  const removed = [...current].filter((id) => !wanted.has(id));
  if (removed.length > 0) {
    db.delete(userTags)
      .where(and(eq(userTags.userId, userId), inArray(userTags.tagId, removed)))
      .run();
  }
  if (added.length > 0) {
    db.insert(userTags)
      .values(added.map((tagId) => ({ userId, tagId, addedBy, addedAt: now })))
      .run();
  }
  return { added, removed };
}
