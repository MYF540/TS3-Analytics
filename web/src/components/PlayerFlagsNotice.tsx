import { Link } from 'react-router';
import { api } from '../api/client';
import { hasRole, useCurrentUser } from '../auth/context';
import { useApi } from '../hooks/useApi';
import { t } from '../i18n';

function OpenFlags({ userId }: { userId: number }) {
  const { data } = useApi(
    (signal) => api.flags({ status: 'open', userId, pageSize: 1 }, signal),
    [userId],
  );
  if (!data || data.total === 0) return null;
  return (
    <p className="notice">
      {t('player.flags', { count: data.total })}{' '}
      <Link to={`/hinweise?spieler=${String(userId)}`}>{t('player.flagsLink')}</Link>
    </p>
  );
}

/** Points moderators to open alt/evasion hints about this player (T5.2). */
export function PlayerFlagsNotice({ userId }: { userId: number }) {
  const user = useCurrentUser();
  return hasRole(user, 'moderator') ? <OpenFlags userId={userId} /> : null;
}
