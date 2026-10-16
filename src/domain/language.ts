/** Countries whose players get the German texts; everybody else gets the English ones. */
export const GERMAN_SPEAKING = ['DE', 'AT', 'CH', 'LI'] as const;

export type Language = 'de' | 'en';

/**
 * Language of the bot's texts for a player (T12.1). German is the server's own language, so it
 * is also what a player with an unknown country gets, and what everybody gets while a module
 * has no English texts switched on.
 */
export function playerLanguage(
  country: string | null | undefined,
  englishEnabled: boolean,
): Language {
  if (!englishEnabled || !country) return 'de';
  return (GERMAN_SPEAKING as readonly string[]).includes(country.toUpperCase()) ? 'de' : 'en';
}

/**
 * True when a word that agrees in one language disagrees in the other (or in the same one).
 * Answers are understood in both languages, so such a pair could not be told apart.
 */
export function wordsCollide(agree: readonly string[], disagree: readonly string[]): boolean {
  const no = new Set(disagree.map((word) => word.trim().toLowerCase()));
  return agree.some((word) => no.has(word.trim().toLowerCase()));
}
