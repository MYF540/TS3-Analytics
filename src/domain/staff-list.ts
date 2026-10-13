/**
 * Staff list (T10.5): turns the members of the chosen server groups and who of them is online
 * into the BBCode text of a channel description. Pure functions, no I/O.
 */

export type StaffStatus = 'online' | 'away' | 'offline';

export interface StaffMember {
  uid: string;
  nickname: string;
  status: StaffStatus;
}

export interface StaffGroup {
  title: string;
  members: readonly StaffMember[];
}

export interface StaffTemplate {
  header: string;
  footer: string;
  /** Line above the members of a group; `{group}` is its title. */
  groupLine: string;
  /** One member; `{name}` and `{status}`. */
  memberLine: string;
  online: string;
  away: string;
  offline: string;
  /** Shown instead of members when a group has none. */
  empty: string;
  /** Leave groups without members out altogether. */
  hideEmptyGroups: boolean;
  /** Make names links that open the client's context menu. */
  clickable: boolean;
}

/**
 * Longest channel description the server accepts, in **bytes** of UTF-8 – not characters. A text
 * with umlauts or a dash is longer for the server than its character count suggests; beyond
 * the limit it answers "invalid parameter size" (error 1541).
 */
export const DESCRIPTION_MAX_BYTES = 8192;

const encoder = new TextEncoder();

/** Size of a text as the server counts it. */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** The longest beginning of `text` that fits into `maxBytes`, never cutting a character in two. */
export function truncateBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let result = '';
  let size = 0;
  for (const char of text) {
    size += byteLength(char);
    if (size > maxBytes) break;
    result += char;
  }
  return result;
}

const STATUS_ORDER: Record<StaffStatus, number> = { online: 0, away: 1, offline: 2 };

/** Keeps a nickname from being read as BBCode. */
function plain(text: string): string {
  return text.replaceAll('[', '\\[');
}

function name(member: StaffMember, clickable: boolean): string {
  const nickname = plain(member.nickname);
  // `client://<clid>/<uid>`: the client resolves the UID, the connection id may be 0.
  return clickable ? `[URL=client://0/${member.uid}]${nickname}[/URL]` : nickname;
}

/** Online first, then away, then offline; by name within each. */
export function sortMembers(members: readonly StaffMember[]): StaffMember[] {
  return [...members].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.nickname.localeCompare(b.nickname, 'de', { sensitivity: 'base' }),
  );
}

/**
 * With `showInAll` off, a member of several groups only appears in the first one (the order of
 * the groups is their rank).
 */
export function dedupeGroups(groups: readonly StaffGroup[], showInAll: boolean): StaffGroup[] {
  if (showInAll) return [...groups];
  const seen = new Set<string>();
  return groups.map((group) => {
    const members = group.members.filter((member) => !seen.has(member.uid));
    for (const member of members) seen.add(member.uid);
    return { ...group, members };
  });
}

function renderGroup(group: StaffGroup, template: StaffTemplate, limit?: number): string {
  const sorted = sortMembers(group.members);
  const shown = limit === undefined ? sorted : sorted.slice(0, limit);
  const lines = [template.groupLine.replaceAll('{group}', group.title)];
  if (sorted.length === 0) lines.push(template.empty);
  for (const member of shown) {
    lines.push(
      template.memberLine
        .replaceAll('{name}', name(member, template.clickable))
        .replaceAll('{status}', template[member.status]),
    );
  }
  if (shown.length < sorted.length) lines.push(`… (+${String(sorted.length - shown.length)})`);
  return lines.join('\n');
}

function assemble(groups: readonly string[], template: StaffTemplate): string {
  return [template.header, ...groups, template.footer].filter((part) => part !== '').join('\n\n');
}

/**
 * The description text. When it would exceed the server's limit, the longest groups lose
 * members from their end (offline ones first, thanks to the sort order) until it fits.
 */
export function renderStaffList(
  groups: readonly StaffGroup[],
  template: StaffTemplate,
  maxBytes = DESCRIPTION_MAX_BYTES,
): string {
  const visible = groups.filter(
    (group) => !(template.hideEmptyGroups && group.members.length === 0),
  );
  const limits = visible.map((group) => group.members.length);
  for (;;) {
    const text = assemble(
      visible.map((group, index) => renderGroup(group, template, limits[index])),
      template,
    );
    if (byteLength(text) <= maxBytes) return text;
    const longest = limits.indexOf(Math.max(...limits));
    // Nothing left to drop (header and footer alone are too long): cut the text itself.
    if (longest === -1 || (limits[longest] ?? 0) === 0) return truncateBytes(text, maxBytes);
    limits[longest] = (limits[longest] ?? 0) - 1;
  }
}
