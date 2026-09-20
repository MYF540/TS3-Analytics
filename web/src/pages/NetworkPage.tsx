import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, describeError } from '../api/client';
import type { NetworkGraph, NetworkRange } from '../api/types';
import { EChart } from '../charts/EChart';
import { networkChartOption } from '../charts/options';
import { CHART_PALETTES } from '../charts/palette';
import { RangePicker } from '../components/RangePicker';
import { useApi } from '../hooks/useApi';
import { formatDateTime, formatDuration, formatNumber, t } from '../i18n';
import { useCurrentTheme } from '../theme/useCurrentTheme';
import { PageHeader } from './pages';

const RANGES = ['30d', '90d', '1y', 'all'] as const;
const LIMITS = [25, 50, 100, 200, 400, 800, 1500] as const;
const DEFAULT_LIMIT_INDEX = 3;

function isRange(value: string | null): value is NetworkRange {
  return (RANGES as readonly string[]).includes(value ?? '');
}

/** The strongest pairs as a table – a force graph alone is not readable for everyone. */
function PairTable({ data }: { data: NetworkGraph }) {
  const names = new Map(data.nodes.map((node) => [node.userId, node.nickname]));
  const name = (id: number) => names.get(id) ?? t('flags.unknownPlayer', { id });
  return (
    <details className="table-view">
      <summary>{t('network.showTable')}</summary>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('network.col.pair')}</th>
              <th scope="col">{t('network.col.together')}</th>
              <th scope="col">{t('network.col.encounters')}</th>
              <th scope="col">{t('network.col.share')}</th>
            </tr>
          </thead>
          <tbody>
            {data.edges.slice(0, 100).map((edge) => (
              <tr key={`${String(edge.a)}-${String(edge.b)}`}>
                <th scope="row">
                  <Link to={`/spieler/${String(edge.a)}`}>{name(edge.a)}</Link>
                  {' ↔ '}
                  <Link to={`/spieler/${String(edge.b)}`}>{name(edge.b)}</Link>
                </th>
                <td>{formatDuration(edge.seconds)}</td>
                <td>{formatNumber(edge.encounters)}</td>
                <td>
                  {t('network.shareValue', {
                    a: formatNumber(Math.round(edge.shareA * 100)),
                    b: formatNumber(Math.round(edge.shareB * 100)),
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function NetworkPage() {
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get('zeitraum');
  const range: NetworkRange = isRange(rangeParam) ? rangeParam : '30d';
  const [limitIndex, setLimitIndex] = useState(DEFAULT_LIMIT_INDEX);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string>();
  const theme = useCurrentTheme();

  const limit = LIMITS[limitIndex] ?? 200;
  const { data, error, loading } = useApi(
    (signal) => api.network({ range, limit }, signal),
    [range, limit, version],
  );
  const option = useMemo(
    () => (data ? networkChartOption(data, CHART_PALETTES[theme]) : undefined),
    [data, theme],
  );

  const setRange = (next: NetworkRange) => {
    const search = new URLSearchParams(params);
    if (next === '30d') search.delete('zeitraum');
    else search.set('zeitraum', next);
    setParams(search, { replace: true });
  };

  const recompute = () => {
    setBusy(true);
    setRunError(undefined);
    api.runNetworkJob().then(
      () => {
        setBusy(false);
        setVersion((v) => v + 1);
      },
      (e: unknown) => {
        setBusy(false);
        setRunError(describeError(e));
      },
    );
  };

  return (
    <section className="stack">
      <PageHeader title={t('page.network.title')} intro={t('page.network.intro')} />

      <div className="toolbar">
        <RangePicker value={range} options={RANGES} onChange={setRange} />
        <label className="field field--narrow">
          <span>{t('network.limit', { count: formatNumber(limit) })}</span>
          <input
            type="range"
            min={0}
            max={LIMITS.length - 1}
            step={1}
            value={limitIndex}
            onChange={(event) => {
              setLimitIndex(Number(event.target.value));
            }}
          />
        </label>
        <button type="button" className="button button--small" disabled={busy} onClick={recompute}>
          {t('network.recompute')}
        </button>
      </div>

      {error && <p className="alert">{error}</p>}
      {runError && (
        <p className="alert" role="alert">
          {runError}
        </p>
      )}

      {data && (
        <section className="card chart-card" aria-busy={loading || busy}>
          <header className="chart-card__header">
            <p className="muted small">
              {data.computedAt === null
                ? t('network.never')
                : t('network.computedAt', { time: formatDateTime(data.computedAt) })}
            </p>
            <p className="muted small">
              {t('network.counts', {
                nodes: formatNumber(data.nodes.length),
                edges: formatNumber(data.edges.length),
                total: formatNumber(data.edgesTotal),
              })}
            </p>
          </header>

          {data.edges.length === 0 ? (
            <p className="muted">{t('network.empty')}</p>
          ) : (
            <>
              {option && <EChart option={option} label={t('network.label')} height={560} />}
              <p className="muted small">{t('network.hint')}</p>
              <PairTable data={data} />
            </>
          )}
        </section>
      )}

      <p className="notice">{t('network.caveats')}</p>
    </section>
  );
}
