import { describe, expect, it } from 'vitest';
import {
  findForbidden,
  patternProblem,
  simplifyNickname,
  type NicknamePattern,
} from './nickname-check.js';

const text = (pattern: string, message?: string): NicknamePattern => ({
  pattern,
  regex: false,
  message,
});
const regex = (pattern: string): NicknamePattern => ({ pattern, regex: true });

describe('simplifyNickname', () => {
  it('reads imitated letters as the letter they imitate', () => {
    for (const nickname of [
      'Admin',
      'ＡＤＭＩＮ',
      'Аdmіn',
      '4dm1n',
      'a-d m_i.n',
      'Ädmîn',
      '@dm!n',
    ]) {
      expect(simplifyNickname(nickname)).toBe('admin');
    }
  });

  it('does not tell l and i apart', () => {
    expect(simplifyNickname('Adm|n')).toBe('admin');
    expect(simplifyNickname('Admln')).toBe('admin');
    expect(simplifyNickname('Lilli')).toBe('iiiii');
  });

  it('keeps other scripts and drops symbols', () => {
    expect(simplifyNickname('★ 東京 ★')).toBe('東京');
    expect(simplifyNickname('Straße')).toBe('strasse');
    expect(simplifyNickname('💀')).toBe('');
  });
});

describe('findForbidden', () => {
  it('finds plain text anywhere in the nickname, ignoring case', () => {
    const patterns = [text('admin')];
    expect(findForbidden('xX_ADMIN_Xx', patterns, false)).toBe(patterns[0]);
    expect(findForbidden('Alice', patterns, false)).toBeUndefined();
  });

  it('only sees through lookalikes when asked to', () => {
    const patterns = [text('admin')];
    expect(findForbidden('Аdm1n', patterns, false)).toBeUndefined();
    expect(findForbidden('Аdm1n', patterns, true)).toBe(patterns[0]);
    expect(findForbidden('A-d-m-i-n', patterns, true)).toBe(patterns[0]);
  });

  it('simplifies the pattern the same way as the nickname', () => {
    expect(findForbidden('serverleiter', [text('Server-Leiter')], true)).toBeDefined();
    expect(findForbidden('Serveriejter', [text('Server-Leiter')], true)).toBeUndefined();
  });

  it('applies a regular expression to the nickname and to its simplified form', () => {
    const patterns = [regex('^mod(erator)?$')];
    expect(findForbidden('Moderator', patterns, false)).toBe(patterns[0]);
    expect(findForbidden('Moderatorin', patterns, false)).toBeUndefined();
    expect(findForbidden('M0d', patterns, false)).toBeUndefined();
    expect(findForbidden('M0d', patterns, true)).toBe(patterns[0]);
  });

  it('returns the first pattern that matches, with its own text', () => {
    const patterns = [text('owner'), text('admin', 'Du bist kein Admin.'), regex('adm')];
    expect(findForbidden('Admin', patterns, false)?.message).toBe('Du bist kein Admin.');
  });

  it('never matches with a pattern that cannot be used', () => {
    expect(
      findForbidden('Alice', [text('   '), regex('('), regex('(a+)+$')], true),
    ).toBeUndefined();
    expect(
      findForbidden('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', [regex('(a+)+$')], true),
    ).toBeUndefined();
  });
});

describe('patternProblem', () => {
  it('accepts usable patterns', () => {
    expect(patternProblem(text('admin'))).toBeUndefined();
    expect(patternProblem(regex('[a4]dm[i1]n'))).toBeUndefined();
    expect(patternProblem(regex('^(mod|admin)s?$'))).toBeUndefined();
  });

  it('names what is wrong with the others', () => {
    expect(patternProblem(text(''))).toBe('empty');
    expect(patternProblem(text('---'))).toBe('empty');
    expect(patternProblem(text('x'.repeat(201)))).toBe('too_long');
    expect(patternProblem(regex('[a-'))).toBe('invalid');
    expect(patternProblem(regex('(x+)*y'))).toBe('slow');
  });
});
