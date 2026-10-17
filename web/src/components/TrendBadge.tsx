import type { TrendDirection } from '../api/types';
import { t } from '../i18n';

/** Arrow up (rising), bar (flat) or arrow down (falling). */
function TrendIcon({ direction }: { direction: TrendDirection }) {
  return (
    <svg className="trend__icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {direction === 'up' && <path d="M6 1.5 10.5 7H7.5v3.5h-3V7H1.5z" />}
      {direction === 'down' && <path d="M6 10.5 1.5 5h3V1.5h3V5h3z" />}
      {direction === 'flat' && <rect x="1.5" y="4.5" width="9" height="3" rx="1" />}
    </svg>
  );
}

/**
 * Trend marker: green arrow up for rising, blue bar for unchanged, red arrow down for falling,
 * followed by `text` (e.g. "+12 (+8 %)"). The direction is also spelled out for screen readers.
 */
export function TrendBadge({ direction, text }: { direction: TrendDirection; text: string }) {
  const label = t(`trend.direction.${direction}`);
  return (
    <span className={`trend trend--${direction}`} title={label}>
      <TrendIcon direction={direction} />
      <span className="visually-hidden">{label}: </span>
      {text}
    </span>
  );
}
