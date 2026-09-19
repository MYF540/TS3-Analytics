import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { Overview, TimeRange } from '../api/types';
import { EChart } from '../charts/EChart';
import {
  formatBucket,
  formatResolution,
  heatmapOption,
  onlineChartOption,
  WEEKDAY_KEYS,
} from '../charts/options';
import { CHART_PALETTES } from '../charts/palette';
import { RangePicker } from '../components/RangePicker';
import { useApi } from '../hooks/useApi';
import { formatNumber, t, type MessageKey } from '../i18n';
import { useCurrentTheme } from '../theme/useCurrentTheme';

const SERIES_RANGES = ['24h', '7d', '30d'] as const;
const HEATMAP_RANGES = ['30d', '1y', 'all'] as const;

const KPIS: { key: keyof Omit<Overview, 'range'>; label: MessageKey }[] = [
  { key: 'onlineNow', label: 'kpi.onlineNow' },
  { key: 'peakToday', label: 'kpi.peakToday' },
  { key: 'peakInRange', label: 'kpi.peakInRange' },
  { key: 'peakAllTime', label: 'kpi.peakAllTime' },
  { key: 'usersTotal', label: 'kpi.usersTotal' },
  { key: 'usersNew', label: 'kpi.usersNew' },
];

function Kpis({ range }: { range: TimeRange }) {
  const { data, error } = useApi((signal) => api.overview(range, signal), [range]);
  if (error) return <p className="alert">{error}</p>;
  return (
    <dl className="kpis">
      {KPIS.map(({ key, label }) => (
        <div className="kpi card" key={key}>
          <dt className="kpi__label">{t(label)}</dt>
          <dd className="kpi__value">{data ? formatNumber(data[key]) : '–'}</dd>
        </div>
      ))}
    </dl>
  );
}

function OnlineHistory({ range }: { range: TimeRange }) {
  const theme = useCurrentTheme();
  const { data, error, loading } = useApi((signal) => api.online({ range }, signal), [range]);
  const option = useMemo(
    () =>
      data ? onlineChartOption(data.points, data.resolution, CHART_PALETTES[theme]) : undefined,
    [data, theme],
  );
  return (
    <section className="card chart-card" aria-busy={loading}>
      <header className="chart-card__header">
        <h2>{t('chart.online.title')}</h2>
        {data && (
          <span className="muted">
            {t('chart.resolution', { value: formatResolution(data.resolution) })}
          </span>
        )}
      </header>
      {error && <p className="alert">{error}</p>}
      {data && data.points.length === 0 && <p className="muted">{t('chart.empty')}</p>}
      {option && data && data.points.length > 0 && (
        <>
          <EChart option={option} label={t('chart.online.label')} />
          <details className="table-view">
            <summary>{t('common.showTable')}</summary>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('table.time')}</th>
                  <th scope="col">{t('chart.online.avg')}</th>
                  <th scope="col">{t('chart.online.max')}</th>
                </tr>
              </thead>
              <tbody>
                {data.points.map((p) => (
                  <tr key={p.t}>
                    <td>{formatBucket(p.t, data.resolution, true)}</td>
                    <td>{formatNumber(Math.round(p.avgOnline * 10) / 10)}</td>
                    <td>{formatNumber(p.maxOnline)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}

function ActivityHeatmap() {
  const theme = useCurrentTheme();
  const [range, setRange] = useState<(typeof HEATMAP_RANGES)[number]>('30d');
  const { data, error, loading } = useApi((signal) => api.heatmap(range, signal), [range]);
  const option = useMemo(
    () => (data ? heatmapOption(data.values, CHART_PALETTES[theme]) : undefined),
    [data, theme],
  );
  return (
    <section className="card chart-card" aria-busy={loading}>
      <header className="chart-card__header">
        <div>
          <h2>{t('chart.heatmap.title')}</h2>
          <p className="muted">{t('chart.heatmap.subtitle')}</p>
        </div>
        <RangePicker value={range} options={HEATMAP_RANGES} onChange={setRange} />
      </header>
      {error && <p className="alert">{error}</p>}
      {option && data && (
        <>
          <EChart option={option} label={t('chart.heatmap.label')} height={300} />
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
                        <td key={hour}>{formatNumber(Math.round(value * 10) / 10)}</td>
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

export function DashboardPage() {
  const [range, setRange] = useState<(typeof SERIES_RANGES)[number]>('24h');
  return (
    <section className="stack">
      <header className="page-header page-header--row">
        <div>
          <h1>{t('page.dashboard.title')}</h1>
          <p className="muted">{t('page.dashboard.intro')}</p>
        </div>
        <RangePicker value={range} options={SERIES_RANGES} onChange={setRange} />
      </header>
      <Kpis range={range} />
      <OnlineHistory range={range} />
      <ActivityHeatmap />
    </section>
  );
}
