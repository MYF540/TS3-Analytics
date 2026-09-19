import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { Person, UserListItem } from '../api/types';
import { hasRole, useCurrentUser } from '../auth/context';
import { formatDateTime, t } from '../i18n';

interface Props {
  userId: number;
  person: Person | null;
  /** Called after a change, so the page reloads its (combined) figures. */
  onChanged: () => void;
}

function AddAccount({
  userId,
  exclude,
  onLinked,
}: {
  userId: number;
  exclude: ReadonlySet<number>;
  onLinked: () => void;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<UserListItem[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const search = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (term.trim().length < 2) return;
    setBusy(true);
    setError(undefined);
    api.users({ search: term.trim(), pageSize: 10, includeCasual: true }).then(
      (res) => {
        setResults(res.items.filter((u) => !exclude.has(u.userId)));
        setBusy(false);
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
      },
    );
  };

  const link = (other: number) => {
    setBusy(true);
    setError(undefined);
    api.linkUser(userId, other).then(
      () => {
        setBusy(false);
        setResults(undefined);
        setTerm('');
        onLinked();
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
      },
    );
  };

  return (
    <div className="accounts__add">
      <form className="accounts__search" onSubmit={search}>
        <label className="field">
          <span>{t('accounts.search')}</span>
          <input
            type="search"
            value={term}
            onChange={(event) => {
              setTerm(event.target.value);
            }}
          />
        </label>
        <button type="submit" className="button" disabled={busy || term.trim().length < 2}>
          {t('accounts.add')}
        </button>
      </form>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {results && results.length === 0 && <p className="muted">{t('accounts.noResults')}</p>}
      {results && results.length > 0 && (
        <ul className="accounts__results">
          {results.map((u) => (
            <li key={u.userId}>
              <span>
                {u.nickname ?? t('players.unknownNick')} <code className="uid">{u.uid}</code>
              </span>
              <button
                type="button"
                className="button button--small"
                disabled={busy}
                onClick={() => {
                  link(u.userId);
                }}
              >
                {t('accounts.link')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Linked UIDs of this player's person (T5.3); moderators can change the links. */
export function PlayerAccounts({ userId, person, onChanged }: Props) {
  const user = useCurrentUser();
  const canEdit = hasRole(user, 'moderator');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    action().then(
      () => {
        setBusy(false);
        onChanged();
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
      },
    );
  };

  const members = person?.members ?? [];
  return (
    <>
      {person ? (
        <>
          <p className="muted small">{t('accounts.combined')}</p>
          <p className="muted small">{t('accounts.overlap')}</p>
          <ul className="accounts">
            {members.map((m) => {
              const name = m.nickname ?? t('players.unknownNick');
              return (
                <li key={m.userId}>
                  <div>
                    {m.userId === userId ? (
                      <strong>{name}</strong>
                    ) : (
                      <Link to={`/spieler/${String(m.userId)}`}>{name}</Link>
                    )}
                    {m.userId === person.primaryUserId && (
                      <span className="badge">{t('accounts.primary')}</span>
                    )}
                    {m.userId === userId && <span className="badge">{t('accounts.current')}</span>}
                    <div className="muted small">
                      <code className="uid">{m.uid}</code> ·{' '}
                      {t('accounts.added', { name: m.addedBy, time: formatDateTime(m.addedAt) })}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="button-row">
                      {m.userId !== person.primaryUserId && (
                        <button
                          type="button"
                          className="button button--small"
                          disabled={busy}
                          onClick={() => {
                            run(() => api.setPrimaryUser(m.userId));
                          }}
                        >
                          {t('accounts.makePrimary')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="button button--small"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(t('accounts.removeConfirm', { name }))) {
                            run(() => api.unlinkUser(m.userId));
                          }
                        }}
                      >
                        {t('accounts.remove')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="muted">{t('accounts.none')}</p>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {canEdit && (
        <AddAccount
          userId={userId}
          exclude={new Set([userId, ...members.map((m) => m.userId)])}
          onLinked={onChanged}
        />
      )}
    </>
  );
}
