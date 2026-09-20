/**
 * Streaming reader for log files (T8.4). Reads line by line with an exact byte offset, so an
 * interrupted import continues where it stopped (`import_runs.offset`). Memory stays flat: only
 * the current line is held, and an absurdly long line is cut off instead of growing forever.
 */
import { createReadStream } from 'node:fs';

const LF = 0x0a;
const CR = 0x0d;

/** Longer "lines" are treated as garbage; the rest up to the next newline is dropped. */
export const MAX_LINE_BYTES = 64 * 1024;

export interface ReadLine {
  /** Decoded line without its line break. Invalid bytes become U+FFFD. */
  line: string;
  /** Byte offset right after this line – the point a resumed run starts at. */
  offset: number;
  /** True when the line was cut off at `MAX_LINE_BYTES`. */
  truncated: boolean;
}

/**
 * Splits a stream of chunks into lines. `startOffset` is only added to the reported offsets;
 * the caller decides where to start reading.
 */
export async function* splitLines(
  chunks: AsyncIterable<Buffer>,
  startOffset = 0,
): AsyncGenerator<ReadLine> {
  let rest: Buffer = Buffer.alloc(0);
  let offset = startOffset;
  let dropping = false;

  for await (const chunk of chunks) {
    const buffer = rest.length === 0 ? chunk : Buffer.concat([rest, chunk]);
    let start = 0;
    let index = buffer.indexOf(LF, start);
    while (index !== -1) {
      const raw = buffer.subarray(start, index);
      const consumed = index - start + 1;
      offset += consumed;
      if (dropping) {
        dropping = false;
      } else if (raw.length > MAX_LINE_BYTES) {
        yield { line: raw.toString('utf8', 0, MAX_LINE_BYTES), offset, truncated: true };
      } else {
        const end = raw.length > 0 && raw[raw.length - 1] === CR ? raw.length - 1 : raw.length;
        yield { line: raw.toString('utf8', 0, end), offset, truncated: false };
      }
      start = index + 1;
      index = buffer.indexOf(LF, start);
    }
    // Copy the leftover so the (possibly large) chunk can be freed right away.
    rest = Buffer.from(buffer.subarray(start));
    if (rest.length > MAX_LINE_BYTES) {
      offset += rest.length;
      if (!dropping) {
        yield { line: rest.toString('utf8', 0, MAX_LINE_BYTES), offset, truncated: true };
      }
      rest = Buffer.alloc(0);
      dropping = true;
    }
  }

  if (rest.length > 0 && !dropping) {
    offset += rest.length;
    const end = rest.length > 0 && rest[rest.length - 1] === CR ? rest.length - 1 : rest.length;
    yield { line: rest.toString('utf8', 0, end), offset, truncated: false };
  }
}

/** Lines of a log file, starting at `start` bytes (from a previous, interrupted run). */
export function readLogFile(path: string, start = 0): AsyncGenerator<ReadLine> {
  const stream = createReadStream(path, { start, highWaterMark: 256 * 1024 });
  return splitLines(stream, start);
}
