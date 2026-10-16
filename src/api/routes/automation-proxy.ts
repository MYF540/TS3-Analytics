import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { rankGroupIds } from '../../automation/actions.js';
import {
  clearProxyVerdict,
  getProxyCheck,
  loadProxySettings,
  PROXY_ACTIONS,
  proxySettingsSchema,
} from '../../automation/modules/proxy.js';
import { saveModuleSettings } from '../../automation/settings.js';
import { getUserById } from '../../db/repositories/index.js';
import { PROXY_VERDICTS } from '../../db/schema.js';
import { wordsCollide } from '../../domain/language.js';
import { loadGroupWatch } from '../../watcher/group-settings.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

const inviteTextsOutput = z.object({
  intro: z.string(),
  nobodyMessage: z.string(),
  askedMessage: z.string(),
  sponsorQuestion: z.string(),
  yesWord: z.string(),
  noWord: z.string(),
  acceptedMessage: z.string(),
  declinedMessage: z.string(),
  timeoutMessage: z.string(),
  exhaustedMessage: z.string(),
  sponsorThanks: z.string(),
});

export const proxySettingsResponse = z.object({
  settings: z.object({
    enabled: z.boolean(),
    dryRun: z.boolean(),
    exemptGroupIds: z.array(z.number().int()),
    action: z.enum(PROXY_ACTIONS),
    message: z.string(),
    groupId: z.number().int().nullable(),
    banDurationS: z.number().int(),
    notifyGroupIds: z.array(z.number().int()),
    notifyMessage: z.string(),
    exemptUserIds: z.array(z.number().int()),
    invite: inviteTextsOutput.extend({
      whitelistGroupId: z.number().int().nullable(),
      sponsorGroupIds: z.array(z.number().int()),
      timeoutS: z.number().int(),
      maxAttempts: z.number().int(),
    }),
    english: z.object({
      enabled: z.boolean(),
      message: z.string(),
      invite: inviteTextsOutput,
    }),
  }),
  groups: z.array(z.object({ id: z.number().int(), name: z.string() })),
  /** Whether an API key is set in `.env`; the key itself never leaves the server. */
  keyConfigured: z.boolean(),
  stats: z.object({
    /** Addresses on the local list. */
    listed: z.number().int(),
    clean: z.number().int(),
    proxy: z.number().int(),
  }),
  /** Players last seen with a VPN or proxy, newest first. */
  flagged: z.array(
    z.object({
      userId: z.number().int(),
      nickname: z.string().nullable(),
      checkedAt: z.number().int(),
    }),
  ),
});

export const proxyClearResponse = z.object({ removed: z.number().int() });

export const playerProxyResponse = z.object({
  enabled: z.boolean(),
  verdict: z.enum(PROXY_VERDICTS).nullable(),
  checkedAt: z.number().int().nullable(),
  /** Who vouched for the player in the invite flow, if anybody. */
  vouch: z
    .object({
      sponsorUserId: z.number().int().nullable(),
      sponsorNickname: z.string().nullable(),
      at: z.number().int(),
    })
    .nullable(),
});

