import { formatDuration, t, type MessageKey } from '../i18n';
import { de } from '../i18n/de';

/** Ban durations offered in forms (seconds, 0 = permanent). */
export const DURATIONS = [600, 3600, 86_400, 604_800, 2_592_000, 0] as const;

/** "1 Tag", "dauerhaft" … for presets, otherwise the formatted duration. */
export function durationLabel(seconds: number): string {
  const key = `mod.duration.${String(seconds)}`;
  return key in de ? t(key as MessageKey) : formatDuration(seconds);
}
