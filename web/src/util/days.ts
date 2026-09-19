/** Calendar days as YYYYMMDD numbers (as used by the API), computed in Europe/Berlin. */

const berlinDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function berlinToday(now = new Date()): number {
  return Number(berlinDate.format(now).replaceAll('-', ''));
}

function toUtc(day: number): number {
  return Date.UTC(Math.floor(day / 10000), (Math.floor(day / 100) % 100) - 1, day % 100);
}

function fromUtc(ms: number): number {
  const d = new Date(ms);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export function addDays(day: number, n: number): number {
  return fromUtc(toUtc(day) + n * 86_400_000);
}

/** All days from `from` to `to` (inclusive). */
export function eachDay(from: number, to: number): number[] {
  const days: number[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}
