import { describe, expect, it } from 'vitest';
import {
  dedupeGroups,
  renderStaffList,
  sortMembers,
  type StaffMember,
  type StaffStatus,
  type StaffTemplate,
} from './staff-list.js';

const template: StaffTemplate = {
  header: 'Unser Team',
  footer: '',
  groupLine: '[b]{group}[/b]',
  memberLine: '{name} – {status}',
  online: 'online',
  away: 'abwesend',
  offline: 'offline',
  empty: 'niemand',
  hideEmptyGroups: false,
  clickable: false,
};

const member = (nickname: string, status: StaffStatus = 'offline'): StaffMember => ({
  uid: `uid-${nickname}`,
  nickname,
  status,
});

describe('renderStaffList', () => {
  it('lists every group with its members, the available ones first', () => {
    const text = renderStaffList(
      [
        { title: 'Admin', members: [member('Zoe'), member('Bob', 'online')] },
        { title: 'Moderator', members: [member('Cleo', 'away')] },
      ],
      template,
    );
    expect(text).toBe(
      [
        'Unser Team',
        '',
        '[b]Admin[/b]',
        'Bob – online',
        'Zoe – offline',
        '',
        '[b]Moderator[/b]',
        'Cleo – abwesend',
      ].join('\n'),
    );
  });

  it('shows or hides groups without members', () => {
    const groups = [{ title: 'Admin', members: [] }];
    expect(renderStaffList(groups, { ...template, header: '' })).toBe('[b]Admin[/b]\nniemand');
    expect(renderStaffList(groups, { ...template, hideEmptyGroups: true })).toBe('Unser Team');
  });

  it('links names on request and never lets a nickname act as BBCode', () => {
    const groups = [{ title: 'Admin', members: [member('[b]Fett', 'online')] }];
    expect(renderStaffList(groups, { ...template, header: '' })).toContain('\\[b]Fett – online');
    expect(renderStaffList(groups, { ...template, header: '', clickable: true })).toContain(
      '[URL=client://0/uid-[b]Fett]\\[b]Fett[/URL] – online',
    );
  });

  it('drops members from the longest group until the text fits', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      member(`Spieler${String(i).padStart(2, '0')}`),
    );
    const groups = [
      { title: 'Admin', members: [member('Bob', 'online')] },
      { title: 'Mitglieder', members: [member('Anna', 'online'), ...many] },
    ];
    const text = renderStaffList(groups, template, 400);
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toContain('Bob – online');
    expect(text).toContain('Anna – online');
    expect(text).toMatch(/… \(\+\d+\)$/);
    expect(text).not.toContain('Spieler49');
  });
});

describe('sortMembers', () => {
  it('orders by status, then by name without regard to case', () => {
    const sorted = sortMembers([
      member('bob'),
      member('Zoe', 'online'),
      member('Anna'),
      member('Cleo', 'away'),
      member('adam', 'online'),
    ]);
    expect(sorted.map((m) => m.nickname)).toEqual(['adam', 'Zoe', 'Cleo', 'Anna', 'bob']);
  });
});

describe('dedupeGroups', () => {
  const groups = [
    { title: 'Admin', members: [member('Bob')] },
    { title: 'Moderator', members: [member('Bob'), member('Cleo')] },
  ];

  it('keeps a member only in the first group', () => {
    expect(dedupeGroups(groups, false).map((g) => g.members.map((m) => m.nickname))).toEqual([
      ['Bob'],
      ['Cleo'],
    ]);
  });

  it('keeps everything when members may appear in every group', () => {
    expect(dedupeGroups(groups, true)).toEqual(groups);
  });
});