/** Settings of the proxy check (T10.10), undoing a false alarm, and a player's result. */
export function automationProxyRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db, sqlite } = context.database;
    const count = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;
    const response = () => ({
      settings: loadProxySettings(db),
      groups: loadGroupWatch(db).knownGroups,
      keyConfigured: context.proxyKeyConfigured ?? false,
      stats: {
        listed: count('SELECT count(*) AS n FROM proxy_ips'),
        clean: count("SELECT count(*) AS n FROM proxy_checks WHERE verdict = 'clean'"),
        proxy: count("SELECT count(*) AS n FROM proxy_checks WHERE verdict = 'proxy'"),
      },
      flagged: sqlite
        .prepare(
          `SELECT c.user_id AS userId,
                  (SELECT n.nick FROM nicknames n WHERE n.user_id = c.user_id
                   ORDER BY n.last_seen DESC, n.id DESC LIMIT 1) AS nickname,
                  c.checked_at AS checkedAt
           FROM proxy_checks c WHERE c.verdict = 'proxy'
           ORDER BY c.checked_at DESC, c.user_id DESC LIMIT 50`,
        )
        .all() as { userId: number; nickname: string | null; checkedAt: number }[],
    });

    app.get(
      '/automation/proxy',
      { config: { auth: 'admin' }, schema: { response: { 200: proxySettingsResponse } } },
      () => response(),
    );

    app.put(
      '/automation/proxy',
      {
        config: { auth: 'admin' },
        schema: { body: proxySettingsSchema, response: { 200: proxySettingsResponse } },
      },
      (request) => {
        const settings = request.body;
        const needsGroup = settings.action === 'group' || settings.action === 'invite';
        if (needsGroup && settings.groupId === null) {
          throw new ApiError(400, 'PROXY_GROUP_MISSING', 'This action needs a group');
        }
        const { whitelistGroupId, yesWord, noWord } = settings.invite;
        const { english } = settings;
        const rankGroups = rankGroupIds(context.database);
        if ([settings.groupId, whitelistGroupId].some((g) => g !== null && rankGroups.has(g))) {
          throw new ApiError(400, 'RULES_RANK_GROUP', 'A rank group cannot be used');
        }
        if (whitelistGroupId !== null && whitelistGroupId === settings.groupId) {
          throw new ApiError(
            400,
            'PROXY_SAME_GROUP',
            'Restricting and whitelist group must differ',
          );
        }
        // Answers are understood in both languages: no word may mean yes in one and no in the other.
        const yes = [yesWord, ...(english.enabled ? [english.invite.yesWord] : [])];
        const no = [noWord, ...(english.enabled ? [english.invite.noWord] : [])];
        if (wordsCollide(yes, no)) {
          throw new ApiError(400, 'RULES_SAME_COMMAND', 'Yes and no must differ');
        }
        request.audit({
          action: 'automation.proxy',
          targetType: 'settings',
          targetId: 'automation.proxy',
          details: {
            enabled: settings.enabled,
            dryRun: settings.dryRun,
            action: settings.action,
            groupId: settings.groupId,
            exemptUsers: settings.exemptUserIds.length,
          },
        });
        saveModuleSettings(db, 'proxy', settings, context.now());
        return response();
      },
    );

    // False alarm: the player counts as clean and their addresses leave the local list.
    app.post(
      '/automation/proxy/clear/:id',
      {
        config: { auth: 'admin' },
        schema: { params: idParams, response: { 200: proxyClearResponse } },
      },
      (request) => {
        const { id } = request.params;
        request.audit({ action: 'automation.proxy.clear', targetType: 'user', targetId: id });
        if (!getUserById(db, id)) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
        const removed = sqlite.transaction(() => clearProxyVerdict(db, id, context.now()))();
        return { removed };
      },
    );

    app.get(
      '/users/:id/proxy',
      {
        config: { auth: 'moderator' },
        schema: { params: idParams, response: { 200: playerProxyResponse } },
      },
      (request) => {
        if (!getUserById(db, request.params.id)) {
          throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
        }
        const result = getProxyCheck(db, request.params.id);
        const vouch = sqlite
          .prepare(
            `SELECT v.sponsor_user_id AS sponsorUserId,
                    (SELECT n.nick FROM nicknames n WHERE n.user_id = v.sponsor_user_id
                     ORDER BY n.last_seen DESC, n.id DESC LIMIT 1) AS sponsorNickname,
                    v.at
             FROM proxy_vouches v WHERE v.user_id = ?`,
          )
          .get(request.params.id) as
          { sponsorUserId: number | null; sponsorNickname: string | null; at: number } | undefined;
        return {
          enabled: loadProxySettings(db).enabled,
          verdict: result?.verdict ?? null,
          checkedAt: result?.checkedAt ?? null,
          vouch: vouch ?? null,
        };
      },
    );

    return Promise.resolve();
  };
}
