import { useMemo, useState } from 'react';
import type { Heatmap, TimeRange } from '../api/types';
import { EChart } from '../charts/EChart';
import { heatmapOption, WEEKDAY_KEYS } from '../charts/options';
import { CHART_PALETTES } from '../charts/palette';
import { useApi } from '../hooks/useApi';
import { t } from '../i18n';
import { useCurrentTheme } from '../theme/useCurrentTheme';
import { RangePicker } from './RangePicker';

interface Props<R extends TimeRange> {
  title: string;
  subtitle: string;
  /** Description of the chart for screen readers. */
  label: string;
  /** Name of the value in the tooltip, e.g. "Ø online". */
  legend: string;
  ranges: readonly R[];
  initialRange: R;
  load: (range: R, signal?: AbortSignal) => Promise<Heatmap>;
  /** How a cell value is written, in the tooltip and in the table. */
  format: (value: number) => string;
}

/**
 * Weekday × hour grid, used for the whole server (dashboard) and for one player. Both read the
 * same shape, only the meaning of a cell differs – hence the format and legend from outside.
 */
export function HeatmapCard<R extends TimeRange>({
  title,
  subtitle,
  label,
  legend,
  ranges,
  initialRange,
  load,
  format,
}: Props<R>) {
  const theme = useCurrentTheme();
  const [range, setRange] = useState<R>(initialRange);
  const { data, error, loading } = useApi((signal) => load(range, signal), [range]);
  const option = useMemo(
    () =>
      data ? heatmapOption(data.values, CHART_PALETTES[theme], { legend, format }) : undefined,
    [data, theme, legend, format],
  );

  return (
    <section className="card chart-card" aria-busy={loading}>
      <header className="chart-card__header">
        <div>
          <h2>{title}</h2>
          <p className="muted">{subtitle}</p>
        </div>
        <RangePicker value={range} options={ranges} onChange={setRange} />
      </header>
      {error && <p className="alert">{error}</p>}
      {option && data && (
        <>
          <EChart option={option} label={label} height={300} />
          <details className="table-view">
            <summary>{t('common.showTable')}</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('table.weekday')}</th>
                    {Array.from({ length: 24 }, (_, h) => (
                      <th scope="col" key={h}>
                        {String(h).padStart(2, '0')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.values.map((row, day) => (
                    <tr key={day}>
                      <th scope="row">{t(WEEKDAY_KEYS[day] ?? 'weekday.mon')}</th>
                      {row.map((value, hour) => (
                        <td key={hour}>{format(value)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
