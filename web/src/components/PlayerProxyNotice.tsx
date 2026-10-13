import { Link } from 'react-router';
import { api } from '../api/client';
import { hasRole, useCurrentUser } from '../auth/context';
import { useApi } from '../hooks/useApi';
import { formatDateTime, t } from '../i18n';

function Verdict({ userId }: { userId: number }) {
  const { data } = useApi((signal) => api.playerProxy(userId, signal), [userId]);
  if (data?.verdict !== 'proxy' || data.checkedAt === null) return null;
  const { vouch } = data;
  return (
    <p className={vouch ? 'notice' : 'notice notice--warn'}>
      {t('player.proxy', { time: formatDateTime(data.checkedAt) })}
      {vouch && (
        <>
          {' '}
          {t('player.proxy.vouchedBy')}{' '}
          {vouch.sponsorUserId === null ? (
            t('player.proxy.unknownSponsor')
          ) : (
            <Link to={`/spieler/${String(vouch.sponsorUserId)}`}>
              {vouch.sponsorNickname ?? t('automation.unknownPlayer')}
            </Link>
          )}{' '}
          {t('player.proxy.vouchedAt', { time: formatDateTime(vouch.at) })}
        </>
      )}
    </p>
  );
}

/** Tells moderators that this player was last seen with a VPN or proxy (T10.10). */
export function PlayerProxyNotice({ userId }: { userId: number }) {
  const user = useCurrentUser();
  return hasRole(user, 'moderator') ? <Verdict userId={userId} /> : null;
}
