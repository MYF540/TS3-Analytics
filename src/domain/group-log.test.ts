import { describe, expect, it } from 'vitest';
import { logPosition, parseGroupChange } from './group-log.js';

describe('parseGroupChange', () => {
  it('parses additions in the old format (no nickname)', () => {
    expect(
      parseGroupChange(
        "2026-09-19 18:22:01.123456|INFO    |VirtualServer |1  |client (id:17) was added to servergroup 'Server Admin'(id:6) by client 'Admin'(id:2)",
      ),
    ).toEqual({
      at: Date.UTC(2026, 8, 19, 18, 22, 1) / 1000,
      micros: 123_456,
      action: 'added',
      dbid: 17,
      nickname: undefined,
      groupId: 6,
      groupName: 'Server Admin',
      invokerName: 'Admin',
      invokerDbid: 2,
    });
  });

  it('parses removals with nickname and odd characters', () => {
    expect(
      parseGroupChange(
        "2026-09-19 18:22:01.5|INFO    |VirtualServer |1  |client 'B(o)b|x'(id:9) was removed from servergroup 'V.I.P'(id:10) by client 'server'(id:1)",
      ),
    ).toMatchObject({
      micros: 500_000,
      action: 'removed',
      dbid: 9,
      nickname: 'B(o)b|x',
      groupId: 10,
      groupName: 'V.I.P',
    });
  });

  it('ignores every other log line (e.g. connections with IP addresses)', () => {
    for (const line of [
      "2026-09-19 18:22:01.123456|INFO    |VirtualServerBase|1  |client connected 'Bob'(id:9) from 203.0.113.5:51234",
      "2026-09-19 18:22:01.123456|INFO    |VirtualServer |1  |client (id:17) was added to channelgroup 'Channel Admin'(id:5) by client 'Admin'(id:2) in channel 'Lobby'(id:1)",
      '',
      'garbage',
    ]) {
      expect(parseGroupChange(line)).toBeUndefined();
    }
  });

  it('orders entries by timestamp and microseconds', () => {
    expect(logPosition({ at: 10, micros: 5 })).toBeLessThan(logPosition({ at: 10, micros: 6 }));
    expect(logPosition({ at: 10, micros: 999_999 })).toBeLessThan(
      logPosition({ at: 11, micros: 0 }),
    );
  });
});
