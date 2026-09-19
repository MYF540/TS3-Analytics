/**
 * Accounts and sessions of the web interface. Passwords are hashed with argon2id; session tokens
 * are random 256-bit values of which only the SHA-256 hash is stored.
 */
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { asc, eq, lt } from 'drizzle-orm';
import type { DbExecutor } from '../../db/repositories/types.js';
import { adminSessions, adminUsers, type AdminRole } from '../../db/schema.js';

export const MIN_PASSWORD_LENGTH = 12;
const USERNAME = /^[a-z0-9._-]{3,32}$/;

/** Higher number = more rights. */
export const ROLE_RANK: Record<AdminRole, number> = { viewer: 1, moderator: 2, admin: 3 };

export function hasRole(role: AdminRole, required: AdminRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export interface AuthUser {
  id: number;
  username: string;
  role: AdminRole;
}

export class AccountError extends Error {
  constructor(
    readonly code: 'INVALID_USERNAME' | 'WEAK_PASSWORD' | 'USERNAME_TAKEN' | 'UNKNOWN_USER',
    message: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AccountError(
      'WEAK_PASSWORD',
      `Password must have at least ${String(MIN_PASSWORD_LENGTH)} characters`,
    );
  }
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

// Verified for unknown users too, so response times do not reveal which usernames exist.
let dummyHash: Promise<string> | undefined;

export async function createAdminUser(
  db: DbExecutor,
  input: { username: string; password: string; role: AdminRole },
  now: number,
): Promise<AuthUser> {
  const username = normalizeUsername(input.username);
  if (!USERNAME.test(username)) {
    throw new AccountError(
      'INVALID_USERNAME',
      'Usernames have 3–32 characters: letters, digits, "." "_" "-"',
    );
  }
  checkPassword(input.password);
  const exists = db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.username, username))
    .get();
  if (exists) throw new AccountError('USERNAME_TAKEN', `User "${username}" already exists`);
  const passwordHash = await hashPassword(input.password);
  const row = db
    .insert(adminUsers)
    .values({ username, passwordHash, role: input.role, createdAt: now })
    .returning({ id: adminUsers.id })
    .get();
  return { id: row.id, username, role: input.role };
}

/** Sets a new password and ends all sessions of that user. */
export async function setPassword(
  db: DbExecutor,
  username: string,
  password: string,
): Promise<void> {
  checkPassword(password);
  const passwordHash = await hashPassword(password);
  const user = db
    .update(adminUsers)
    .set({ passwordHash })
    .where(eq(adminUsers.username, normalizeUsername(username)))
    .returning({ id: adminUsers.id })
    .get() as { id: number } | undefined;
  if (!user) throw new AccountError('UNKNOWN_USER', `User "${username}" does not exist`);
  db.delete(adminSessions).where(eq(adminSessions.userId, user.id)).run();
}

/** Disables or re-enables an account; disabling ends all its sessions. */
export function setDisabled(db: DbExecutor, username: string, disabled: boolean): void {
  const user = db
    .update(adminUsers)
    .set({ disabled })
    .where(eq(adminUsers.username, normalizeUsername(username)))
    .returning({ id: adminUsers.id })
    .get() as { id: number } | undefined;
  if (!user) throw new AccountError('UNKNOWN_USER', `User "${username}" does not exist`);
  if (disabled) db.delete(adminSessions).where(eq(adminSessions.userId, user.id)).run();
}

export function listAdminUsers(db: DbExecutor) {
  return db
    .select({
      id: adminUsers.id,
      username: adminUsers.username,
      role: adminUsers.role,
      disabled: adminUsers.disabled,
      createdAt: adminUsers.createdAt,
      lastLoginAt: adminUsers.lastLoginAt,
    })
    .from(adminUsers)
    .orderBy(asc(adminUsers.username))
    .all();
}

/** Checks the credentials; `undefined` for unknown, disabled or wrong. Constant-ish time. */
export async function authenticate(
  db: DbExecutor,
  username: string,
  password: string,
): Promise<AuthUser | undefined> {
  const row = db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.username, normalizeUsername(username)))
    .get();
  if (!row || row.disabled) {
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    await argon2.verify(await dummyHash, password).catch(() => false);
    return undefined;
  }
  const ok = await argon2.verify(row.passwordHash, password).catch(() => false);
  return ok ? { id: row.id, username: row.username, role: row.role } : undefined;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** Creates a session and returns the token for the cookie (the only place it exists). */
export function createSession(db: DbExecutor, userId: number, now: number, ttlS: number): string {
  const token = randomBytes(32).toString('base64url');
  db.insert(adminSessions)
    .values({
      tokenHash: hashToken(token),
      userId,
      createdAt: now,
      expiresAt: now + ttlS,
      lastSeenAt: now,
    })
    .run();
  db.update(adminUsers).set({ lastLoginAt: now }).where(eq(adminUsers.id, userId)).run();
  return token;
}

const TOUCH_INTERVAL_S = 60;

/**
 * Resolves a session token to its user. Sessions slide: each use (at most once a minute) moves
 * the expiry to `now + ttlS`. Expired sessions and disabled users resolve to `undefined`.
 */
export function resolveSession(
  db: DbExecutor,
  token: string,
  now: number,
  ttlS: number,
): AuthUser | undefined {
  const tokenHash = hashToken(token);
  const row = db
    .select({
      expiresAt: adminSessions.expiresAt,
      lastSeenAt: adminSessions.lastSeenAt,
      id: adminUsers.id,
      username: adminUsers.username,
      role: adminUsers.role,
      disabled: adminUsers.disabled,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.userId))
    .where(eq(adminSessions.tokenHash, tokenHash))
    .get();
  if (!row) return undefined;
  if (row.expiresAt <= now || row.disabled) {
    db.delete(adminSessions).where(eq(adminSessions.tokenHash, tokenHash)).run();
    return undefined;
  }
  if (now - row.lastSeenAt >= TOUCH_INTERVAL_S) {
    db.update(adminSessions)
      .set({ lastSeenAt: now, expiresAt: now + ttlS })
      .where(eq(adminSessions.tokenHash, tokenHash))
      .run();
  }
  return { id: row.id, username: row.username, role: row.role };
}

export function deleteSession(db: DbExecutor, token: string): void {
  db.delete(adminSessions)
    .where(eq(adminSessions.tokenHash, hashToken(token)))
    .run();
}

export function deleteExpiredSessions(db: DbExecutor, now: number): number {
  return db.delete(adminSessions).where(lt(adminSessions.expiresAt, now)).run().changes;
}
