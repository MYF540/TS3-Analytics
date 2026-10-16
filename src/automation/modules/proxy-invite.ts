import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbExecutor } from '../../db/repositories/index.js';
import { proxyVouches } from '../../db/schema.js';
import type { Language } from '../../domain/language.js';
import { fillTemplate } from '../../domain/support.js';
import { loadActivitySettings } from '../../watcher/settings.js';
import { MESSAGE_MAX, type AutomationDeps, type ModuleActions } from '../actions.js';
import type { BotClient } from '../host.js';

const text = z.string().trim().min(1).max(MESSAGE_MAX);
const word = z.string().trim().min(1).max(40);

const defaults = {
  whitelistGroupId: null,
  sponsorGroupIds: [] as number[],
  timeoutS: 300,
  maxAttempts: 3,
  intro:
    'Du bist über ein VPN oder einen Proxy verbunden und deshalb eingeschränkt. Zu wem gehörst du? Antworte mir mit der Nummer aus der Liste.',
  nobodyMessage:
    'Im Moment ist niemand online, der für dich bürgen kann. Versuche es später noch einmal.',
  askedMessage: '{name} wurde gefragt. Bitte warte auf die Antwort.',
  sponsorQuestion:
    '{name} ist über ein VPN oder einen Proxy verbunden und sagt, er gehört zu dir. Antworte mir mit „{yes}“, wenn das stimmt, sonst mit „{no}“.',
  yesWord: 'ja',
  noWord: 'nein',
  acceptedMessage: '{name} hat für dich gebürgt. Du bist freigeschaltet.',
  declinedMessage: '{name} hat nicht bestätigt. Du kannst eine andere Nummer wählen.',
  timeoutMessage: '{name} hat nicht geantwortet. Du kannst eine andere Nummer wählen.',
  exhaustedMessage: 'Das waren zu viele Versuche. Bitte melde dich bei einem Admin.',
  sponsorThanks: 'Danke. {name} ist jetzt freigeschaltet – du bürgst für diesen Spieler.',
};

/** Settings of the invite flow (action `invite` of the proxy check). */
export const proxyInviteSchema = z
  .object({
    /** Group a vouched player gets; with it they are never checked again. Null = none. */
    whitelistGroupId: z.number().int().positive().nullable().default(defaults.whitelistGroupId),
    /** Only members of these groups can vouch; empty = everybody who is online. */
    sponsorGroupIds: z.array(z.number().int().positive()).max(50).default(defaults.sponsorGroupIds),
    /** Seconds a sponsor has to answer. Checked with every poll. */
    timeoutS: z.number().int().min(30).max(3600).default(defaults.timeoutS),
    /** How many sponsors a player may ask per connection. */
    maxAttempts: z.number().int().min(1).max(10).default(defaults.maxAttempts),
    intro: text.default(defaults.intro),
    nobodyMessage: text.default(defaults.nobodyMessage),
    /** `{name}` is the sponsor. */
    askedMessage: text.default(defaults.askedMessage),
    /** `{name}` is the player, `{yes}` and `{no}` the two words. */
    sponsorQuestion: text.default(defaults.sponsorQuestion),
    yesWord: word.default(defaults.yesWord),
    noWord: word.default(defaults.noWord),
    acceptedMessage: text.default(defaults.acceptedMessage),
    declinedMessage: text.default(defaults.declinedMessage),
    timeoutMessage: text.default(defaults.timeoutMessage),
    exhaustedMessage: text.default(defaults.exhaustedMessage),
    sponsorThanks: text.default(defaults.sponsorThanks),
  })
  .default(defaults);

export type ProxyInviteSettings = z.infer<typeof proxyInviteSchema>;

const englishDefaults = {
  intro:
    'You are connected through a VPN or proxy and therefore restricted. Who do you belong to? Reply with the number from the list.',
  nobodyMessage: 'Nobody who could vouch for you is online right now. Please try again later.',
  askedMessage: '{name} has been asked. Please wait for the answer.',
  sponsorQuestion:
    '{name} is connected through a VPN or proxy and says they belong to you. Reply with "{yes}" if that is true, otherwise with "{no}".',
  yesWord: 'yes',
  noWord: 'no',
  acceptedMessage: '{name} vouched for you. You are now unlocked.',
  declinedMessage: '{name} did not confirm. You can choose another number.',
  timeoutMessage: '{name} did not answer. You can choose another number.',
  exhaustedMessage: 'That was too many attempts. Please contact an admin.',
  sponsorThanks: 'Thank you. {name} is now unlocked – you are vouching for this player.',
};

