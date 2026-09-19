import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { PlayerRank } from '../api/types';
import { hasRole, useCurrentUser } from '../auth/context';
import { useApi } from '../hooks/useApi';
import { formatDateTime, formatDuration, t } from '../i18n';

function parseHours(value: string): number | undefined {
  const n = Number(value.trim().replace(',', '.'));
  return value.trim() !== '' && Number.isFinite(n) && Math.abs(n) <= 100_000 ? n : undefined;
}

function OverrideForm({
  userId,
  rank,
  onSaved,
}: {
  userId: number;
  rank: PlayerRank;
  onSaved: (next: PlayerRank) => void;
}) {
  const current = rank.override;
  const [frozen, setFrozen] = useState(current?.frozenRankId?.toString() ?? '');
  const [bonus, setBonus] = useState(
    current ? String(Math.round((current.bonusS / 3600) * 100) / 100) : '0',
  );
  const [excluded, setExcluded] = useState(current?.excluded ?? false);
  const [note, setNote] = useState(current?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const bonusHours = parseHours(bonus);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (bonusHours === undefined) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    api
      .setRankOverride(userId, {
        frozenRankId: frozen === '' ? null : Number(frozen),
        bonusHours,
        excluded,
        note: note.trim() || null,
      })
      .then(
        (next) => {
          setBusy(false);
          setMessage(t('prank.saved'));
          onSaved(next);
        },
        (e: unknown) => {
          setBusy(false);
          setError(describeError(e));
        },
      );
  };

  return (
    <form className="stack prank-form" onSubmit={submit}>
      <h3>{t('prank.override')}</h3>
      <p className="muted small">{t('prank.linkedHint')}</p>
      <div className="field-row">
        <label className="field field--narrow">
          <span>{t('prank.freeze')}</span>
          <select
            value={frozen}
            onChange={(event) => {
              setFrozen(event.target.value);
            }}
          >
            <option value="">{t('prank.freezeNone')}</option>
            {rank.ranks.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--narrow">
          <span>{t('prank.bonus')}</span>
          <input
            inputMode="decimal"
            value={bonus}
            aria-invalid={bonusHours === undefined}
            onChange={(event) => {
              setBonus(event.target.value);
            }}
          />
        </label>
      </div>
      <p className="muted small">{t('prank.bonusHint')}</p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={excluded}
          onChange={(event) => {
            setExcluded(event.target.checked);
          }}
        />
        {t('prank.exclude')}
      </label>
      <label className="field">
        <span>{t('prank.note')}</span>
        <input
          maxLength={500}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </label>
      {current && (
        <p className="muted small">
          {t('prank.changedBy', {
            name: current.updatedBy,
            time: formatDateTime(current.updatedAt),
          })}
        </p>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button
          type="submit"
          className="button button--small"
          disabled={busy || bonusHours === undefined}
        >
          {t('prank.save')}
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

/** The player's rank (T6.5); admins can freeze it, add bonus hours or exclude the player. */
export function PlayerRankCard({ userId }: { userId: number }) {
  const user = useCurrentUser();
  const isAdmin = hasRole(user, 'admin');
  const { data, error } = useApi((signal) => api.playerRank(userId, signal), [userId]);
  const [saved, setSaved] = useState<PlayerRank>();
  const rank = saved ?? data;

  if (error) return <p className="alert">{error}</p>;
  if (!rank) return <p className="muted">{t('common.loading')}</p>;
  if (!rank.enabled) {
    return (
      <p className="muted">
        {t('prank.none')} {isAdmin && <Link to="/raenge">{t('prank.setup')}</Link>}
      </p>
    );
  }
  return (
    <div className="stack">
      {rank.skipped ? (
        <p className="muted">{t(`prank.skipped.${rank.skipped}`)}</p>
      ) : (
        <dl className="facts">
          <div>
            <dt>{t('prank.current')}</dt>
            <dd>
              <strong>{rank.target?.name ?? t('prank.noRank')}</strong>
              {rank.frozen && <span className="badge">{t('prank.frozen')}</span>}
              {rank.pending && <span className="badge">{t('prank.pending')}</span>}
              {rank.dryRun && <span className="badge">{t('prank.dryRun')}</span>}
            </dd>
          </div>
          <div>
            <dt>{t('prank.time')}</dt>
            <dd>{formatDuration(rank.rankingS)}</dd>
          </div>
          {!rank.frozen && (
            <div>
              <dt />
              <dd className="muted small">
                {rank.next
                  ? t('prank.next', {
                      name: rank.next.name,
                      time: formatDuration(rank.next.remainingS),
                    })
                  : t('prank.top')}
              </dd>
            </div>
          )}
        </dl>
      )}
      {isAdmin && <OverrideForm userId={userId} rank={rank} onSaved={setSaved} />}
    </div>
  );
}
