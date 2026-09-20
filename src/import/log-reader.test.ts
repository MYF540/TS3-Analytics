import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isQueryLine, parseLogLine } from './log-parser.js';
import { MAX_LINE_BYTES, readLogFile, splitLines } from './log-reader.js';

const dir = mkdtempSync(join(tmpdir(), 'ts3a-import-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/require-await -- a generator standing in for a stream
async function* chunks(...parts: string[]): AsyncGenerator<Buffer> {
  for (const part of parts) yield Buffer.from(part, 'utf8');
}

async function collect(gen: AsyncIterable<{ line: string; offset: number }>) {
  const out: { line: string; offset: number }[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

function writeFile(name: string, content: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('splitLines', () => {
  it('reports the byte offset after each line', async () => {
    expect(await collect(splitLines(chunks('eins\nzwei\ndrei')))).toEqual([
      { line: 'eins', offset: 5, truncated: false },
      { line: 'zwei', offset: 10, truncated: false },
      { line: 'drei', offset: 14, truncated: false },
    ]);
  });

  it('counts bytes, not characters', async () => {
    expect(await collect(splitLines(chunks('äöü\n')))).toEqual([
      { line: 'äöü', offset: 7, truncated: false },
    ]);
  });

  it('joins a line split across chunks', async () => {
    expect(await collect(splitLines(chunks('ei', 'ns\nzw', 'ei\n')))).toEqual([
      { line: 'eins', offset: 5, truncated: false },
      { line: 'zwei', offset: 10, truncated: false },
    ]);
  });

  it('keeps a multi-byte character that is split across chunks', async () => {
    const bytes = Buffer.from('ä\n', 'utf8');
    // eslint-disable-next-line @typescript-eslint/require-await -- see above
    async function* halves(): AsyncGenerator<Buffer> {
      yield bytes.subarray(0, 1);
      yield bytes.subarray(1);
    }
    expect(await collect(splitLines(halves()))).toEqual([
      { line: 'ä', offset: 3, truncated: false },
    ]);
  });

  it('strips a carriage return but counts it', async () => {
    expect(await collect(splitLines(chunks('eins\r\nzwei\r\n')))).toEqual([
      { line: 'eins', offset: 6, truncated: false },
      { line: 'zwei', offset: 12, truncated: false },
    ]);
  });

  it('continues at a given offset', async () => {
    expect(await collect(splitLines(chunks('zwei\n'), 5))).toEqual([
      { line: 'zwei', offset: 10, truncated: false },
    ]);
  });

  it('cuts off a line without an end and skips the rest of it', async () => {
    const long = 'x'.repeat(MAX_LINE_BYTES + 10);
    const result = await collect(splitLines(chunks(`${long}\nkurz\n`)));
    expect(result[0]).toMatchObject({ truncated: true });
    expect(result[0]?.line.length).toBe(MAX_LINE_BYTES);
    expect(result[1]).toEqual({ line: 'kurz', offset: MAX_LINE_BYTES + 16, truncated: false });
  });

  it('survives invalid bytes instead of failing', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- see above
    async function* broken(): AsyncGenerator<Buffer> {
      yield Buffer.from([0x61, 0xff, 0x0a]);
    }
    expect((await collect(splitLines(broken())))[0]?.line).toBe('a' + String.fromCharCode(0xfffd));
  });
});

describe('readLogFile', () => {
  it('reads a file line by line', async () => {
    const path = writeFile('klein.log', 'eins\nzwei\n');
    expect(await collect(readLogFile(path))).toEqual([
      { line: 'eins', offset: 5, truncated: false },
      { line: 'zwei', offset: 10, truncated: false },
    ]);
  });

  it('continues at the offset of an interrupted run', async () => {
    const path = writeFile('fortsetzen.log', 'eins\nzwei\ndrei\n');
    const first = await collect(readLogFile(path));
    const stopped = first[0]?.offset ?? 0;
    expect(await collect(readLogFile(path, stopped))).toEqual([
      { line: 'zwei', offset: 10, truncated: false },
      { line: 'drei', offset: 15, truncated: false },
    ]);
  });

  it('reads a file whose last line has no newline', async () => {
    const path = writeFile('ohne-ende.log', 'eins\nzwei');
    expect((await collect(readLogFile(path))).map((l) => l.line)).toEqual(['eins', 'zwei']);
  });
});

describe('throughput', () => {
  /** One million generated lines must not build up in memory (T8.4). */
  it('parses a million lines with flat memory use', async () => {
    const sample = [
      "2019-09-13 20:15:00.123456|INFO    |VirtualServer |4  |client connected 'Spieler'(id:1234) from 203.0.113.7:51234",
      "2019-09-13 20:15:01.123456|INFO    |VirtualServer |4  |query client connected 'Bot'(id:512) from 203.0.113.9:1",
      "2019-09-13 21:15:00.123456|INFO    |VirtualServer |4  |client disconnected 'Spieler'(id:1234) reason 'reasonmsg=Verlassen'",
      "2019-09-13 21:15:02.123456|INFO    |VirtualServerBase|4  |file download from (id:5), '/icon_1'",
    ];
    // eslint-disable-next-line @typescript-eslint/require-await -- see above
    async function* generated(): AsyncGenerator<Buffer> {
      // 64 lines per chunk, like a real read of ~8 KB.
      for (let i = 0; i < 1_000_000 / 64; i++) {
        let block = '';
        for (let j = 0; j < 64; j++) block += `${sample[(i + j) % sample.length] ?? ''}\n`;
        yield Buffer.from(block, 'utf8');
      }
    }

    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    let events = 0;
    let lines = 0;
    let peak = before;
    for await (const { line } of splitLines(generated())) {
      lines++;
      if (isQueryLine(line)) continue;
      const result = parseLogLine(line, { zone: 'utc', serverId: 4 });
      if (result.kind === 'connect' || result.kind === 'disconnect') events++;
      if (lines % 100_000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
    expect(lines).toBe(1_000_000);
    expect(events).toBe(500_000);
    expect((peak - before) / 1024 / 1024).toBeLessThan(200);
  }, 120_000);
});