/** English texts of the invite flow (T12.1); groups, deadline and attempts are shared. */
export const englishInviteSchema = z
  .object({
    intro: text.default(englishDefaults.intro),
    nobodyMessage: text.default(englishDefaults.nobodyMessage),
    askedMessage: text.default(englishDefaults.askedMessage),
    sponsorQuestion: text.default(englishDefaults.sponsorQuestion),
    yesWord: word.default(englishDefaults.yesWord),
    noWord: word.default(englishDefaults.noWord),
    acceptedMessage: text.default(englishDefaults.acceptedMessage),
    declinedMessage: text.default(englishDefaults.declinedMessage),
    timeoutMessage: text.default(englishDefaults.timeoutMessage),
    exhaustedMessage: text.default(englishDefaults.exhaustedMessage),
    sponsorThanks: text.default(englishDefaults.sponsorThanks),
  })
  .default(englishDefaults);

/** The texts of the invite flow in one language. */
export type InviteTexts = z.infer<typeof englishInviteSchema>;

export interface Vouch {
  sponsorUserId: number | null;
  at: number;
}

export function getVouch(db: DbExecutor, userId: number): Vouch | undefined {
  return db
    .select({ sponsorUserId: proxyVouches.sponsorUserId, at: proxyVouches.at })
    .from(proxyVouches)
    .where(eq(proxyVouches.userId, userId))
    .get();
}

/** Takes a vouch back (false alarm undone, or an admin revokes it). */
export function removeVouch(db: DbExecutor, userId: number): void {
  db.delete(proxyVouches).where(eq(proxyVouches.userId, userId)).run();
}

/** Longest list offered; more names would be several screens of chat. */
export const CANDIDATES_MAX = 60;
/** Room left below the 1024 characters of a private message. */
const CHUNK_MAX = 900;

export interface Candidate {
  userId: number;
  nickname: string;
}

/**
 * Who can be asked to vouch: everybody online except the player, other restricted players and –
 * when sponsor groups are set – everybody outside of them. One entry per person, by name.
 */
export function sponsorCandidates(
  online: readonly BotClient[],
  player: BotClient,
  options: { blockGroupId: number | null; sponsorGroupIds: readonly number[] },
): Candidate[] {
  const seen = new Set<number>([player.userId]);
  const result: Candidate[] = [];
  const sorted = [...online].sort((a, b) =>
    a.nickname.localeCompare(b.nickname, 'de', { sensitivity: 'base' }),
  );
  for (const client of sorted) {
    if (seen.has(client.userId)) continue;
    if (options.blockGroupId !== null && client.serverGroups.includes(options.blockGroupId)) {
      continue;
    }
    if (
      options.sponsorGroupIds.length > 0 &&
      !client.serverGroups.some((group) => options.sponsorGroupIds.includes(group))
    ) {
      continue;
    }
    seen.add(client.userId);
    result.push({ userId: client.userId, nickname: client.nickname });
  }
  return result.slice(0, CANDIDATES_MAX);
}

/** The numbered list as private messages, split so that none exceeds the server's limit. */
export function candidateMessages(candidates: readonly Candidate[]): string[] {
  const messages: string[] = [];
  let current = '';
  candidates.forEach((candidate, index) => {
    // BBCode in a nickname must not format the list.
    const line = `${String(index + 1)} – ${candidate.nickname.replaceAll('[', '\\[')}`;
    if (current !== '' && current.length + line.length + 1 > CHUNK_MAX) {
      messages.push(current);
      current = '';
    }
    current = current === '' ? line : `${current}\n${line}`;
  });
  if (current !== '') messages.push(current);
  return messages;
}

/** The invite texts for one client, in their language. */
export function inviteTexts(context: InviteContext, client: BotClient): InviteTexts {
  const { english, language } = context;
  return english && language?.(client) === 'en' ? english : context.settings;
}

/** Answers are understood in both languages, whichever the question was asked in. */
function answerOf(context: InviteContext, message: string): 'yes' | 'no' | undefined {
  const said = message.trim().toLowerCase();
  const sets = [context.settings, ...(context.english ? [context.english] : [])];
  if (sets.some((texts) => said === texts.yesWord.toLowerCase())) return 'yes';
  if (sets.some((texts) => said === texts.noWord.toLowerCase())) return 'no';
  return undefined;
}

