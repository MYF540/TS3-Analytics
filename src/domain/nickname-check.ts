/**
 * Nickname rules of the nickname checker (T10.3). Pure functions, no I/O.
 *
 * A pattern is either plain text ("admin" matches every nickname that contains it) or a regular
 * expression. With `lookalikes` a nickname is also compared in a simplified form, so that
 * "Ａdmіn", "4dm1n" and "a-d-m-i-n" all read as "admin".
 */

export interface NicknamePattern {
  pattern: string;
  /** Read `pattern` as a regular expression instead of plain text. */
  regex: boolean;
  /** Text for the player; the module's general text is used when missing. */
  message?: string | undefined;
}

export const PATTERN_MAX_LENGTH = 200;

/** Characters that are commonly used to imitate a Latin letter. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  // Cyrillic and Greek letters that look like Latin ones.
  а: 'a',
  в: 'b',
  с: 'c',
  е: 'e',
  н: 'h',
  і: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  о: 'o',
  р: 'p',
  ѕ: 's',
  т: 't',
  у: 'y',
  х: 'x',
  α: 'a',
  β: 'b',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  // Digits and symbols in "leetspeak".
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  // Letters NFKD does not take apart.
  ß: 'ss',
  ø: 'o',
  đ: 'd',
  ł: 'l',
  æ: 'ae',
  œ: 'oe',
};

/**
 * The simplified form used for lookalike matching: compatibility forms and accents resolved,
 * lower case, imitated letters replaced, everything that is not a letter or digit removed, and
 * "l" read as "i" (they are indistinguishable in most fonts).
 */
export function simplifyNickname(nickname: string): string {
  let result = '';
  for (const char of nickname.normalize('NFKD').toLowerCase()) {
    const mapped = LOOKALIKES[char] ?? char;
    if (/^[\p{L}\p{N}]+$/u.test(mapped)) result += mapped;
  }
  return result.replace(/l/g, 'i');
}

/** Why a pattern cannot be used, if so. */
export type PatternProblem = 'empty' | 'too_long' | 'invalid' | 'slow';

/**
 * A group that repeats and is repeated again, like `(a+)+` – such expressions can take minutes
 * on a single nickname. A heuristic: it rejects a few harmless expressions as well.
 */
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)[+*{]/;

function toRegExp(pattern: string): RegExp {
  return new RegExp(pattern, 'iu');
}

export function patternProblem(pattern: NicknamePattern): PatternProblem | undefined {
  if (pattern.pattern.trim() === '') return 'empty';
  if (pattern.pattern.length > PATTERN_MAX_LENGTH) return 'too_long';
  if (!pattern.regex) return simplifyNickname(pattern.pattern) === '' ? 'empty' : undefined;
  if (NESTED_QUANTIFIER.test(pattern.pattern)) return 'slow';
  try {
    toRegExp(pattern.pattern);
  } catch {
    return 'invalid';
  }
  return undefined;
}

function matches(nickname: string, pattern: NicknamePattern, lookalikes: boolean): boolean {
  if (patternProblem(pattern) !== undefined) return false;
  const simplified = lookalikes ? simplifyNickname(nickname) : undefined;
  if (pattern.regex) {
    const regex = toRegExp(pattern.pattern);
    return regex.test(nickname) || (simplified !== undefined && regex.test(simplified));
  }
  if (simplified !== undefined) return simplified.includes(simplifyNickname(pattern.pattern));
  return nickname.toLowerCase().includes(pattern.pattern.trim().toLowerCase());
}

/** The first pattern the nickname violates; unusable patterns never match. */
export function findForbidden<T extends NicknamePattern>(
  nickname: string,
  patterns: readonly T[],
  lookalikes: boolean,
): T | undefined {
  return patterns.find((pattern) => matches(nickname, pattern, lookalikes));
}
