import { describe, expect, it } from 'vitest';
import {
  isQueryLine,
  orderLogFiles,
  parseHeader,
  parseLogFileName,
  parseLogLine,
  toUnix,
} from './log-parser.js';

const utc = { zone: 'utc' } as const;
const at = (text: string) => Date.parse(`${text}Z`) / 1000;

/** Builds a log line the way the server writes it. */
function line(message: string, time = '2019-09-13 20:15:00.123456', serverId = '4  '): string {
  return `${time}|INFO    |VirtualServer |${serverId}|${message}`;
}

describe('parseHeader', () => {
  it('reads timestamp, level, component and virtual server', () => {
    expect(parseHeader(line('stopped'), 'utc')).toEqual({
      at: at('2019-09-13T20:15:00'),
      level: 'INFO',
      component: 'VirtualServer',
      serverId: 4,
      message: 'stopped',
    });
  });

  it('accepts the BOM in the first line of a file', () => {
    expect(parseHeader(`${String.fromCharCode(0xfeff)}${line('stopped')}`, 'utc')?.message).toBe(
      'stopped',
    );
  });

  it('keeps a pipe inside the nickname in the message', () => {
    const header = parseHeader(line("client connected 'a|b'(id:7) from 203.0.113.7:1"), 'utc');
    expect(header?.message).toBe("client connected 'a|b'(id:7) from 203.0.113.7:1");
  });

  it('rejects a damaged line', () => {
    expect(parseHeader('0000002019-09-17 17:35:04.|INFO    |VirtualServer |4  |x', 'utc')).toBe(
      undefined,
    );
  });
});

describe('toUnix', () => {
  const parts = { year: 2019, month: 9, day: 13, hour: 20, minute: 15, second: 0 };

  it('reads the time as UTC', () => {
    expect(toUnix(parts, 'utc')).toBe(at('2019-09-13T20:15:00'));
  });

  it('reads the time as Berlin local time, summer and winter', () => {
    expect(toUnix(parts, 'berlin')).toBe(at('2019-09-13T18:15:00'));
    expect(toUnix({ ...parts, month: 12 }, 'berlin')).toBe(at('2019-12-13T19:15:00'));
  });
});

