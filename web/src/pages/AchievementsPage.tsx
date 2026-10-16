import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { AchievementGroup, AchievementOverviewItem } from '../api/types';
import { Pagination } from '../components/Pagination';
import { useApi } from '../hooks/useApi';
import { achievementText, formatDateTime, formatNumber, t, type MessageKey } from '../i18n';
import { thresholdList, tierClass, tierName } from '../util/achievements';
import { PageHeader } from './pages';

const PAGE_SIZE = 25;

const GROUPS: AchievementGroup[] = [
  'playtime',
  'loyalty',
  'streak',
  'session',
  'time',
  'social',
  'server',
  'secret',
];

function percent(count: number, persons: number): string {
  if (persons === 0) return '0';
  const value = (count / persons) * 100;
  return formatNumber(Math.round(value * 10) / 10);
}

function Holders({ achievement }: { achievement: AchievementOverviewItem }) {
  const [page, setPage] = useState(1);
  const { data, error } = useApi(
    (signal) => api.achievementHolders(achievement.id, { page, pageSize: PAGE_SIZE }, signal),
    [achievement.id, page],
  );
  if (error && !data) return <p className="alert">{error}</p>;
  if (!data) return <p className="muted">{t('common.loading')}</p>;
  return (
    <>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('achievements.col.player')}</th>
              {achievement.tiers.length > 1 && <th scope="col">{t('achievements.col.tier')}</th>}
              <th scope="col">{t('achievements.col.earnedAt')}</th>
            </tr>
          </thead>
          <tbody>
            {data.holders.map((h) => (
              <tr key={h.userId}>
                <td>
                  <Link to={`/spieler/${String(h.userId)}`}>
                    {h.nickname ?? t('players.unknownNick')}
                  </Link>
                </td>
                {achievement.tiers.length > 1 && <td>{tierName(achievement, h.tier)}</td>}
                <td>{formatDateTime(h.earnedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
    </>
  );
}

function Item({ achievement, persons }: { achievement: AchievementOverviewItem; persons: number }) {
  const [open, setOpen] = useState(false);
  if (!achievement.revealed) {
    return (
      <li className="achievement achievement--open">
        <div className="achievement__title">
          <span>{t('achievements.secret')}</span>
        </div>
        <span className="muted small">{t('achievements.secretHint')}</span>
      </li>
    );
  }
  const anyone = achievement.holders.some((n) => n > 0);
  const highest = achievement.holders.reduce((best, n, i) => (n > 0 ? i + 1 : best), 0);
  const thresholds = thresholdList(achievement);
  return (
    <li className={`achievement ${anyone ? tierClass(achievement, highest) : 'achievement--open'}`}>
      <div className="achievement__title">
        <span>{achievementText('name', achievement.id)}</span>
      </div>
      <span className="muted small">{achievementText('desc', achievement.id)}</span>
      {thresholds && <span className="muted small">{thresholds}</span>}
      {achievement.liveOnly && <span className="muted small">{t('achievements.liveOnly')}</span>}
      <ul className="plain-list small">
        {achievement.holders.map((count, i) => (
          <li key={i}>
            {tierName(achievement, i + 1) && <strong>{tierName(achievement, i + 1)}: </strong>}
            {t('achievements.holders', { count: formatNumber(count) })} (
            {t('achievements.rarity', { value: percent(count, persons) })})
          </li>
        ))}
      </ul>
      {achievement.latest ? (
        <span className="muted small">
          {t('achievements.latest', {
            name: achievement.latest.nickname ?? t('players.unknownNick'),
            time: formatDateTime(achievement.latest.earnedAt),
          })}
        </span>
      ) : (
        <span className="muted small">{t('achievements.nobody')}</span>
      )}
      {anyone && (
        <button
          type="button"
          className="button button--small"
          aria-expanded={open}
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          {open ? t('achievements.hideHolders') : t('achievements.showHolders')}
        </button>
      )}
      {open && <Holders achievement={achievement} />}
    </li>
  );
}

/** All achievements with rarity and holders (T13.4). */
export function AchievementsPage() {
  const { data, error } = useApi((signal) => api.achievements(signal), []);
  return (
    <section className="stack">
      <PageHeader title={t('page.achievements.title')} intro={t('page.achievements.intro')} />
      {error && !data && <p className="alert">{error}</p>}
      {!data && !error && <p className="muted">{t('common.loading')}</p>}
      {data && (
        <>
          <p className="muted small">
            {data.state
              ? t('achievements.lastRun', { time: formatDateTime(data.state.lastRun) })
              : t('achievements.neverRun')}
          </p>
          {data.achievements.length === 0 && <p className="muted">{t('achievements.empty')}</p>}
          {GROUPS.map((group) => {
            const items = data.achievements.filter((a) => a.group === group);
            if (items.length === 0) return null;
            return (
              <section key={group} className="card achievement-group">
                <h2>{t(`achievement.group.${group}` as MessageKey)}</h2>
                <ul className="achievement-grid">
                  {items.map((a) => (
                    <Item key={a.id} achievement={a} persons={data.persons} />
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}
