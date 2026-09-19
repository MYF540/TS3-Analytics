import { Fragment, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, describeError } from '../api/client';
import type { FlagItem, FlagStatus, PlayerRef } from '../api/types';
import { Pagination } from '../components/Pagination';
import { useApi } from '../hooks/useApi';
import { de, type MessageKey } from '../i18n/de';
import { formatDateTime, formatNumber, t } from '../i18n';
import { PageHeader } from './pages';

const PAGE_SIZE = 25;
const STATUSES = ['open', 'linked', 'ignored', 'all'] as const;
const LEVELS = ['all', 'high', 'medium', 'info'] as const;

/** Fills `{name}` placeholders with React nodes (e.g. links), keeping the German sentence. */
function fill(key: MessageKey, parts: Record<string, ReactNode>): ReactNode {
  return de[key].split(/(\{\w+\})/).map((piece, index) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    // The template is static, so the index is a stable key.
    return (
      <Fragment key={index}>{name !== undefined && name in parts ? parts[name] : piece}</Fragment>
    );
  });
}

function PlayerLink({ player }: { player: PlayerRef }) {
  return (
    <Link to={`/spieler/${String(player.id)}`}>
      {player.nickname ?? t('flags.unknownPlayer', { id: player.id })}
    </Link>
  );
}

function description(flag: FlagItem): ReactNode {
  const user = <PlayerLink player={flag.user} />;
  const related = flag.related ? <PlayerLink player={flag.related} /> : null;
  const ban = flag.ban ? String(flag.ban.id) : '';
  if (flag.kind === 'shared_ip') return fill('flags.kind.shared_ip', { user, related });
  const key: MessageKey =
    related === null ? (`flags.kind.${flag.kind}.ipBan` as const) : `flags.kind.${flag.kind}`;
  return fill(key, { user, related, ban });
}

