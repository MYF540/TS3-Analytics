import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { BotStatus } from '../api/types';
import { useApi } from '../hooks/useApi';
import {
  formatAgo,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatUptime,
  t,
  type MessageKey,
} from '../i18n';
import { de } from '../i18n/de';
import { PageHeader } from './pages';

const REFRESH_MS = 30_000;
const HEARTBEAT_STALE_S = 15 * 60;

function label(prefix: string, key: string): string {
  const full = `${prefix}${key}`;
  return full in de ? t(full as MessageKey) : key;
}

const STATE_CLASS: Record<string, string> = {
  connected: 'state--active',
  connecting: 'state--idle',
  waiting: 'state--bad',
};

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {items.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Kpis({ status, now }: { status: BotStatus; now: number }) {
  const heartbeat = status.watcher.lastHeartbeat;
  const state = status.ts3?.state ?? 'disabled';
  const items: [string, ReactNode][] = [
    [
      t('botstatus.kpi.connection'),
      <span key="s" className={`state ${STATE_CLASS[state] ?? ''}`}>
        {label('botstatus.state.', state)}
      </span>,
    ],
    [
      t('botstatus.kpi.heartbeat'),
      heartbeat === null ? t('botstatus.never') : formatAgo(now - heartbeat),
    ],
    [t('botstatus.kpi.uptime'), formatUptime(status.process.uptimeS)],
    [
      t('botstatus.kpi.online'),
      status.watcher.onlineClients === null ? '–' : formatNumber(status.watcher.onlineClients),
    ],
    [t('botstatus.kpi.openSessions'), formatNumber(status.watcher.openSessions)],
    [t('botstatus.kpi.dbSize'), formatBytes(status.database.sizeBytes)],
  ];
  return (
    <dl className="kpis">
      {items.map(([term, value]) => (
        <div className="kpi card" key={term}>
          <dt className="kpi__label">{term}</dt>
          <dd className="kpi__value kpi__value--small">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Connection({ ts3 }: { ts3: BotStatus['ts3'] }) {
  if (!ts3) return <p className="muted">{t('botstatus.ts3.none')}</p>;
  return (
    <Facts
      items={[
        [t('botstatus.ts3.state'), label('botstatus.state.', ts3.state)],
        [t('botstatus.ts3.since'), formatDateTime(ts3.since)],
        [
          t('botstatus.ts3.lastConnected'),
          ts3.lastConnectedAt === null ? t('botstatus.never') : formatDateTime(ts3.lastConnectedAt),
        ],
        [t('botstatus.ts3.failedAttempts'), formatNumber(ts3.failedAttempts)],
        [
          t('botstatus.ts3.lastError'),
          ts3.lastError ? (
            <>
              <span className="muted small">{formatDateTime(ts3.lastError.at)}</span>{' '}
              <code className="log-text">{ts3.lastError.message}</code>
            </>
          ) : (
            '–'
          ),
        ],
        [t('botstatus.ts3.queue'), formatNumber(ts3.queuedCommands)],
      ]}
    />
  );
}

function Jobs({ jobs, now }: { jobs: BotStatus['jobs']; now: number }) {
  if (jobs.length === 0) return <p className="muted">{t('botstatus.jobs.none')}</p>;
  return (
    <div className="table-scroll">
      <table className="data-table text-table">
        <thead>
          <tr>
            <th scope="col">{t('botstatus.jobs.name')}</th>
            <th scope="col">{t('botstatus.jobs.interval')}</th>
            <th scope="col">{t('botstatus.jobs.lastRun')}</th>
            <th scope="col">{t('botstatus.jobs.nextRun')}</th>
            <th scope="col">{t('botstatus.jobs.result')}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.name}>
              <td>{label('botstatus.job.', job.name)}</td>
              <td>{formatDuration(job.intervalS)}</td>
              <td>{job.lastRun === null ? t('botstatus.never') : formatDateTime(job.lastRun)}</td>
              <td>{job.nextRun <= now ? t('botstatus.jobs.due') : formatDateTime(job.nextRun)}</td>
              <td className="text-table__wrap">
                {job.lastError ? (
                  <span className="state state--bad">
                    {t('botstatus.jobs.failed', { message: job.lastError.message })}
                  </span>
                ) : job.lastRun === null ? (
                  '–'
                ) : (
                  <span className="state state--active">{t('botstatus.jobs.ok')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Problems({ problems }: { problems: BotStatus['problems'] }) {
  return (
    <>
      <p className="muted small">{t('botstatus.problems.hint')}</p>
      {problems.length === 0 ? (
        <p className="muted">{t('botstatus.problems.none')}</p>
      ) : (
        <ul className="problems">
          {problems.map((p, index) => (
            // Entries have no id; position plus time is stable within one response.
            <li key={`${String(index)}-${String(p.at)}`} className={`problem problem--${p.level}`}>
              <div className="problem__head">
                <span className="problem__level">{label('botstatus.level.', p.level)}</span>
                <span className="muted small">{formatDateTime(p.at)}</span>
                {p.count > 1 && (
                  <span className="badge">{t('botstatus.problems.count', { count: p.count })}</span>
                )}
              </div>
              <p className="problem__message">{p.message}</p>
              {p.detail && <code className="log-text">{p.detail}</code>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function StatusPage() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((n) => n + 1);
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const result = useApi(
    async (signal) => ({ status: await api.status(signal), at: Math.floor(Date.now() / 1000) }),
    [tick],
  );
  const { error, loading } = result;
  const data = result.data?.status;
  const loadedAt = result.data;
  // Server time, so ages do not depend on the clock of the browser.
  const now = data ? data.process.startedAt + data.process.uptimeS : 0;

  return (
    <section className="stack">
      <div className="page-header--row">
        <PageHeader title={t('page.status.title')} intro={t('page.status.intro')} />
        <div className="button-row">
          {loadedAt && (
            <span className="muted small">
              {t('botstatus.updated', { time: formatDateTime(loadedAt.at) })}
            </span>
          )}
          <button
            type="button"
            className="button button--small"
            disabled={loading}
            onClick={() => {
              setTick((n) => n + 1);
            }}
          >
            {t('botstatus.refresh')}
          </button>
        </div>
      </div>
      {error && <p className="alert">{error}</p>}
      {!data && !error && <p className="muted">{t('common.loading')}</p>}
      {data && (
        <>
          <Kpis status={data} now={now} />
          {data.watcher.lastHeartbeat !== null &&
            now - data.watcher.lastHeartbeat > HEARTBEAT_STALE_S && (
              <p className="notice" role="alert">
                {t('botstatus.heartbeatStale')}
              </p>
            )}
          <div className="grid-2">
            <section className="card">
              <h2>{t('botstatus.ts3.title')}</h2>
              <Connection ts3={data.ts3} />
            </section>
            <section className="card">
              <h2>{t('botstatus.db.title')}</h2>
              <Facts
                items={[
                  [t('botstatus.db.size'), formatBytes(data.database.sizeBytes)],
                  [
                    t('botstatus.db.wal'),
                    data.database.walBytes === null ? '–' : formatBytes(data.database.walBytes),
                  ],
                  [t('botstatus.db.free'), formatBytes(data.database.freeBytes)],
                  [t('botstatus.db.users'), formatNumber(data.database.users)],
                  [t('botstatus.db.sessions'), formatNumber(data.database.sessions)],
                  [t('botstatus.db.segments'), formatNumber(data.database.segments)],
                ]}
              />
            </section>
            <section className="card">
              <h2>{t('botstatus.process.title')}</h2>
              <Facts
                items={[
                  [t('botstatus.process.version'), data.process.version],
                  [t('botstatus.process.node'), data.process.nodeVersion],
                  [t('botstatus.process.started'), formatDateTime(data.process.startedAt)],
                  [
                    t('botstatus.process.memory'),
                    t('botstatus.process.memoryValue', {
                      rss: formatBytes(data.process.rssBytes),
                      heap: formatBytes(data.process.heapUsedBytes),
                    }),
                  ],
                ]}
              />
            </section>
          </div>
          <section className="card">
            <h2>{t('botstatus.jobs.title')}</h2>
            <Jobs jobs={data.jobs} now={now} />
          </section>
          <section className="card">
            <h2>{t('botstatus.problems.title')}</h2>
            <Problems problems={data.problems} />
          </section>
        </>
      )}
    </section>
  );
}
