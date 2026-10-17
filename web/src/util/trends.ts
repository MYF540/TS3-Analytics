import type { Trend } from '../api/types';
import { formatNumber, t } from '../i18n';

const percentFormat = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const smallPercentFormat = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

/** "+12 (+8 %)", "−3 h (−20 %)" or "+4" when there was nothing before. */
export function formatChange(trend: Trend, format: (value: number) => string): string {
  const sign = (value: number) => (value > 0 ? '+' : value < 0 ? '−' : '±');
  const amount = `${sign(trend.change)}${format(Math.abs(trend.change))}`;
  if (trend.changePct === null) return amount;
  // Below 10 % one decimal place, so 4.8 % (flat) is not shown as 5 % next to a blue bar.
  const pct = Math.abs(trend.changePct);
  const shown =
    pct < 10
      ? smallPercentFormat.format(Math.round(pct * 10) / 10)
      : percentFormat.format(Math.round(pct));
  const pctSign = shown === '0' ? '±' : sign(trend.changePct);
  return `${amount} (${pctSign}${t('unit.percent', { value: shown })})`;
}

/** Values that are averages: one decimal place. */
export function formatDecimal(value: number): string {
  return formatNumber(Math.round(value * 10) / 10);
}
