import { de, type MessageKey } from './de';

export type { MessageKey };

const TIME_ZONE = 'Europe/Berlin';

/** Translates a key and fills `{placeholders}`. */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  return de[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Translation for an API error code, with a generic fallback. */
export function errorMessage(code: string): string {
  const key = `error.${code}`;
  return key in de ? de[key as MessageKey] : de['error.UNKNOWN'];
}

/** German label for an audit action code; unknown codes are shown as they are. */
export function auditActionLabel(action: string): string {
  const key = `audit.action.${action}`;
  return key in de ? de[key as MessageKey] : action;
}

const numberFormat = new Intl.NumberFormat('de-DE');
const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
  timeZone: TIME_ZONE,
  dateStyle: 'medium',
  timeStyle: 'short',
});
const dateFormat = new Intl.DateTimeFormat('de-DE', { timeZone: TIME_ZONE, dateStyle: 'medium' });

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

/** Durations are stored in seconds; shown as "12 h 5 min", "5 min" or "1.234 h". */
export function formatDuration(seconds: number): string {
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return t('unit.minutes', { value: minutes });
  const h = t('unit.hours', { value: formatNumber(hours) });
  // From 100 hours on, minutes are noise.
  return minutes === 0 || hours >= 100 ? h : `${h} ${t('unit.minutes', { value: minutes })}`;
}

const byteFormat = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

/** Bytes as "512 KB", "1,5 MB", "2,3 GB" (base 1024). */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${byteFormat.format(value)} ${units[unit] ?? 'B'}`;
}

/** Elapsed time as "vor 45 s", "vor 12 min", "vor 3 h", "vor 2 Tagen". */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t('unit.agoSeconds', { value: s });
  if (s < 3600) return t('unit.agoMinutes', { value: Math.floor(s / 60) });
  if (s < 2 * 86_400) return t('unit.agoHours', { value: Math.floor(s / 3600) });
  return t('unit.agoDays', { value: Math.floor(s / 86_400) });
}

/** Uptime as "3 Tage 4 h", "5 h 12 min" or "7 min". */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days === 0) return formatDuration(seconds);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return `${t(days === 1 ? 'unit.day' : 'unit.days', { value: days })} ${t('unit.hours', { value: hours })}`;
}

/** Unix seconds → local date and time in Europe/Berlin. */
export function formatDateTime(unixSeconds: number): string {
  return dateTimeFormat.format(new Date(unixSeconds * 1000));
}

/** YYYYMMDD → date. */
export function formatDay(day: number): string {
  const date = new Date(
    Date.UTC(Math.floor(day / 10000), (Math.floor(day / 100) % 100) - 1, day % 100, 12),
  );
  return dateFormat.format(date);
}
