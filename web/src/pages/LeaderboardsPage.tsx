import { Link, useSearchParams } from 'react-router';
import { api, buildUrl } from '../api/client';
import type { LeaderboardMetric, LeaderboardPeriod } from '../api/types';
import { Pagination } from '../components/Pagination';
import { useApi } from '../hooks/useApi';
import {
  formatDateTime,
  formatDay,
  formatDuration,
  formatNumber,
  t,
  type MessageKey,
} from '../i18n';
import { PageHeader } from './pages';

const PAGE_SIZE = 25;

interface Tab {
  id: string;
  label: MessageKey;
  description: MessageKey;
  period: LeaderboardPeriod;
  /** Fixed metric, or undefined when the user can switch between online and active time. */
  metric?: LeaderboardMetric;
}

const TABS: Tab[] = [
  {
    id: 'gesamt',
    label: 'lb.tab.total',
    description: 'lb.desc.total',
    period: 'all',
    metric: 'online',
  },
  {
    id: 'aktiv',
    label: 'lb.tab.active',
    description: 'lb.desc.active',
    period: 'all',
    metric: 'active',
  },
  { id: 'woche', label: 'lb.tab.week', description: 'lb.desc.week', period: 'week' },
  { id: 'monat', label: 'lb.tab.month', description: 'lb.desc.month', period: 'month' },
  { id: 'jahr', label: 'lb.tab.year', description: 'lb.desc.year', period: 'year' },
  {
    id: 'laengste-session',
    label: 'lb.tab.longest',
    description: 'lb.desc.longest',
    period: 'all',
    metric: 'longestSession',
  },
  { id: 'zeitraum', label: 'lb.tab.custom', description: 'lb.desc.custom', period: 'custom' },
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function useLeaderboardParams() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((candidate) => candidate.id === params.get('art')) ?? TABS[0];
  const metric: LeaderboardMetric =
    tab?.metric ?? (params.get('wertung') === 'aktiv' ? 'active' : 'online');
  const page = Math.max(1, Number(params.get('page')) || 1);
  const from = params.get('von') ?? '';
  const to = params.get('bis') ?? '';
  const update = (changes: Record<string, string | undefined>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === '') next.delete(key);
      else next.set(key, value);
    }
    if (resetPage) next.delete('page');
    setParams(next, { replace: true });
  };
  return { tab: tab as Tab, metric, page, from, to, update } as const;
}

/**
 * Imported log time is online time only (T8.7): there is no activity data before live tracking
 * started, so an "active" leaderboard covering that period would be misleading.
 */
function ImportNotice({ metric }: { metric: LeaderboardMetric }) {
  const { data } = useApi((signal) => api.dataSources(signal), []);
  if (!data || data.importedFrom === null) return null;
  const key = metric === 'active' ? 'lb.importedActive' : 'lb.imported';
  return (
    <p className="muted small">
      {t(key, {
        from: formatDateTime(data.importedFrom),
        to: formatDateTime(data.importedTo ?? data.importedFrom),
        live: data.liveSince === null ? '–' : formatDateTime(data.liveSince),
      })}
    </p>
  );
}

