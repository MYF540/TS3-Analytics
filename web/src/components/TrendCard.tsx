import { useState } from 'react';
import type { DayRange, Trend, TrendComparison } from '../api/types';
import { useApi } from '../hooks/useApi';
import { formatDay, t, type MessageKey } from '../i18n';
import { formatChange } from '../util/trends';
import { TrendBadge } from './TrendBadge';

const COMPARISONS: readonly TrendComparison[] = ['week', 'month', 'year'];

export interface TrendItem<K extends string> {
  key: K;
  label: MessageKey;
  /** How a value (and the size of a change) is written. */
  format: (value: number) => string;
}

interface Props<K extends string> {
  title: string;
  items: readonly TrendItem<K>[];
  load: (
    comparison: TrendComparison,
    signal?: AbortSignal,
  ) => Promise<{ current: DayRange; previous: DayRange; metrics: Record<K, Trend | null> }>;
}

function rangeText(range: DayRange): string {
  return `${formatDay(range.fromDay)} – ${formatDay(range.toDay)}`;
}

/**
 * Key figures of a recent period with their trend against an earlier one (week, month or the
 * same days last year). Used on the dashboard (whole server) and on the player page.
 */
export function TrendCard<K extends string>({ title, items, load }: Props<K>) {
  const [comparison, setComparison] = useState<TrendComparison>('month');
  const { data, error, loading } = useApi((signal) => load(comparison, signal), [comparison]);
  return (
    <section className="card trend-card" aria-busy={loading}>
      <header className="chart-card__header">
        <div>
          <h2>{title}</h2>
          <p className="muted">{t(`trend.intro.${comparison}`)}</p>
        </div>
        <div className="segmented" role="radiogroup" aria-label={t('trend.comparison')}>
          {COMPARISONS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={option === comparison}
              className={option === comparison ? 'segmented__item is-active' : 'segmented__item'}
              onClick={() => {
                setComparison(option);
              }}
            >
              {t(`trend.comparison.${option}`)}
            </button>
          ))}
        </div>
      </header>
      {error && <p className="alert">{error}</p>}
      {data && (
        <>
          <dl className="kpis">
            {items.map(({ key, label, format }) => {
              const trend = data.metrics[key];
              return (
                <div className="kpi trend-tile" key={key}>
                  <dt className="kpi__label">{t(label)}</dt>
                  <dd className="kpi__value kpi__value--small">
                    {trend ? format(trend.current) : '–'}
                  </dd>
                  <dd className="trend-tile__change">
                    {trend ? (
                      <TrendBadge direction={trend.direction} text={formatChange(trend, format)} />
                    ) : (
                      <span className="muted small">{t('trend.notComparable')}</span>
                    )}
                  </dd>
                  {trend && (
                    <dd className="muted small">
                      {t('trend.before', { value: format(trend.previous) })}
                    </dd>
                  )}
                </div>
              );
            })}
          </dl>
          <p className="muted small">
            {t('trend.periods', {
              current: rangeText(data.current),
              previous: rangeText(data.previous),
            })}
          </p>
        </>
      )}
    </section>
  );
}
