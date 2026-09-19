import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_FILE_BASENAME, scrubIps } from './logger.js';

export interface LogProblem {
  /** UTC seconds of the newest occurrence. */
  at: number;
  level: 'warn' | 'error' | 'fatal';
  message: string;
  /** Error message or job name, if the entry has one. */
  detail: string | undefined;
  /** Consecutive identical entries folded into this one. */
  count: number;
}

const LEVELS: Record<number, LogProblem['level']> = { 40: 'warn', 50: 'error', 60: 'fatal' };
const MAX_TEXT = 300;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? scrubIps(value).slice(0, MAX_TEXT) : undefined;
}

function parse(line: string): LogProblem | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof entry !== 'object' || entry === null) return undefined;
  const e = entry as Record<string, unknown>;
  const level = typeof e.level === 'number' ? LEVELS[e.level] : undefined;
  if (!level) return undefined;
  const at = typeof e.time === 'string' ? Date.parse(e.time) : Number(e.time);
  if (!Number.isFinite(at)) return undefined;
  const err = typeof e.err === 'object' && e.err !== null ? (e.err as Record<string, unknown>) : {};
  const job = typeof e.job === 'string' ? `Job ${e.job}` : undefined;
  return {
    at: Math.floor(at / 1000),
    level,
    message: text(e.msg) ?? '',
    detail: text(err.message) ?? job,
    count: 1,
  };
}

/** The last `maxBytes` of a file, without the first (probably cut) line. */
function tail(path: string, maxBytes: number): string[] {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  return lines;
}

/**
 * Newest warnings and errors from the rotated log files, newest first. Log lines are already
 * redacted and free of IPs; messages are scrubbed again anyway before they reach the browser.
 * Reads at most `maxBytes` from the end of each of the newest `maxFiles` files.
 */
export function recentLogProblems(
  dir: string,
  { limit = 20, maxFiles = 3, maxBytes = 512 * 1024 } = {},
): LogProblem[] {
  let files: { path: string; mtime: number }[];
  try {
    files = readdirSync(dir)
      .filter((name) => name.startsWith(`${LOG_FILE_BASENAME}.`) && name.endsWith('.log'))
      .map((name) => {
        const path = join(dir, name);
        return { path, mtime: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, maxFiles);
  } catch {
    return [];
  }

  const problems: LogProblem[] = [];
  for (const file of files) {
    let lines: string[];
    try {
      lines = tail(file.path, maxBytes);
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const problem = parse(lines[i] ?? '');
      if (!problem) continue;
      const previous = problems.at(-1);
      if (
        previous &&
        previous.message === problem.message &&
        previous.detail === problem.detail &&
        previous.level === problem.level
      ) {
        previous.count++;
        continue;
      }
      if (problems.length === limit) return problems;
      problems.push(problem);
    }
  }
  return problems;
}