function FlagCard({ flag, onChanged }: { flag: FlagItem; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const setStatus = (status: FlagStatus) => {
    setBusy(true);
    setError(undefined);
    api.setFlagStatus(flag.id, status).then(
      () => {
        setBusy(false);
        onChanged();
      },
      (e: unknown) => {
        setBusy(false);
        setError(describeError(e));
      },
    );
  };

  const evidence =
    flag.kind === 'shared_ip'
      ? t('flags.evidenceShared', {
          ips: formatNumber(flag.evidence.sharedIps),
          time: formatDateTime(flag.evidence.lastSeen),
        })
      : t('flags.evidence', {
          ips: formatNumber(flag.evidence.sharedIps),
          subnets: formatNumber(flag.evidence.sharedSubnets),
          time: formatDateTime(flag.evidence.lastSeen),
        });

  return (
    <li className={`flag card flag--${flag.level}`}>
      <div className="flag__head">
        <span className={`flag__level flag__level--${flag.level}`}>
          {t(`flags.level.${flag.level}`)}
        </span>
        {flag.status !== 'open' && (
          <span className="badge">{t(`flags.status.${flag.status}`)}</span>
        )}
        {!flag.current && <span className="badge">{t('flags.stale')}</span>}
      </div>
      <p className="flag__text">{description(flag)}</p>
      <p className="muted small">{evidence}</p>
      {flag.ban && (
        <p className="muted small">
          {flag.ban.reason ? t('flags.banReason', { reason: flag.ban.reason }) : null}
          {!flag.ban.active && <> · {t('flags.banLifted')}</>}
        </p>
      )}
      <p className="muted small">
        {t('flags.detected', {
          first: formatDateTime(flag.firstDetected),
          last: formatDateTime(flag.lastDetected),
        })}
        {flag.decidedBy && flag.decidedAt !== null && (
          <>
            {' · '}
            {t('flags.decided', {
              status: t(`flags.status.${flag.status}`),
              name: flag.decidedBy,
              time: formatDateTime(flag.decidedAt),
            })}
          </>
        )}
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        {flag.status === 'open' ? (
          <>
            {flag.related && (
              <button
                type="button"
                className="button button--small"
                disabled={busy}
                title={t('flags.linkHint')}
                onClick={() => {
                  setStatus('linked');
                }}
              >
                {t('flags.link')}
              </button>
            )}
            <button
              type="button"
              className="button button--small"
              disabled={busy}
              onClick={() => {
                setStatus('ignored');
              }}
            >
              {t('flags.ignore')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button--small"
            disabled={busy}
            onClick={() => {
              setStatus('open');
            }}
          >
            {t('flags.reopen')}
          </button>
        )}
      </div>
    </li>
  );
}

export function FlagsPage() {
  const [params, setParams] = useSearchParams();
  const statusParam = params.get('status');
  const status = (STATUSES as readonly string[]).includes(statusParam ?? '')
    ? (statusParam as (typeof STATUSES)[number])
    : 'open';
  const levelParam = params.get('stufe');
  const level = (LEVELS as readonly string[]).includes(levelParam ?? '')
    ? (levelParam as (typeof LEVELS)[number])
    : 'all';
  const playerId = Number(params.get('spieler')) || undefined;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [version, setVersion] = useState(0);

  const update = (changes: Record<string, string | undefined>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (resetPage) next.delete('page');
    setParams(next, { replace: true });
  };

  const { data, error, loading } = useApi(
    (signal) => api.flags({ status, level, userId: playerId, page, pageSize: PAGE_SIZE }, signal),
    [status, level, playerId, page, version],
  );
  const filteredPlayer =
    playerId === undefined
      ? undefined
      : data?.items
          .flatMap((f) => [f.user, f.related])
          .find((p): p is PlayerRef => p?.id === playerId);

  return (
    <section className="stack">
      <PageHeader title={t('page.flags.title')} intro={t('page.flags.intro')} />
      <div className="tabs" role="tablist" aria-label={t('flags.statusTabs')}>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            id={`flags-tab-${s}`}
            aria-controls="flags-panel"
            className={s === status ? 'tab is-active' : 'tab'}
            aria-selected={s === status}
            onClick={() => {
              update({ status: s === 'open' ? undefined : s });
            }}
          >
            {t(`flags.status.${s}`)}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <div className="segmented" role="radiogroup" aria-label={t('flags.level')}>
          {LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={l === level}
              className={l === level ? 'segmented__item is-active' : 'segmented__item'}
              onClick={() => {
                update({ stufe: l === 'all' ? undefined : l });
              }}
            >
              {t(`flags.level.${l}`)}
              {l !== 'all' && data && data.openCounts[l] > 0 && (
                <span className="count">{formatNumber(data.openCounts[l])}</span>
              )}
            </button>
          ))}
        </div>
        {playerId !== undefined && (
          <p className="muted small">
            {t('flags.filteredPlayer', {
              name: filteredPlayer?.nickname ?? t('flags.unknownPlayer', { id: playerId }),
            })}{' '}
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                update({ spieler: undefined });
              }}
            >
              {t('flags.clearPlayer')}
            </button>
          </p>
        )}
        {data && (
          <p className="muted small">
            {data.lastRun === null
              ? t('flags.never')
              : t('flags.lastRun', { time: formatDateTime(data.lastRun) })}
          </p>
        )}
      </div>
      {error && <p className="alert">{error}</p>}
      <div
        role="tabpanel"
        id="flags-panel"
        aria-labelledby={`flags-tab-${status}`}
        aria-busy={loading}
      >
        {data && data.items.length === 0 && <p className="muted card">{t('flags.empty')}</p>}
        {data && data.items.length > 0 && (
          <ul className="flags">
            {data.items.map((flag) => (
              <FlagCard
                key={flag.id}
                flag={flag}
                onChanged={() => {
                  setVersion((v) => v + 1);
                }}
              />
            ))}
          </ul>
        )}
        {data && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data.total}
            onChange={(next) => {
              update({ page: String(next) }, false);
            }}
          />
        )}
      </div>
    </section>
  );
}
