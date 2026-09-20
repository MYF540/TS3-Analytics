import { useState } from 'react';
import { api } from '../api/client';
import type { ChannelRange, ChannelUsage } from '../api/types';
import { RangePicker } from '../components/RangePicker';
import { useApi } from '../hooks/useApi';
import { formatDateTime, formatDuration, formatNumber, t } from '../i18n';
import { PageHeader } from './pages';

const RANGES = ['24h', '7d', '30d'] as const;
const UNUSED_DAYS = [7, 14, 30, 60, 90] as const;

function channelName(item: ChannelUsage['items'][number]): string {
  if (item.name !== null) return item.name;
  return t('channels.deleted', { id: item.channelId ?? 0 });
}

function Usage({ range }: { range: ChannelRange }) {
  const { data, error, loading } = useApi((signal) => api.channelUsage(range, signal), [range]);
  const max = data ? Math.max(...data.items.map((item) => item.seconds), 1) : 1;
  return (
    <section className="card" aria-busy={loading}>
      <h2>{t('channels.usage.title')}</h2>
      <p className="muted small">{t('channels.hint')}</p>
      {error && <p className="alert">{error}</p>}
      {data && data.items.length === 0 && <p className="muted">{t('channels.usage.empty')}</p>}
      {data && data.items.length > 0 && (
        <>
          <p className="muted small">
            {t('channels.total', { time: formatDuration(data.totalSeconds) })}
            {data.total > data.items.length && (
              <>
                {' · '}
                {t('channels.more', {
                  shown: formatNumber(data.items.length),
                  total: formatNumber(data.total),
                })}
              </>
            )}
          </p>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('channels.column.channel')}</th>
                  <th scope="col">{t('channels.column.time')}</th>
                  <th scope="col">{t('channels.column.share')}</th>
                  <th scope="col">{t('channels.column.players')}</th>
                  <th scope="col">{t('channels.column.visits')}</th>
                  <th scope="col">{t('channels.column.lastUsed')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={String(item.channelId)}>
                    <th scope="row">
                      {channelName(item)}
                      {!item.present && (
                        <>
                          {' '}
                          <span className="badge">{t('channels.gone')}</span>
                        </>
                      )}
                    </th>
                    <td>{formatDuration(item.seconds)}</td>
                    <td>
                      <div className="bar-list__track" aria-hidden="true">
                        <div
                          className="bar-list__bar"
                          style={{ width: `${String((item.seconds / max) * 100)}%` }}
                        />
                      </div>
                    </td>
                    <td>{formatNumber(item.users)}</td>
                    <td>{formatNumber(item.visits)}</td>
                    <td>{formatDateTime(item.lastUsed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Unused() {
  const [days, setDays] = useState<number>(30);
  const { data, error, loading } = useApi((signal) => api.unusedChannels(days, signal), [days]);
  return (
    <section className="card" aria-busy={loading}>
      <h2>{t('channels.unused.title')}</h2>
      <p className="muted small">{t('channels.unused.intro')}</p>
      <div className="toolbar toolbar--plain">
        <label className="field field--narrow">
          <span>{t('channels.unused.period')}</span>
          <select
            value={days}
            onChange={(event) => {
              setDays(Number(event.target.value));
            }}
          >
            {UNUSED_DAYS.map((option) => (
              <option key={option} value={option}>
                {t('channels.unused.days', { days: option })}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="alert">{error}</p>}
      {data && data.items.length === 0 && <p className="muted">{t('channels.unused.empty')}</p>}
      {data && data.items.length > 0 && (
        <>
          <p className="muted small">
            {t('channels.unused.count', { count: formatNumber(data.items.length) })}
          </p>
          <ul className="channel-list">
            {data.items.map((item) => (
              <li
                key={item.channelId}
                title={t('channels.unused.lastSeen', { time: formatDateTime(item.lastSeen) })}
              >
                {item.name}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function ChannelsPage() {
  const [range, setRange] = useState<ChannelRange>('30d');
  return (
    <section className="stack">
      <PageHeader title={t('page.channels.title')} intro={t('page.channels.intro')} />
      <div className="toolbar">
        <RangePicker value={range} options={RANGES} onChange={setRange} />
      </div>
      <Usage range={range} />
      <Unused />
    </section>
  );
}
