import { describe, expect, it } from 'vitest';
import { DEFAULT_ACTIVITY_SETTINGS, determineState, type ClientActivity } from './activity.js';

const settings = { ...DEFAULT_ACTIVITY_SETTINGS, idleThresholdS: 600, afkChannelIds: [9] };
const base: ClientActivity = { channelId: 1, idleMs: 0, away: false, outputMuted: false };

describe('determineState', () => {
  it('is active below the idle threshold', () => {
    expect(determineState(base, settings)).toBe('active');
    expect(determineState({ ...base, idleMs: 599_999 }, settings)).toBe('active');
  });

  it('is idle from the idle threshold on', () => {
    expect(determineState({ ...base, idleMs: 600_000 }, settings)).toBe('idle');
    expect(determineState({ ...base, idleMs: 7_200_000 }, settings)).toBe('idle');
  });

  it('is afk in an AFK channel, regardless of idle time', () => {
    expect(determineState({ ...base, channelId: 9 }, settings)).toBe('afk');
    expect(determineState({ ...base, channelId: 9, idleMs: 9_999_999 }, settings)).toBe('afk');
  });

  it('is afk with away status or muted speakers when enabled', () => {
    expect(determineState({ ...base, away: true }, settings)).toBe('afk');
    expect(determineState({ ...base, outputMuted: true, idleMs: 700_000 }, settings)).toBe('afk');
  });

  it('ignores away status and muted speakers when disabled', () => {
    const lenient = { ...settings, awayIsAfk: false, outputMutedIsAfk: false };
    expect(determineState({ ...base, away: true }, lenient)).toBe('active');
    expect(determineState({ ...base, outputMuted: true, idleMs: 700_000 }, lenient)).toBe('idle');
  });

  it('ignores a muted microphone (listening counts)', () => {
    expect(determineState({ ...base }, settings)).toBe('active');
  });
});
