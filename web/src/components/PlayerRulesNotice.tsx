import { api } from '../api/client';
import { hasRole, useCurrentUser } from '../auth/context';
import { useApi } from '../hooks/useApi';
import { formatDateTime, t } from '../i18n';

function Decision({ userId }: { userId: number }) {
  const { data } = useApi((signal) => api.playerRules(userId, signal), [userId]);
  if (!data?.enabled) return null;
  const { state, currentVersion } = data;
  if (state === null) return <p className="notice">{t('player.rules.none')}</p>;
  const time = formatDateTime(state.at);
  if (state.decision === 'declined') {
    return <p className="notice notice--warn">{t('player.rules.declined', { time })}</p>;
  }
  return (
    <p className="notice">
      {state.version >= currentVersion
        ? t('player.rules.accepted', { time })
        : t('player.rules.outdated', { time, version: state.version })}
    </p>
  );
}

/** Tells moderators whether this player confirmed the server rules (T10.8). */
export function PlayerRulesNotice({ userId }: { userId: number }) {
  const user = useCurrentUser();
  return hasRole(user, 'moderator') ? <Decision userId={userId} /> : null;
}