export function LeaderboardsPage() {
  const { tab, metric, page, from, to, update } = useLeaderboardParams();
  const customReady = DATE.test(from) && DATE.test(to);
  const enabled = tab.period !== 'custom' || customReady;

  const { data, error, loading } = useApi(
    (signal) =>
      enabled
        ? api.leaderboard(
            {
              period: tab.period,
              metric,
              page,
              pageSize: PAGE_SIZE,
              from: tab.period === 'custom' ? from : undefined,
              to: tab.period === 'custom' ? to : undefined,
            },
            signal,
          )
        : Promise.resolve(undefined),
    [tab.id, metric, page, from, to, enabled],
  );
  const top = data?.items[0]?.value ?? 0;

  return (
    <section className="stack">
      <PageHeader title={t('page.leaderboards.title')} intro={t('page.leaderboards.intro')} />

      <div className="tabs" role="tablist" aria-label={t('lb.tabs')}>
        {TABS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            id={`tab-${candidate.id}`}
            aria-selected={candidate.id === tab.id}
            aria-controls="leaderboard-panel"
            className={candidate.id === tab.id ? 'tab is-active' : 'tab'}
            onClick={() => {
              update({ art: candidate.id });
            }}
          >
            {t(candidate.label)}
          </button>
        ))}
      </div>

      <ImportNotice metric={metric} />

      <div
        className="card stack"
        role="tabpanel"
        id="leaderboard-panel"
        aria-labelledby={`tab-${tab.id}`}
        aria-busy={loading}
      >
        <div className="toolbar toolbar--plain">
          <p className="muted">{t(tab.description)}</p>
          {tab.period === 'custom' && (
            <>
              <label className="field field--narrow">
                <span>{t('lb.from')}</span>
                <input
                  type="date"
                  value={from}
                  onChange={(event) => {
                    update({ von: event.target.value });
                  }}
                />
              </label>
              <label className="field field--narrow">
                <span>{t('lb.to')}</span>
                <input
                  type="date"
                  value={to}
                  onChange={(event) => {
                    update({ bis: event.target.value });
                  }}
                />
              </label>
            </>
          )}
          {!tab.metric && (
            <div className="segmented" role="radiogroup" aria-label={t('lb.metric')}>
              {(['online', 'active'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={metric === option}
                  className={metric === option ? 'segmented__item is-active' : 'segmented__item'}
                  onClick={() => {
                    update({ wertung: option === 'active' ? 'aktiv' : undefined });
                  }}
                >
                  {t(`lb.metric.${option}`)}
                </button>
              ))}
            </div>
          )}
        </div>

        {enabled && (
          <p>
            <a
              className="button"
              download
              href={buildUrl('/leaderboards/export.csv', {
                period: tab.period,
                metric,
                from: tab.period === 'custom' ? from : undefined,
                to: tab.period === 'custom' ? to : undefined,
              })}
            >
              {t('common.exportCsv')}
            </a>
          </p>
        )}
        {metric === 'active' && <p className="muted small">{t('lb.activeHint')}</p>}
        {!enabled && <p className="muted">{t('lb.chooseRange')}</p>}
        {error && <p className="alert">{error}</p>}
        {data?.fromDay != null && data.toDay != null && (
          <p className="muted small">
            {t('lb.range', { from: formatDay(data.fromDay), to: formatDay(data.toDay) })}
          </p>
        )}

        {data && data.items.length === 0 && <p className="muted">{t('lb.empty')}</p>}
        {data && data.items.length > 0 && (
          <div className="table-scroll">
            <table className="data-table leaderboard">
              <thead>
                <tr>
                  <th scope="col">{t('lb.col.rank')}</th>
                  <th scope="col">{t('lb.col.player')}</th>
                  <th scope="col">{t('lb.col.value')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((entry) => (
                  <tr key={entry.userId} className={entry.rank <= 3 ? 'is-podium' : undefined}>
                    <td className="leaderboard__rank">{formatNumber(entry.rank)}</td>
                    <td>
                      <Link to={`/spieler/${String(entry.userId)}`}>
                        {entry.nickname ?? t('players.unknownNick')}
                      </Link>
                      {entry.accounts > 1 && (
                        <span
                          className="badge"
                          title={t('lb.accounts', { count: entry.accounts })}
                          aria-label={t('lb.accounts', { count: entry.accounts })}
                        >
                          +{entry.accounts - 1}
                        </span>
                      )}
                    </td>
                    <td className="leaderboard__value">
                      <span>{formatDuration(entry.value)}</span>
                      <span className="leaderboard__track" aria-hidden="true">
                        <span
                          className="leaderboard__bar"
                          style={{
                            width: `${String(top > 0 ? (entry.value / top) * 100 : 0)}%`,
                          }}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data.total}
            onChange={(next) => {
              update({ page: String(next) }, false);
            }}
          />
        )}
      </div>
    </section>
  );
}
