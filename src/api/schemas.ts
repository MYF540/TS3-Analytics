/** Shared request/response schemas of the public API (also the contract for the frontend). */
import { z } from 'zod';
import { parseDay } from '../domain/time.js';

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** `YYYY-MM-DD` → YYYYMMDD. */
export const dayParam = z.string().transform((value, ctx) => {
  const day = parseDay(value);
  if (day === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Expected a date in the form YYYY-MM-DD' });
    return z.NEVER;
  }
  return day;
});

export const leaderboardEntry = z.object({
  rank: z.number().int(),
  userId: z.number().int(),
  uid: z.string(),
  nickname: z.string().nullable(),
  value: z.number(),
  /** Linked UIDs counted in this entry (T5.3). */
  accounts: z.number().int(),
});

export function paged<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  });
}
