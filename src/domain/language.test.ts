import { describe, expect, it } from 'vitest';
import { playerLanguage, wordsCollide } from './language.js';

describe('playerLanguage', () => {
  it('gives German to the German-speaking countries and English to the rest', () => {
    for (const country of ['DE', 'AT', 'CH', 'LI', 'de']) {
      expect(playerLanguage(country, true)).toBe('de');
    }
    for (const country of ['US', 'GB', 'PL', 'NL']) {
      expect(playerLanguage(country, true)).toBe('en');
    }
  });

  it('falls back to German for an unknown country', () => {
    expect(playerLanguage(null, true)).toBe('de');
    expect(playerLanguage(undefined, true)).toBe('de');
    expect(playerLanguage('', true)).toBe('de');
  });

  it('always gives German while the English texts are off', () => {
    expect(playerLanguage('US', false)).toBe('de');
  });
});

describe('wordsCollide', () => {
  it('finds a word that agrees and disagrees, ignoring case and spaces', () => {
    expect(wordsCollide(['ja', 'yes'], ['nein', 'no'])).toBe(false);
    expect(wordsCollide(['ja', 'No'], ['nein', ' no '])).toBe(true);
  });
});
