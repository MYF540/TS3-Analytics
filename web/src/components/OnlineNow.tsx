import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { OnlineNow as OnlineNowData } from '../api/types';
import { formatDateTime, t, type MessageKey } from '../i18n';

const REFRESH_MS = 30_000;

const STATE_LABEL: Record<'active' | 'idle' | 'afk', MessageKey> = {
  active: 'player.state.active',
  idle: 'player.state.idle',
  afk: 'player.state.afk',
};

/** Players connected right now, refreshed every 30 seconds. */
export function OnlineNow() {
  const [data, setData] = useState<OnlineNowData | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      api
        .onlineNow(controller.signal)
        .then((result) => {
          setData(result);
          setFailed(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  return (
    <section className="card">
      <header className="chart-card__header">
        <h2>{t('online.title')}</h2>
        {data?.connected && (
          <span className="muted">{t('online.count', { count: data.items.length })}</span>
        )}
      </header>
      {failed && <p className="alert">{t('error.NETWORK')}</p>}
      {data && !data.connected && <p className="muted">{t('online.disconnected')}</p>}
      {data?.connected && data.items.length === 0 && <p className="muted">{t('online.empty')}</p>}
      {data?.connected && data.items.length > 0 && (
        <div className="table-scroll">
          <table className="data-table online-table">
            <thead>
              <tr>
                <th scope="col">{t('lb.col.player')}</th>
                <th scope="col">{t('player.channels.channel')}</th>
                <th scope="col">{t('online.state')}</th>
                <th scope="col">{t('online.since')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((client) => (
                <tr key={`${String(client.userId)}-${String(client.since)}`}>
                  <td>
                    <Link to={`/spieler/${String(client.userId)}`}>{client.nickname}</Link>
                  </td>
                  <td>{client.channelName ?? t('player.channels.deleted')}</td>
                  <td>
                    {client.state ? (
                      <span className={`state state--${client.state}`}>
                        {t(STATE_LABEL[client.state])}
                      </span>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>{formatDateTime(client.since)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
