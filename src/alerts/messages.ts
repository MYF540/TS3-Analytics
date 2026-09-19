import type Database from 'better-sqlite3';
import type { FlagCandidate } from '../domain/flags.js';
import { escapeMarkdown } from './notifier.js';

/**
 * German Discord texts (T5.4). Only nicknames, UIDs and ban data – never IPs or hashes. Every
 * player-controlled value is escaped.
 */

function nickname(sqlite: Database.Database, userId: number): string {
  const row = sqlite
    .prepare(
      `SELECT (SELECT nick FROM nicknames WHERE user_id = u.id ORDER BY last_seen DESC LIMIT 1)
              AS nick, u.uid
       FROM users u WHERE u.id = ?`,
    )
    .get(userId) as { nick: string | null; uid: string } | undefined;
  return escapeMarkdown(row?.nick ?? row?.uid ?? `#${String(userId)}`);
}

export function flagAlert(sqlite: Database.Database, flag: FlagCandidate): string {
  const user = nickname(sqlite, flag.userId);
  const ban = `#${String(flag.banId)}`;
  if (flag.kind === 'ban_ip') {
    const text =
      flag.relatedUserId === null
        ? `nutzt eine IP-Adresse, die per IP-Ban (${ban}) gesperrt ist`
        : `nutzt dieselbe IP-Adresse wie der gebannte Spieler ${nickname(sqlite, flag.relatedUserId)}`;
    return `🔴 **Hinweis (hoch):** ${user} ${text}.`;
  }
  const text =
    flag.relatedUserId === null
      ? `ist im Subnetz eines IP-Bans (${ban})`
      : `ist im selben Subnetz wie der gebannte Spieler ${nickname(sqlite, flag.relatedUserId)}`;
  return `🟠 **Hinweis (mittel):** ${user} ${text}.`;
}

function duration(seconds: number): string {
  if (seconds === 0) return 'dauerhaft';
  if (seconds < 3600) return `${String(Math.round(seconds / 60))} min`;
  if (seconds < 2 * 86_400) return `${String(Math.round(seconds / 3600))} h`;
  return `${String(Math.round(seconds / 86_400))} Tage`;
}

export function banAlert(sqlite: Database.Database, banId: number): string | undefined {
  const ban = sqlite
    .prepare(
      `SELECT user_id AS userId, uid, last_nickname AS lastNickname, name_pattern AS namePattern,
              ip_hash IS NOT NULL OR ip_pattern = 1 AS ipRule, reason,
              invoker_name AS invokerName, duration_s AS durationS
       FROM bans WHERE id = ?`,
    )
    .get(banId) as
    | {
        userId: number | null;
        uid: string | null;
        lastNickname: string | null;
        namePattern: string | null;
        ipRule: number;
        reason: string | null;
        invokerName: string | null;
        durationS: number;
      }
    | undefined;
  if (!ban) return undefined;
  const target =
    ban.userId !== null
      ? nickname(sqlite, ban.userId)
      : ban.lastNickname
        ? escapeMarkdown(ban.lastNickname)
        : ban.uid
          ? escapeMarkdown(ban.uid)
          : ban.namePattern
            ? `Namensregel ${escapeMarkdown(ban.namePattern)}`
            : ban.ipRule
              ? 'IP-Regel'
              : `Ban #${String(banId)}`;
  const parts = [`⛔ **Neuer Ban:** ${target}`, `Dauer: ${duration(ban.durationS)}`];
  if (ban.reason) parts.push(`Grund: ${escapeMarkdown(ban.reason)}`);
  if (ban.invokerName) parts.push(`von ${escapeMarkdown(ban.invokerName)}`);
  return parts.join(' · ');
}

export function connectionLostAlert(minutes: number): string {
  return `⚠️ **Bot offline:** keine Verbindung zum TeamSpeak-Server seit ${String(minutes)} Minuten. Zeiten werden in dieser Zeit nicht erfasst.`;
}

export function connectionRestoredAlert(downSeconds: number): string {
  return `✅ **Bot wieder verbunden** nach ${duration(downSeconds)} ohne Verbindung.`;
}

export const TEST_ALERT =
  '🔔 Test-Nachricht von TS3 Analytics. Die Benachrichtigungen funktionieren.';
