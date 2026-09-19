import { describe, expect, it } from 'vitest';
import { nicknameCandidate, useWithFreeNickname } from './nickname.js';

const inUse = Object.assign(new Error('nickname is already in use'), { id: '513' });

describe('nicknameCandidate', () => {
  it('numbers alternatives and keeps within 30 characters', () => {
    expect(nicknameCandidate('TS3 Analytics', 1)).toBe('TS3 Analytics');
    expect(nicknameCandidate('TS3 Analytics', 2)).toBe('TS3 Analytics (2)');
    const long = 'A very long bot nickname here!';
    expect(long).toHaveLength(30);
    expect(nicknameCandidate(long, 3)).toBe('A very long bot nickname (3)');
    expect(nicknameCandidate(long, 3).length).toBeLessThanOrEqual(30);
  });
});

describe('useWithFreeNickname', () => {
  it('retries with numbered nicknames while the name is taken', async () => {
    const tried: string[] = [];
    const used = await useWithFreeNickname('Bot', (nick) => {
      tried.push(nick);
      return tried.length < 3 ? Promise.reject(inUse) : Promise.resolve();
    });
    expect(tried).toEqual(['Bot', 'Bot (2)', 'Bot (3)']);
    expect(used).toBe('Bot (3)');
  });

  it('passes other errors through immediately', async () => {
    const denied = Object.assign(new Error('insufficient permissions'), { id: '2568' });
    let calls = 0;
    await expect(
      useWithFreeNickname('Bot', () => {
        calls++;
        return Promise.reject(denied);
      }),
    ).rejects.toBe(denied);
    expect(calls).toBe(1);
  });

  it('gives up after ten attempts', async () => {
    let calls = 0;
    await expect(
      useWithFreeNickname('Bot', () => {
        calls++;
        return Promise.reject(inUse);
      }),
    ).rejects.toBe(inUse);
    expect(calls).toBe(10);
  });
});
