/** TS3 error id for "nickname is already in use". */
export const NICKNAME_IN_USE = '513';
const MAX_NICKNAME_LENGTH = 30;
const MAX_ATTEMPTS = 10;

/** `base`, then `base (2)`, `base (3)`, … – shortened so the suffix fits into 30 characters. */
export function nicknameCandidate(base: string, attempt: number): string {
  if (attempt <= 1) return base.slice(0, MAX_NICKNAME_LENGTH);
  const suffix = ` (${String(attempt)})`;
  return base.slice(0, MAX_NICKNAME_LENGTH - suffix.length).trimEnd() + suffix;
}

function isNicknameInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'id' in error &&
    String(error.id) === NICKNAME_IN_USE
  );
}

/**
 * Calls `use(nickname)` with the configured nickname and, while TS3 answers "nickname in use",
 * with numbered variants. Other errors are passed through. Returns the nickname that was used.
 */
export async function useWithFreeNickname(
  base: string,
  use: (nickname: string) => Promise<unknown>,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const nickname = nicknameCandidate(base, attempt);
    try {
      await use(nickname);
      return nickname;
    } catch (error) {
      if (!isNicknameInUse(error) || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
}
