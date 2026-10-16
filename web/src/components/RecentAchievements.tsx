import { Link } from 'react-router';
import { api } from '../api/client';
import { useApi } from '../hooks/useApi';
import { achievementText, formatDateTime, t } from '../i18n';
import { tierName } from '../util/achievements';

/** Dashboard tile: the latest achievement tiers reached (T13.4). */
export function RecentAchievements() {
  const { data, error } = useApi((signal) => api.achievements(signal), []);
  const byId = new Map(data?.achievements.map((a) => [a.id, a]));
  return (
    <section className="card">
      <header className="chart-card__header">
        <h2>{t('achievements.recent.title')}</h2>
        <Link to="/achievements">{t('achievements.recent.all')}</Link>
      </header>
      {error && !data && <p className="alert">{error}</p>}
      {!data && !error && <p className="muted">{t('common.loading')}</p>}
      {data && data.recent.length === 0 && (
        <p className="muted">{t('achievements.recent.empty')}</p>
      )}
      {data && data.recent.length > 0 && (
        <ul className="plain-list stack">
          {data.recent.map((r) => {
            const definition = byId.get(r.achievementId);
            const tier = definition ? tierName(definition, r.tier) : '';
            const name = achievementText('name', r.achievementId);
            return (
              <li key={`${String(r.userId)}-${r.achievementId}-${String(r.tier)}`}>
                <Link to={`/spieler/${String(r.userId)}`}>
                  {r.nickname ?? t('players.unknownNick')}
                </Link>{' '}
                <span>
                  {t('achievements.recent.item', {
                    achievement: tier ? `${name} (${tier})` : name,
                  })}
                </span>{' '}
                <span className="muted small">{formatDateTime(r.earnedAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
