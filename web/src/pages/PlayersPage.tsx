import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api/client';
import type { UserSort } from '../api/types';
import { Pagination } from '../components/Pagination';
import { useApi } from '../hooks/useApi';
import { formatDateTime, formatDuration, formatNumber, t, type MessageKey } from '../i18n';
import { PageHeader } from './pages';

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 300;

const COLUMNS: { sort: UserSort; label: MessageKey; numeric: boolean }[] = [
  { sort: 'nickname', label: 'players.col.nickname', numeric: false },
  { sort: 'online', label: 'players.col.online', numeric: true },
  { sort: 'active', label: 'players.col.active', numeric: true },
  { sort: 'sessions', label: 'players.col.sessions', numeric: true },
  { sort: 'lastSeen', label: 'players.col.lastSeen', numeric: true },
  { sort: 'firstSeen', label: 'players.col.firstSeen', numeric: true },
];

const SORTS = new Set<string>(COLUMNS.map((c) => c.sort));

/** List state lives in the URL so back/forward and shared links keep search and page. */
function useListParams() {
  const [params, setParams] = useSearchParams();
  const sortParam = params.get('sort') ?? 'online';
  const sort: UserSort = SORTS.has(sortParam) ? (sortParam as UserSort) : 'online';
  const order = params.get('order') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const search = params.get('q') ?? '';
  const includeCasual = params.get('casual') === '1';

  const update = (changes: Record<string, string | undefined>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === '') next.delete(key);
      else next.set(key, value);
    }
    if (resetPage) next.delete('page');
    setParams(next, { replace: true });
  };
  return { sort, order, page, search, includeCasual, update } as const;
}

export function PlayersPage() {
  const { sort, order, page, search, includeCasual, update } = useListParams();
  const [input, setInput] = useState(search);

  useEffect(() => {
    if (input === search) return;
    const timer = setTimeout(() => {
      update({ q: input.trim() });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `update` changes with every render
  }, [input, search]);

  const { data, error, loading } = useApi(
    (signal) =>
      api.users(
        {
          search,
          sort,
          order,
          page,
          pageSize: PAGE_SIZE,
          includeCasual: includeCasual || undefined,
        },
        signal,
      ),
    [search, sort, order, page, includeCasual],
  );

  const toggleSort = (column: (typeof COLUMNS)[number]) => {
    const nextOrder =
      column.sort === sort ? (order === 'asc' ? 'desc' : 'asc') : column.numeric ? 'desc' : 'asc';
    update({ sort: column.sort, order: nextOrder });
  };

  return (
    <section className="stack">
      <PageHeader title={t('page.players.title')} intro={t('page.players.intro')} />
      <div className="toolbar card">
        <label className="field">
          <span>{t('players.search')}</span>
          <input
            type="search"
            value={input}
            placeholder={t('players.searchPlaceholder')}
            onChange={(event) => {
              setInput(event.target.value);
            }}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includeCasual}
            onChange={(event) => {
              update({ casual: event.target.checked ? '1' : undefined });
            }}
          />
          <span>{t('players.includeCasual')}</span>
        </label>
        {data && (
          <span className="muted">{t('players.count', { count: formatNumber(data.total) })}</span>
        )}
      </div>

      {error && <p className="alert">{error}</p>}

      <div className="card table-card" aria-busy={loading}>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {COLUMNS.map((column) => {
                  const active = column.sort === sort;
                  return (
                    <th
                      key={column.sort}
                      scope="col"
                      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      <button
                        type="button"
                        className="sort-button"
                        title={t('players.sortBy', { column: t(column.label) })}
                        onClick={() => {
                          toggleSort(column);
                        }}
                      >
                        {t(column.label)}
                        <span aria-hidden="true">
                          {active ? (order === 'asc' ? ' ▲' : ' ▼') : ''}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {data?.items.map((user) => (
                <tr key={user.userId}>
                  <td>
                    <Link to={`/spieler/${String(user.userId)}`}>
                      {user.nickname ?? t('players.unknownNick')}
                    </Link>
                    {user.online && (
                      <span className="badge badge--online">{t('players.onlineNow')}</span>
                    )}
                    {user.country && <span className="muted country"> {user.country}</span>}
                  </td>
                  <td>{formatDuration(user.onlineS)}</td>
                  <td>{formatDuration(user.activeS)}</td>
                  <td>{formatNumber(user.sessions)}</td>
                  <td>{formatDateTime(user.lastSeen)}</td>
                  <td>{formatDateTime(user.firstSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.items.length === 0 && <p className="muted">{t('players.empty')}</p>}
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