/** A player who was shown the list and has not been vouched for yet. */
interface Request {
  player: BotClient;
  candidates: Candidate[];
  attempts: number;
  /** Connection id of the sponsor who is being asked right now. */
  asking: number | undefined;
}

interface Question {
  requesterClid: number;
  askedAt: number;
}

export interface InviteContext {
  settings: ProxyInviteSettings;
  /** English texts; undefined while they are switched off. */
  english?: InviteTexts | undefined;
  /** Language of a client, by their country. */
  language?: (client: BotClient) => Language;
  /** Group that restricts the player until somebody vouched; null = none. */
  blockGroupId: number | null;
  actions: ModuleActions;
}

/**
 * Invite flow of the proxy check: a player connecting through a VPN or proxy names somebody
 * who is online, by the number in a list. That person is asked and, on a yes, becomes the
 * sponsor on record: the player loses the restricting group, gets the whitelist group and is
 * moved to the sponsor – unless the sponsor sits in an AFK channel.
 *
 * The state lives in memory only; after a restart the player is shown the list again on their
 * next join.
 */
export class ProxyInvites {
  private readonly requests = new Map<number, Request>();
  /** Open questions by the connection id of the sponsor. */
  private readonly questions = new Map<number, Question>();

  constructor(private readonly deps: AutomationDeps & { online: () => readonly BotClient[] }) {}

  /** Shows the list to a freshly detected player. */
  async start(player: BotClient, context: InviteContext): Promise<void> {
    const { settings, actions, blockGroupId } = context;
    if (actions.dryRun) {
      actions.note('proxy.invite', player, 'Liste der Bürgen');
      return;
    }
    const candidates = sponsorCandidates(this.deps.online(), player, {
      blockGroupId,
      sponsorGroupIds: settings.sponsorGroupIds,
    });
    this.requests.set(player.clid, { player, candidates, attempts: 0, asking: undefined });
    const texts = inviteTexts(context, player);
    if (candidates.length === 0) {
      await actions.message(player, texts.nobodyMessage, 'niemand zum Bürgen online');
      return;
    }
    await actions.message(player, texts.intro, 'Einladung: Auswahl');
    for (const message of candidateMessages(candidates)) {
      await actions.message(player, message, 'Einladung: Liste');
    }
  }

  /** True when the message belonged to the invite flow. */
  async onMessage(client: BotClient, message: string, context: InviteContext): Promise<boolean> {
    const question = this.questions.get(client.clid);
    if (question) return this.answer(client, question, message, context);
    const request = this.requests.get(client.clid);
    if (request) {
      await this.choose(request, message, context);
      return true;
    }
    return false;
  }

  private async choose(request: Request, message: string, context: InviteContext): Promise<void> {
    const { settings, actions } = context;
    const { player } = request;
    const texts = inviteTexts(context, player);
    if (request.asking !== undefined) return;
    const number = /^\s*#?(\d{1,3})\s*$/.exec(message)?.[1];
    const candidate = number === undefined ? undefined : request.candidates[Number(number) - 1];
    if (!candidate) {
      await actions.message(player, texts.intro, 'Einladung: keine gültige Nummer');
      return;
    }
    if (request.attempts >= settings.maxAttempts) {
      await actions.message(player, texts.exhaustedMessage, 'Einladung: Versuche aufgebraucht');
      return;
    }
    // The sponsor may have left or may be answering somebody else right now.
    const sponsor = this.deps
      .online()
      .find((client) => client.userId === candidate.userId && !this.questions.has(client.clid));
    if (!sponsor) {
      await actions.message(
        player,
        fillTemplate(texts.timeoutMessage, { name: candidate.nickname }),
        'Einladung: Bürge nicht erreichbar',
      );
      return;
    }
    request.attempts++;
    request.asking = sponsor.clid;
    this.questions.set(sponsor.clid, { requesterClid: player.clid, askedAt: this.deps.now() });
    // The sponsor is asked in their own language, with the words of that language.
    const asked = inviteTexts(context, sponsor);
    const question = fillTemplate(asked.sponsorQuestion, { name: player.nickname })
      .replaceAll('{yes}', asked.yesWord)
      .replaceAll('{no}', asked.noWord);
    await actions.message(sponsor, question, `Anfrage von „${player.nickname}“`);
    await actions.message(
      player,
      fillTemplate(texts.askedMessage, { name: sponsor.nickname }),
      `Bürge gefragt: „${sponsor.nickname}“`,
    );
  }

