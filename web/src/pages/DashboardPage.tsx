import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { Overview, TimeRange } from '../api/types';
import { EChart } from '../charts/EChart';
import { formatBucket, formatResolution, onlineChartOption } from '../charts/options';
import { CHART_PALETTES } from '../charts/palette';
import { HeatmapCard } from '../components/HeatmapCard';
import { OnlineNow } from '../components/OnlineNow';
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
  return (
    <HeatmapCard
      title={t('chart.heatmap.title')}
      subtitle={t('chart.heatmap.subtitle')}
      label={t('chart.heatmap.label')}
      legend={t('chart.heatmap.legend')}
      ranges={HEATMAP_RANGES}
      initialRange="30d"
      load={(range, signal) => api.heatmap(range, signal)}
      format={(value) => formatNumber(Math.round(value * 10) / 10)}
    />
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
      <OnlineNow />
      <OnlineHistory range={range} />
      <ActivityHeatmap />
    </section>
  );
}
