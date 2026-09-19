import type Database from 'better-sqlite3';
import type { DbExecutor } from '../../db/repositories/types.js';
import { auditLog } from '../../db/schema.js';

export interface AuditEntry {
  at: number;
  actorId: number | null;
  actorName: string;
  action: string;
  targetType?: string | undefined;
  targetId?: string | number | undefined;
  details?: Record<string, unknown> | undefined;
  status?: number | undefined;
}

export const CLI_ACTOR = 'cli';
export const ANONYMOUS_ACTOR = 'anonymous';

export function writeAudit(db: DbExecutor, entry: AuditEntry): void {
  db.insert(auditLog)
    .values({
      at: entry.at,
      actorId: entry.actorId,
      actorName: entry.actorName,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId === undefined ? null : String(entry.targetId),
      details: entry.details ? JSON.stringify(entry.details) : null,
      status: entry.status ?? null,
    })
    .run();
}

export interface AuditFilter {
  actor?: string | undefined;
  action?: string | undefined;
  /** UTC seconds, inclusive. */
  from?: number | undefined;
  /** UTC seconds, exclusive. */
  to?: number | undefined;
}

export interface AuditRow {
  id: number;
  at: number;
  actorName: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  status: number | null;
}

function where(filter: AuditFilter): { sql: string; params: Record<string, string | number> } {
  const clauses: string[] = [];
  const params: Record<string, string | number> = {};
  if (filter.actor) {
    clauses.push('actor_name = @actor');
    params.actor = filter.actor;
  }
  if (filter.action) {
    clauses.push('action = @action');
    params.action = filter.action;
  }
  if (filter.from !== undefined) {
    clauses.push('at >= @from');
    params.from = filter.from;
  }
  if (filter.to !== undefined) {
    clauses.push('at < @to');
    params.to = filter.to;
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Newest first. */
export function listAudit(
  sqlite: Database.Database,
  filter: AuditFilter,
  page: { limit: number; offset: number },
): { items: AuditRow[]; total: number } {
  const w = where(filter);
  const rows = sqlite
    .prepare(
      `SELECT id, at, actor_name AS actorName, action, target_type AS targetType,
              target_id AS targetId, details, status
       FROM audit_log ${w.sql} ORDER BY at DESC, id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...w.params, limit: page.limit, offset: page.offset }) as (Omit<AuditRow, 'details'> & {
    details: string | null;
  })[];
  const total = sqlite
    .prepare(`SELECT count(*) FROM audit_log ${w.sql}`)
    .pluck()
    .get(w.params) as number;
  return {
    items: rows.map((row) => ({
      ...row,
      details: row.details ? (JSON.parse(row.details) as Record<string, unknown>) : null,
    })),
    total,
  };
}

/** Values for the filter controls. */
export function auditFilterValues(sqlite: Database.Database): {
  actors: string[];
  actions: string[];
} {
  const distinct = (column: string) =>
    sqlite.prepare(`SELECT DISTINCT ${column} FROM audit_log ORDER BY 1`).pluck().all() as string[];
  return { actors: distinct('actor_name'), actions: distinct('action') };
}
