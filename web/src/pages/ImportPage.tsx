import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, describeError } from '../api/client';
import type { ImportComparison } from '../api/types';
import { Pagination } from '../components/Pagination';
import { useApi } from '../hooks/useApi';
import { formatDuration, formatNumber, t } from '../i18n';
import { PageHeader } from './pages';

const PAGE_SIZE = 25;

type Item = ImportComparison['items'][number];

function Row({ item, onDecided }: { item: Item; onDecided: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const decide = (use: 'logs' | 'legacy') => {
    // Taking the log time over can take time away – the logs may not reach back far enough.
    if (use === 'logs' && item.logS < item.legacyS) {
      const question = t('import.confirmLower', {
        name: item.nickname ?? t('flags.unknownPlayer', { id: item.userId }),
        from: formatDuration(item.legacyS),
        to: formatDuration(item.logS),
      });
      if (!window.confirm(question)) return;
    }
    setBusy(true);
    setError(undefined);
    api.decideImport(item.userId, use).then(
      () => {
        setBusy(false);
        onDecided();
      },
      (e: unknown) => {
        setBusy(false);
        setError(describeError(e));
      },
    );
  };

  return (
    <tr>
      <th scope="row">
        <Link to={`/spieler/${String(item.userId)}`}>
          {item.nickname ?? t('flags.unknownPlayer', { id: item.userId })}
        </Link>
        {item.placeholder && (
          <>
            {' '}
            <span className="badge">{t('import.placeholder')}</span>
          </>
        )}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </th>
      <td>{formatDuration(item.logS)}</td>
      <td>{formatDuration(item.legacyS)}</td>
      <td>
        {item.diffS >= 0 ? '+' : '−'}
        {formatDuration(Math.abs(item.diffS))}
      </td>
      <td>
        <div className="button-row">
          <button
            type="button"
            className="button button--small"
            disabled={busy || item.logS === item.legacyS}
            onClick={() => {
              decide('logs');
            }}
          >
            {t('import.useLogs')}
          </button>
          <button
            type="button"
            className="button button--small"
            disabled={busy}
            onClick={() => {
              decide('legacy');
            }}
          >
            {t('import.keep')}
          </button>
        </div>
      </td>
    </tr>
  );
}

export function ImportPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const both = params.get('quellen') !== 'alle';
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useApi(
    (signal) => api.importComparison({ page, pageSize: PAGE_SIZE, both }, signal),
    [page, both, version],
  );

  const update = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  return (
    <section className="stack">
      <PageHeader title={t('page.import.title')} intro={t('page.import.intro')} />
      <div className="toolbar toolbar--plain">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={both}
            onChange={(event) => {
              update({ quellen: event.target.checked ? undefined : 'alle', page: undefined });
            }}
          />
          <span>{t('import.onlyBoth')}</span>
        </label>
      </div>
      {error && <p className="alert">{error}</p>}
      {data && (
        <div className="card stack" aria-busy={loading}>
          <p className="muted small">
            {t('import.summary', {
              total: formatNumber(data.total),
              matching: formatNumber(data.matching),
              tolerance: formatDuration(data.toleranceS),
            })}
          </p>
          {data.items.length === 0 ? (
            <p className="muted">{t('import.empty')}</p>
          ) : (
            <>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('import.col.player')}</th>
                      <th scope="col">{t('import.col.logs')}</th>
                      <th scope="col">{t('import.col.legacy')}</th>
                      <th scope="col">{t('import.col.diff')}</th>
                      <th scope="col">{t('import.col.decision')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => (
                      <Row
                        key={item.userId}
                        item={item}
                        onDecided={() => {
                          setVersion((v) => v + 1);
                        }}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={data.total}
                onChange={(next) => {
                  update({ page: String(next) });
                }}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