describe('parseLogLine', () => {
  it('reads a connection with nickname, database id and address', () => {
    expect(
      parseLogLine(line("client connected 'Spieler'(id:1234) from 203.0.113.7:51234"), utc),
    ).toEqual({
      kind: 'connect',
      at: at('2019-09-13T20:15:00'),
      nick: 'Spieler',
      dbid: 1234,
      ip: '203.0.113.7',
    });
  });

  it('reads the myTeamSpeak variant the same way', () => {
    const raw = line(
      "client connected 'Spieler'(id:1234) using a myTeamSpeak ID from 203.0.113.7:51234",
    );
    expect(parseLogLine(raw, utc)).toMatchObject({ kind: 'connect', dbid: 1234, nick: 'Spieler' });
  });

  it('reads an IPv6 address', () => {
    const raw = line("client connected 'Spieler'(id:1234) from [2001:db8::1]:51234");
    expect(parseLogLine(raw, utc)).toMatchObject({ ip: '[2001:db8::1]' });
  });

  it('keeps nicknames with a pipe or an apostrophe intact', () => {
    expect(
      parseLogLine(line("client connected 'a|b'(id:7) from 203.0.113.7:1"), utc),
    ).toMatchObject({ nick: 'a|b', dbid: 7 });
    expect(
      parseLogLine(line("client connected 'Smii'Simon'(id:7) from 203.0.113.7:1"), utc),
    ).toMatchObject({ nick: "Smii'Simon", dbid: 7 });
  });

  it('reads a disconnection with its reason', () => {
    expect(
      parseLogLine(line("client disconnected 'Spieler'(id:1234) reason 'reasonmsg=Tschüss'"), utc),
    ).toEqual({
      kind: 'disconnect',
      at: at('2019-09-13T20:15:00'),
      nick: 'Spieler',
      dbid: 1234,
      reason: 'reasonmsg=Tschüss',
      invoked: false,
    });
  });

  it('marks a disconnection caused by somebody else', () => {
    const raw = line(
      "client disconnected 'Spieler'(id:1234) reason 'invokerid=3 invokername=Admin invokeruid=uid= reasonmsg=Ruhe jetzt'",
    );
    expect(parseLogLine(raw, utc)).toMatchObject({ kind: 'disconnect', invoked: true });
  });

  it('accepts an empty reason', () => {
    expect(
      parseLogLine(line("client disconnected 'Spieler'(id:1234) reason 'reasonmsg'"), utc),
    ).toMatchObject({ kind: 'disconnect', reason: 'reasonmsg', invoked: false });
  });

  it('reads both directions of a server group change', () => {
    expect(
      parseLogLine(
        line("client (id:1234) was added to servergroup 'Mitglied'(id:12) by client 'Admin'(id:2)"),
        utc,
      ),
    ).toEqual({
      kind: 'group',
      at: at('2019-09-13T20:15:00'),
      added: true,
      dbid: 1234,
      groupId: 12,
      groupName: 'Mitglied',
      byDbid: 2,
      byName: 'Admin',
    });
    expect(
      parseLogLine(
        line(
          "client (id:1234) was removed from servergroup 'Mitglied'(id:12) by client 'Admin'(id:2)",
        ),
        utc,
      ),
    ).toMatchObject({ kind: 'group', added: false });
  });

  it('reads server start and stop', () => {
    expect(parseLogLine(line('listening on 203.0.113.7:9987, [::]:9987'), utc)).toMatchObject({
      kind: 'serverStart',
    });
    expect(parseLogLine(line('stopped'), utc)).toMatchObject({ kind: 'serverStop' });
  });

  it('ignores query clients without looking at the header', () => {
    expect(isQueryLine(line("query client connected 'Bot'(id:512) from 203.0.113.7:1"))).toBe(true);
    expect(
      parseLogLine(line("query client connected 'Bot'(id:512) from 203.0.113.7:1"), utc),
    ).toEqual({ kind: 'ignored' });
  });

  it('ignores the known noise', () => {
    for (const message of [
      "file download from (id:5), '/icon_1'",
      "channel 'Talk'(id:3) edited by 'Admin'(id:2)",
      'Dropping client 12 because of ping timeout 1 2 3',
      'Cleaning up connection because of 5 resends of COMMAND packet',
    ]) {
      expect(parseLogLine(line(message), utc)).toEqual({ kind: 'ignored' });
    }
  });

  it('ignores the myTeamSpeak note, which is known but useless here', () => {
    expect(parseLogLine(line("client 'Spieler'(id:7) changed myTeamSpeak ID"), utc)).toEqual({
      kind: 'ignored',
    });
  });

  it('reports an unknown message and a damaged line', () => {
    expect(parseLogLine(line('client did something new'), utc)).toEqual({ kind: 'unparsed' });
    expect(parseLogLine('kaputt', utc)).toEqual({ kind: 'unparsed' });
    expect(parseLogLine('', utc)).toEqual({ kind: 'ignored' });
  });

  it('ignores lines of another virtual server', () => {
    const raw = line("client connected 'Spieler'(id:1) from 203.0.113.7:1", undefined, '2  ');
    expect(parseLogLine(raw, { zone: 'utc', serverId: 4 })).toEqual({ kind: 'ignored' });
    expect(parseLogLine(raw, { zone: 'utc', serverId: 2 })).toMatchObject({ kind: 'connect' });
  });
});

describe('log file names', () => {
  it('reads timestamp and virtual server', () => {
    expect(parseLogFileName('ts3server_2019-09-13__03_35_27.597751_4.log', 'utc')).toEqual({
      name: 'ts3server_2019-09-13__03_35_27.597751_4.log',
      startedAt: at('2019-09-13T03:35:27'),
      serverId: 4,
    });
    expect(parseLogFileName('irgendwas.log', 'utc')).toBe(undefined);
  });

  it('sorts by time and drops other servers', () => {
    const names = [
      'ts3server_2020-01-02__00_00_00.000000_4.log',
      'ts3server_2019-09-13__03_35_27.597751_4.log',
      'ts3server_2019-09-13__03_35_27.597751_0.log',
      'notizen.txt',
    ];
    expect(orderLogFiles(names, { zone: 'utc', serverId: 4 }).map((f) => f.name)).toEqual([
      'ts3server_2019-09-13__03_35_27.597751_4.log',
      'ts3server_2020-01-02__00_00_00.000000_4.log',
    ]);
  });
});
