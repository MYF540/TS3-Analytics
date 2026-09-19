import { z } from 'zod';
import type { Ts3Connection } from '../ts3/connection.js';
import { MAX_BAN_S, type ModerationSettings } from './settings.js';

/** The query commands moderation needs; `Ts3Connection` implements them via the queue. */
export type ModerationCommands = Pick<
  Ts3Connection,
  'kick' | 'poke' | 'sendMessage' | 'move' | 'banUid' | 'banClient'
>;

/** Limits of the TS3 server: kick reason 40, poke 100, text message 1024 characters. */
export const moderationAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('poke'), message: z.string().trim().min(1).max(100) }),
  z.object({ type: z.literal('message'), message: z.string().trim().min(1).max(1024) }),
  z.object({
    type: z.literal('kick'),
    from: z.enum(['server', 'channel']),
    reason: z.string().trim().max(40).default(''),
  }),
  z.object({ type: z.literal('move'), channelId: z.number().int().positive() }),
  z.object({
    type: z.literal('ban'),
    /** A template sets reason and duration. */
    templateId: z.string().max(32).optional(),
    reason: z.string().trim().max(200).optional(),
    durationS: z.number().int().min(0).max(MAX_BAN_S).optional(),
    /** Also ban the current IP (`banclient`); only for online clients. */
    includeIp: z.boolean().default(false),
  }),
]);

export type ModerationAction = z.infer<typeof moderationAction>;

export class ModerationError extends Error {
  constructor(
    readonly code: 'MODERATION_DISABLED' | 'NOT_ONLINE' | 'UNKNOWN_TEMPLATE' | 'BAN_REASON_MISSING',
  ) {
    super(code);
    this.name = 'ModerationError';
  }
}

export interface ResolvedBan {
  reason: string;
  durationS: number;
}

/** Reason and duration of a ban action, from its template or its own fields. */
export function resolveBan(
  action: Extract<ModerationAction, { type: 'ban' }>,
  settings: ModerationSettings,
): ResolvedBan {
  if (action.templateId !== undefined) {
    const template = settings.banTemplates.find((t) => t.id === action.templateId);
    if (!template) throw new ModerationError('UNKNOWN_TEMPLATE');
    return { reason: template.reason, durationS: template.durationS };
  }
  if (!action.reason) throw new ModerationError('BAN_REASON_MISSING');
  return { reason: action.reason, durationS: action.durationS ?? 0 };
}

/**
 * Runs one action for all online clients of a user (a player may be connected twice). Bans also
 * work for offline players via their UID. Returns the number of affected clients.
 */
export async function runModerationAction(
  commands: ModerationCommands,
  settings: ModerationSettings,
  target: { uid: string; clids: readonly number[] },
  action: ModerationAction,
): Promise<number> {
  if (!settings.enabled) throw new ModerationError('MODERATION_DISABLED');
  const { clids } = target;
  if (action.type === 'ban') {
    const { reason, durationS } = resolveBan(action, settings);
    if (action.includeIp && clids.length > 0) {
      for (const clid of clids) await commands.banClient(clid, durationS, reason);
      return clids.length;
    }
    await commands.banUid(target.uid, durationS, reason);
    for (const clid of clids) await commands.kick(clid, 'server', reason.slice(0, 40));
    return Math.max(1, clids.length);
  }
  if (clids.length === 0) throw new ModerationError('NOT_ONLINE');
  for (const clid of clids) {
    switch (action.type) {
      case 'poke':
        await commands.poke(clid, action.message);
        break;
      case 'message':
        await commands.sendMessage(clid, action.message);
        break;
      case 'kick':
        await commands.kick(clid, action.from, action.reason);
        break;
      case 'move':
        await commands.move(clid, action.channelId);
        break;
    }
  }
  return clids.length;
}
