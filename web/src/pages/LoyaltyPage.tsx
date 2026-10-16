import { useMemo, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, buildUrl, describeError } from '../api/client';
import type { LoyaltyOverview } from '../api/types';
import { hasRole, useCurrentUser } from '../auth/context';
import { EChart } from '../charts/EChart';
import { formatMonth, LOYALTY_SERIES, loyaltyChartOption } from '../charts/options';
import { CHART_PALETTES } from '../charts/palette';
import { Pagination } from '../components/Pagination';
import { useApi } from '../hooks/useApi';
import { formatDateTime, formatDay, formatDuration, formatNumber, t } from '../i18n';
import { useCurrentTheme } from '../theme/useCurrentTheme';
import { PageHeader } from './pages';

const PAGE_SIZE = 50;
const DEFAULT_HOURS = 20;
const DEFAULT_WEEKS = 4;

const percent = new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 0 });

function Cohorts({ data }: { data: LoyaltyOverview }) {
  return (
    <section className="card stack">
      <h2>{t('loyalty.cohorts.title')}</h2>
      <p className="muted">{t('loyalty.cohorts.intro')}</p>
      {data.cohorts.length === 0 ? (
        <p className="muted">{t('loyalty.cohorts.empty')}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table cohort-table">
            <thead>
              <tr>
                <th scope="col">{t('loyalty.cohorts.month')}</th>
                <th scope="col">{t('loyalty.cohorts.size')}</th>
                {data.returnAfterDays.map((days) => (
                  <th scope="col" key={days}>
                    {t('loyalty.cohorts.after', { days })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Newest cohorts first: they are what an operator looks at. */}
              {[...data.cohorts].reverse().map((cohort) => (
                <tr key={cohort.month}>
                  <th scope="row">{formatMonth(cohort.month)}</th>
                  <td>{formatNumber(cohort.size)}</td>
                  {data.returnAfterDays.map((days, i) => {
                    const eligible = cohort.eligible[i] ?? 0;
                    const returned = cohort.returned[i] ?? 0;
                    if (eligible === 0) {
                      return (
                        <td key={days} className="muted">
                          {t('loyalty.cohorts.tooEarly')}
                        </td>
                      );
                    }
                    const share = returned / eligible;
                    return (
                      <td
                        key={days}
                        className="cohort-cell"
                        style={{ '--share': String(share) } as CSSProperties}
                        title={t('loyalty.cohorts.cell', {
                          returned: formatNumber(returned),
                          eligible: formatNumber(eligible),
                        })}
                      >
                        {percent.format(share)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Months({ data }: { data: LoyaltyOverview }) {
  const theme = useCurrentTheme();
  const option = useMemo(
    () => loyaltyChartOption(data.months, CHART_PALETTES[theme]),
    [data.months, theme],
  );
  return (
    <section className="card chart-card">
      <header className="chart-card__header">
        <h2>{t('loyalty.months.title')}</h2>
      </header>
      <p className="muted">{t('loyalty.months.intro')}</p>
      {data.months.length === 0 ? (
        <p className="muted">{t('chart.empty')}</p>
      ) : (
        <>
          <EChart option={option} label={t('loyalty.months.label')} />
          <details className="table-view">
            <summary>{t('common.showTable')}</summary>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('loyalty.months.month')}</th>
                  <th scope="col">{t('loyalty.months.active')}</th>
                  {LOYALTY_SERIES.map(([key, label]) => (
                    <th scope="col" key={key}>
                      {t(label)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.months.map((m) => (
                  <tr key={m.month}>
                    <td>{formatMonth(m.month)}</td>
                    <td>{formatNumber(m.active)}</td>
                    {LOYALTY_SERIES.map(([key]) => (
                      <td key={key}>{formatNumber(m[key])}</td>
                    ))}
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

/** Filter and page live in the URL, like on the player list. */
function useMissingParams() {
  const [params, setParams] = useSearchParams();
  const number = (key: string, fallback: number, min: number) => {
    const value = Number(params.get(key));
    return params.has(key) && Number.isFinite(value) && value >= min ? value : fallback;
  };
  const minHours = number('stunden', DEFAULT_HOURS, 0);
  const weeks = Math.round(number('wochen', DEFAULT_WEEKS, 1));
  const page = Math.max(1, Math.round(number('seite', 1, 1)));
  const update = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };
  return { minHours, weeks, page, update } as const;
}

function MissingRegulars({ version }: { version: number }) {
  const { minHours, weeks, page, update } = useMissingParams();
  const { data, error, loading } = useApi(
    (signal) => api.missingRegulars({ minHours, weeks, page, pageSize: PAGE_SIZE }, signal),
    [minHours, weeks, page, version],
  );
  return (
    <section className="card stack" aria-busy={loading}>
      <h2>{t('loyalty.missing.title')}</h2>
      <p className="muted">
        {t('loyalty.missing.intro', { hours: formatNumber(minHours), weeks: formatNumber(weeks) })}
      </p>
      <div className="toolbar">
        <label className="field">
          <span>{t('loyalty.missing.minHours')}</span>
          <input
            type="number"
            min={0}
            max={2000}
            step={1}
            value={minHours}
            onChange={(event) => {
              update({ stunden: event.target.value, seite: undefined });
            }}
          />
        </label>
        <label className="field">
          <span>{t('loyalty.missing.weeks')}</span>
          <input
            type="number"
            min={1}
            max={520}
            step={1}
            value={weeks}
            onChange={(event) => {
              update({ wochen: event.target.value, seite: undefined });
            }}
          />
        </label>
        {data && (
          <span className="muted">
            {t('loyalty.missing.count', { count: formatNumber(data.total) })}
          </span>
        )}
        <a className="button" download href={buildUrl('/loyalty/missing.csv', { minHours, weeks })}>
          {t('common.exportCsv')}
        </a>
      </div>
      {error && <p className="alert">{error}</p>}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('loyalty.missing.nickname')}</th>
              <th scope="col">{t('loyalty.missing.lastDay')}</th>
              <th scope="col">{t('loyalty.missing.recent')}</th>
              <th scope="col">{t('loyalty.missing.total')}</th>
              <th scope="col">{t('loyalty.missing.rank')}</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((p) => (
              <tr key={p.userId}>
                <td>
                  <Link to={`/spieler/${String(p.userId)}`}>
                    {p.nickname ?? t('players.unknownNick')}
                  </Link>
                </td>
                <td>{formatDay(p.lastDay)}</td>
                <td>{formatDuration(p.recentS)}</td>
                <td>{formatDuration(p.totalS)}</td>
                <td>{p.rank ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.items.length === 0 && <p className="muted">{t('loyalty.missing.empty')}</p>}
      {data && (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={data.total}
          onChange={(next) => {
            update({ seite: String(next) });
          }}
        />
      )}
    </section>
  );
}

/** Retention and churn (T13.1): cohorts, monthly balance and missing regulars. */
export function LoyaltyPage() {
  const user = useCurrentUser();
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [runError, setRunError] = useState<string>();
  const { data, error } = useApi((signal) => api.loyalty(signal), [version]);

  const runNow = () => {
    setBusy(true);
    setRunError(undefined);
    setMessage(undefined);
    api.runLoyaltyJob().then(
      () => {
        setBusy(false);
        setMessage(t('loyalty.done'));
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
      <PageHeader title={t('page.loyalty.title')} intro={t('page.loyalty.intro')} />
      <div className="toolbar">
        {data && (
          <span className="muted">
            {data.computedAt === null
              ? t('loyalty.never')
              : t('loyalty.computedAt', { time: formatDateTime(data.computedAt) })}
          </span>
        )}
        {hasRole(user, 'admin') && (
          <button type="button" className="button" disabled={busy} onClick={runNow}>
            {t('loyalty.run')}
          </button>
        )}
        {message && (
          <span className="state state--active" role="status">
            {message}
          </span>
        )}
      </div>
      {(error ?? runError) && <p className="alert">{error ?? runError}</p>}
      {data && (
        <>
          <Cohorts data={data} />
          <Months data={data} />
        </>
      )}
      <MissingRegulars version={version} />
    </section>
  );
}
