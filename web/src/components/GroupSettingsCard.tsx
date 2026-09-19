import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { GroupSettings } from '../api/types';
import { useApi } from '../hooks/useApi';
import { formatDateTime, t } from '../i18n';

function ProtectedGroups({ initial }: { initial: GroupSettings }) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set(initial.protectedGroupIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  // Protected ids that are no longer on the server stay selectable (and removable).
  const groups = [
    ...initial.knownGroups,
    ...initial.protectedGroupIds
      .filter((id) => !initial.knownGroups.some((g) => g.id === id))
      .map((id) => ({ id, name: `#${String(id)}` })),
  ];

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    api.saveGroupSettings([...selected]).then(
      () => {
        setMessage(t('settings.saved'));
        setBusy(false);
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
      },
    );
  };

  return (
    <form className="stack" onSubmit={submit}>
      <fieldset className="settings-form__channels">
        <legend>{t('groups.protected')}</legend>
        {groups.length === 0 ? (
          <p className="muted small">{t('groups.noGroups')}</p>
        ) : (
          <ul className="channel-list">
            {groups.map((g) => (
              <li key={g.id}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={selected.has(g.id)}
                    onChange={() => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(g.id)) next.delete(g.id);
                        else next.add(g.id);
                        return next;
                      });
                      setMessage(undefined);
                    }}
                  />
                  {g.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={busy}>
          {t('groups.save')}
        </button>
        {message && (
          <span className="state state--active" role="status">
            {message}
          </span>
        )}
      </div>
    </form>
  );
}

function History() {
  const { data, error } = useApi((signal) => api.groupChanges({ pageSize: 20 }, signal), []);
  if (error) return <p className="alert">{error}</p>;
  if (!data) return null;
  if (data.items.length === 0) return <p className="muted">{t('groups.historyEmpty')}</p>;
  return (
    <div className="table-scroll">
      <table className="data-table text-table">
        <thead>
          <tr>
            <th scope="col">{t('groups.col.time')}</th>
            <th scope="col">{t('groups.col.player')}</th>
            <th scope="col">{t('groups.col.change')}</th>
            <th scope="col">{t('groups.col.by')}</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((c) => {
            const name = c.nickname ?? t('players.unknownNick');
            return (
              <tr key={c.id}>
                <td>{formatDateTime(c.at)}</td>
                <td>
                  {c.userId === null ? (
                    name
                  ) : (
                    <Link to={`/spieler/${String(c.userId)}`}>{name}</Link>
                  )}
                </td>
                <td>
                  {t(c.action === 'added' ? 'groups.added' : 'groups.removed', {
                    group: c.groupName,
                  })}
                  {c.protected && <span className="badge">{t('groups.protectedBadge')}</span>}
                </td>
                <td>{c.invokerName}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Protected server groups and recent group changes from the server log (T5.7). */
export function GroupSettingsCard() {
  const { data, error } = useApi((signal) => api.groupSettings(signal), []);
  return (
    <section className="card stack settings-form">
      <h2>{t('groups.title')}</h2>
      <p className="muted small">{t('groups.intro')}</p>
      <p className="muted small">{t('groups.permissionHint')}</p>
      {error && <p className="alert">{error}</p>}
      {data && <ProtectedGroups initial={data} />}
      <h3>{t('groups.history')}</h3>
      <History />
    </section>
  );
}
