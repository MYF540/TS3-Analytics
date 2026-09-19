import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api/client';
import type { UserDetail } from '../api/types';
import { EChart } from '../charts/EChart';
import { playtimeChartOption, STATE_KEYS } from '../charts/options';
import { CHART_PALETTES } from '../charts/palette';
import { hasRole, useCurrentUser } from '../auth/context';
import { ModerationCard } from '../components/ModerationCard';
import { PlayerAccounts } from '../components/PlayerAccounts';
import { PlayerFlagsNotice } from '../components/PlayerFlagsNotice';
import { PlayerNotes } from '../components/PlayerNotes';
import { PlayerRankCard } from '../components/PlayerRankCard';
import { PlayerTags } from '../components/PlayerTags';
import { RangePicker } from '../components/RangePicker';
import { useApi } from '../hooks/useApi';
import { formatDateTime, formatDay, formatDuration, formatNumber, t } from '../i18n';
import { useCurrentTheme } from '../theme/useCurrentTheme';
import { addDays, berlinToday } from '../util/days';
import { NotFoundPage } from './pages';

const DAYS = { '30d': 30, '1y': 365 } as const;
type DaysRange = keyof typeof DAYS;

function Kpis({ detail }: { detail: UserDetail }) {
  const items = [
    [t('player.kpi.online'), formatDuration(detail.totals.onlineS)],
    [t('player.kpi.active'), formatDuration(detail.totals.activeS)],
    [t('player.kpi.sessions'), formatNumber(detail.totals.sessions)],
    [t('player.kpi.longest'), formatDuration(detail.totals.longestSessionS)],
    [t('player.kpi.firstSeen'), formatDateTime(detail.user.firstSeen)],
    [
      t('player.kpi.lastSeen'),
      detail.online ? t('players.onlineNow') : formatDateTime(detail.user.lastSeen),
    ],
  ] as const;
  return (
    <dl className="kpis">
      {items.map(([label, value]) => (
        <div className="kpi card" key={label}>
          <dt className="kpi__label">{label}</dt>
          <dd className="kpi__value kpi__value--small">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PlaytimeChart({
  detail,
  fromDay,
  toDay,
}: {
  detail: UserDetail;
  fromDay: number;
  toDay: number;
}) {
  const theme = useCurrentTheme();
  const option = useMemo(
    () => playtimeChartOption(detail.daily, fromDay, toDay, CHART_PALETTES[theme]),
    [detail, fromDay, toDay, theme],
  );
  return (
    <>
      <EChart option={option} label={t('player.chart.label')} height={280} />
      <details className="table-view">
        <summary>{t('common.showTable')}</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('table.time')}</th>
                {STATE_KEYS.map(([key, label]) => (
                  <th scope="col" key={key}>
                    {t(label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {detail.daily.map((d) => (
                <tr key={d.day}>
                  <td>{formatDay(d.day)}</td>
                  {STATE_KEYS.map(([key]) => (
                    <td key={key}>{formatDuration(d[key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function Sessions({ sessions }: { sessions: UserDetail['recentSessions'] }) {
  if (sessions.length === 0) return <p className="muted">{t('player.none')}</p>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t('player.sessions.start')}</th>
            <th scope="col">{t('player.sessions.end')}</th>
            <th scope="col">{t('player.sessions.duration')}</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td>
                {formatDateTime(s.joinAt)}
                {s.source === 'import' && (
                  <span className="badge">{t('player.sessions.imported')}</span>
                )}
              </td>
              <td>
                {s.leaveAt === null ? t('player.sessions.running') : formatDateTime(s.leaveAt)}
              </td>
              <td>{s.duration === null ? '–' : formatDuration(s.duration)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Channels({ channels }: { channels: UserDetail['topChannels'] }) {
  if (channels.length === 0) return <p className="muted">{t('player.none')}</p>;
  const max = Math.max(...channels.map((c) => c.seconds), 1);
  return (
    <ul className="bar-list">
      {channels.map((c) => (
        <li key={String(c.channelId)}>
          <div className="bar-list__row">
            <span>{c.name ?? t('player.channels.deleted')}</span>
            <span className="muted">{formatDuration(c.seconds)}</span>
          </div>
          <div className="bar-list__track" aria-hidden="true">
            <div
              className="bar-list__bar"
              style={{ width: `${String((c.seconds / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Nicknames({ nicknames }: { nicknames: UserDetail['nicknames'] }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t('player.nicknames.nick')}</th>
            <th scope="col">{t('players.col.firstSeen')}</th>
            <th scope="col">{t('players.col.lastSeen')}</th>
          </tr>
        </thead>
        <tbody>
          {nicknames.map((n) => (
            <tr key={n.nick}>
              <td>{n.nick}</td>
              <td>{formatDateTime(n.firstSeen)}</td>
              <td>{formatDateTime(n.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Countries({ countries }: { countries: UserDetail['countries'] }) {
  return (
    <>
      <p className="muted small">{t('player.countries.hint')}</p>
      {countries.length === 0 ? (
        <p className="muted">{t('player.none')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('players.col.country')}</th>
              <th scope="col">{t('player.countries.connections')}</th>
              <th scope="col">{t('players.col.lastSeen')}</th>
            </tr>
          </thead>
          <tbody>
            {countries.map((c) => (
              <tr key={c.country}>
                <td>{c.country}</td>
                <td>{formatNumber(c.connections)}</td>
                <td>{formatDateTime(c.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function PlayerPage() {
  const params = useParams();
  const id = Number(params.id);
  const user = useCurrentUser();
  const [range, setRange] = useState<DaysRange>('30d');
  const days = DAYS[range];
  // Bumped after linking accounts, because totals and charts then change.
  const [version, setVersion] = useState(0);
  const { data, error } = useApi((signal) => api.user(id, days, signal), [id, days, version]);
  const toDay = berlinToday();
  const fromDay = addDays(toDay, -(days - 1));

  if (!Number.isInteger(id) || id <= 0) return <NotFoundPage />;
  if (error && !data) {
    return (
      <section className="stack">
        <Link to="/spieler">← {t('player.back')}</Link>
        <p className="alert">{error}</p>
      </section>
    );
  }
  if (!data) return <p className="muted">{t('common.loading')}</p>;

  return (
    <section className="stack">
      <Link to="/spieler">← {t('player.back')}</Link>
      <header className="page-header">
        <h1>{data.user.nickname ?? t('players.unknownNick')}</h1>
        <p className="muted">
          {data.online ? (
            <span className="badge badge--online">
              {t('player.onlineSince', { time: formatDateTime(data.online.since) })}
            </span>
          ) : (
            <span className="badge">{t('player.offline')}</span>
          )}{' '}
          {t('player.uid')}: <code className="uid">{data.user.uid}</code>
        </p>
        <PlayerTags key={id} userId={id} tags={data.tags} />
      </header>
      <PlayerFlagsNotice userId={id} />
      <Kpis detail={data} />
      <section className="card chart-card">
        <header className="chart-card__header">
          <h2>{t('player.chart.title')}</h2>
          <RangePicker value={range} options={['30d', '1y'] as const} onChange={setRange} />
        </header>
        <PlaytimeChart detail={data} fromDay={fromDay} toDay={toDay} />
      </section>
      <div className="grid-2">
        <section className="card">
          <h2>{t('player.sessions.title')}</h2>
          <Sessions sessions={data.recentSessions} />
        </section>
        <section className="card">
          <h2>{t('player.channels.title')}</h2>
          <Channels channels={data.topChannels} />
        </section>
        <section className="card">
          <h2>{t('player.nicknames.title')}</h2>
          <Nicknames nicknames={data.nicknames} />
        </section>
        <section className="card">
          <h2>{t('player.countries.title')}</h2>
          <Countries countries={data.countries} />
        </section>
      </div>
      {hasRole(user, 'admin') && (
        <section className="card">
          <h2>{t('mod.title')}</h2>
          <ModerationCard
            key={id}
            userId={id}
            name={data.user.nickname ?? data.user.uid}
            online={data.online !== null}
          />
        </section>
      )}
      <section className="card">
        <h2>{t('prank.title')}</h2>
        <PlayerRankCard key={`${String(id)}-${String(version)}`} userId={id} />
      </section>
      <section className="card">
        <h2>{t('accounts.title')}</h2>
        <PlayerAccounts
          key={id}
          userId={id}
          person={data.person}
          onChanged={() => {
            setVersion((v) => v + 1);
          }}
        />
      </section>
      <section className="card">
        <h2>{t('notes.title')}</h2>
        <PlayerNotes key={id} userId={id} />
      </section>
    </section>
  );
}
