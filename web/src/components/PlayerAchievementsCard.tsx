import { api } from '../api/client';
import type { PlayerAchievement } from '../api/types';
import { useApi } from '../hooks/useApi';
import { achievementText, formatDateTime, t } from '../i18n';
import { formatAchievementValue, thresholdList, tierClass, tierName } from '../util/achievements';

function Earned({ achievement }: { achievement: PlayerAchievement }) {
  const best = achievement.earned.reduce((a, b) => (b.tier > a.tier ? b : a));
  const tier = tierName(achievement, best.tier);
  const next = achievement.nextThreshold;
  return (
    <li className={`achievement ${tierClass(achievement, best.tier)}`}>
      <div className="achievement__title">
        <span>{achievementText('name', achievement.id)}</span>
        {tier && <span className="achievement__tier">{tier}</span>}
      </div>
      <span className="muted small">{achievementText('desc', achievement.id)}</span>
      <span className="small">
        {t('pach.earnedAt', { time: formatDateTime(best.earnedAt) })}
        {best.backfilled && (
          <span className="badge" title={t('pach.backfilledHint')}>
            {t('pach.backfilled')}
          </span>
        )}
      </span>
      {next !== null && <Progress achievement={achievement} next={next} />}
    </li>
  );
}

function Progress({ achievement, next }: { achievement: PlayerAchievement; next: number }) {
  const share = Math.min(1, Math.max(0, achievement.value / next));
  return (
    <>
      <span className="muted small">
        {t('pach.progress', {
          value: formatAchievementValue(achievement.unit, achievement.value),
          next: formatAchievementValue(achievement.unit, next),
        })}
      </span>
      <div
        className="achievement__progress"
        role="progressbar"
        aria-label={achievementText('name', achievement.id)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
      >
        <span style={{ width: `${String(share * 100)}%` }} />
      </div>
    </>
  );
}

function Open({ achievement }: { achievement: PlayerAchievement }) {
  const next = achievement.nextThreshold;
  const yesNo = achievement.tiers.length === 1 && achievement.tiers[0] === 1;
  return (
    <li className="achievement achievement--open">
      <div className="achievement__title">
        <span>{achievementText('name', achievement.id)}</span>
      </div>
      <span className="muted small">{achievementText('desc', achievement.id)}</span>
      {thresholdList(achievement) && (
        <span className="muted small">{thresholdList(achievement)}</span>
      )}
      {achievement.liveOnly && <span className="muted small">{t('achievements.liveOnly')}</span>}
      {next !== null && !yesNo && <Progress achievement={achievement} next={next} />}
    </li>
  );
}

/** Badges of a player's person and the progress towards the open ones (T13.4). */
export function PlayerAchievementsCard({ userId }: { userId: number }) {
  const { data, error } = useApi((signal) => api.playerAchievements(userId, signal), [userId]);
  if (error && !data) return <p className="alert">{error}</p>;
  if (!data) return <p className="muted">{t('common.loading')}</p>;

  const earned = data.achievements.filter((a) => a.earned.length > 0);
  // Secret achievements stay a surprise until they are reached.
  const open = data.achievements.filter((a) => a.earned.length === 0 && !a.secret);
  const total = data.achievements.filter((a) => !a.secret || a.earned.length > 0).length;
  return (
    <div className="stack">
      <p className="muted">{t('pach.count', { earned: earned.length, total })}</p>
      {earned.length === 0 ? (
        <p className="muted">{t('pach.none')}</p>
      ) : (
        <ul className="achievement-grid" aria-label={t('pach.title')}>
          {earned.map((a) => (
            <Earned key={a.id} achievement={a} />
          ))}
        </ul>
      )}
      {open.length > 0 && (
        <details>
          <summary>{t('pach.open')}</summary>
          <ul className="achievement-grid" aria-label={t('pach.open')}>
            {open.map((a) => (
              <Open key={a.id} achievement={a} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