  private async answer(
    sponsor: BotClient,
    question: Question,
    message: string,
    context: InviteContext,
  ): Promise<boolean> {
    const { settings, actions } = context;
    const answer = answerOf(context, message);
    if (answer === undefined) return false;
    const yes = answer === 'yes';
    this.questions.delete(sponsor.clid);
    const request = this.requests.get(question.requesterClid);
    if (!request) return true;
    request.asking = undefined;
    const { player } = request;
    if (!yes) {
      actions.note('proxy.declined', player, `abgelehnt von „${sponsor.nickname}“`);
      await this.retry(request, 'declinedMessage', sponsor.nickname, context);
      return true;
    }

    this.requests.delete(player.clid);
    const { db } = this.deps.database;
    const at = this.deps.now();
    db.insert(proxyVouches)
      .values({ userId: player.userId, sponsorUserId: sponsor.userId, at })
      .onConflictDoUpdate({
        target: proxyVouches.userId,
        set: { sponsorUserId: sponsor.userId, at },
      })
      .run();
    actions.note('proxy.vouched', player, `gebürgt von „${sponsor.nickname}“`);

    const { blockGroupId } = context;
    if (blockGroupId !== null && player.serverGroups.includes(blockGroupId)) {
      const removed = await actions.removeGroup(player, blockGroupId);
      if (removed) player.serverGroups = player.serverGroups.filter((g) => g !== blockGroupId);
    }
    const whitelist = settings.whitelistGroupId;
    if (whitelist !== null && !player.serverGroups.includes(whitelist)) {
      const added = await actions.addGroup(player, whitelist);
      if (added) player.serverGroups = [...player.serverGroups, whitelist];
    }
    await actions.message(
      player,
      fillTemplate(inviteTexts(context, player).acceptedMessage, { name: sponsor.nickname }),
    );
    await actions.message(
      sponsor,
      fillTemplate(inviteTexts(context, sponsor).sponsorThanks, { name: player.nickname }),
    );
    const afk = loadActivitySettings(db).afkChannelIds;
    if (!afk.includes(sponsor.channelId) && sponsor.channelId !== player.channelId) {
      await actions.move(player, sponsor.channelId, `zu „${sponsor.nickname}“`);
    }
    return true;
  }

  /** Tells the player that this sponsor did not work out and whether they may try another. */
  private async retry(
    request: Request,
    template: 'declinedMessage' | 'timeoutMessage',
    sponsorName: string,
    context: InviteContext,
  ): Promise<void> {
    const { settings, actions } = context;
    const texts = inviteTexts(context, request.player);
    await actions.message(request.player, fillTemplate(texts[template], { name: sponsorName }));
    if (request.attempts >= settings.maxAttempts) {
      await actions.message(request.player, texts.exhaustedMessage, 'Versuche aufgebraucht');
    }
  }

  /** Sponsors who did not answer in time; called after every poll. */
  async expire(context: InviteContext): Promise<void> {
    const now = this.deps.now();
    for (const [sponsorClid, question] of this.questions) {
      if (now - question.askedAt < context.settings.timeoutS) continue;
      this.questions.delete(sponsorClid);
      const request = this.requests.get(question.requesterClid);
      if (!request) continue;
      request.asking = undefined;
      const name =
        this.deps.online().find((client) => client.clid === sponsorClid)?.nickname ?? '?';
      await this.retry(request, 'timeoutMessage', name, context);
    }
  }

  /**
   * A client left: their own request ends, and a player waiting for them may choose again.
   * Returns the waiting player, if any, so the caller can tell them.
   */
  onLeft(client: BotClient): BotClient | undefined {
    const own = this.requests.get(client.clid);
    if (own?.asking !== undefined) this.questions.delete(own.asking);
    this.requests.delete(client.clid);
    const question = this.questions.get(client.clid);
    if (!question) return undefined;
    this.questions.delete(client.clid);
    const request = this.requests.get(question.requesterClid);
    if (!request) return undefined;
    request.asking = undefined;
    return request.player;
  }

  /** Whether a player has been shown the list on this connection. */
  isWaiting(clid: number): boolean {
    return this.requests.has(clid);
  }
}
