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

/** Longest channel description the server accepts. */
export const DESCRIPTION_MAX = 8192;

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
  max = DESCRIPTION_MAX,
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
    if (text.length <= max) return text;
    const longest = limits.indexOf(Math.max(...limits));
    if (longest === -1 || (limits[longest] ?? 0) === 0) return text.slice(0, max);
    limits[longest] = (limits[longest] ?? 0) - 1;
  }
}
