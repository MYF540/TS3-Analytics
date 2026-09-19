import { useSearchParams } from 'react-router';
import { api } from '../api/client';
import { Pagination } from '../components/Pagination';
import { useApi } from '../hooks/useApi';
import { auditActionLabel as actionLabel, formatDateTime, t } from '../i18n';
import { PageHeader } from './pages';

const PAGE_SIZE = 50;

function formatDetails(details: Record<string, unknown> | null): string {
  if (!details) return '';
  return Object.entries(details)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');
}

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const actor = params.get('person') ?? '';
  const action = params.get('aktion') ?? '';
  const from = params.get('von') ?? '';
  const to = params.get('bis') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const update = (changes: Record<string, string>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (resetPage) next.delete('page');
    setParams(next, { replace: true });
  };

  const filters = useApi((signal) => api.auditFilters(signal), []);
  const { data, error, loading } = useApi(
    (signal) =>
      api.audit(
        {
          actor: actor || undefined,
          action: action || undefined,
          from: from || undefined,
          to: to || undefined,
          page,
          pageSize: PAGE_SIZE,
        },
        signal,
      ),
    [actor, action, from, to, page],
  );

  return (
    <section className="stack">
      <PageHeader title={t('page.audit.title')} intro={t('page.audit.intro')} />
      <div className="toolbar card">
        <label className="field">
          <span>{t('audit.actor')}</span>
          <select
            value={actor}
            onChange={(event) => {
              update({ person: event.target.value });
            }}
          >
            <option value="">{t('audit.all')}</option>
            {filters.data?.actors.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('audit.action')}</span>
          <select
            value={action}
            onChange={(event) => {
              update({ aktion: event.target.value });
            }}
          >
            <option value="">{t('audit.all')}</option>
            {filters.data?.actions.map((code) => (
              <option key={code} value={code}>
                {actionLabel(code)}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--narrow">
          <span>{t('lb.from')}</span>
          <input
            type="date"
            value={from}
            onChange={(event) => {
              update({ von: event.target.value });
            }}
          />
        </label>
        <label className="field field--narrow">
          <span>{t('lb.to')}</span>
          <input
            type="date"
            value={to}
            onChange={(event) => {
              update({ bis: event.target.value });
            }}
          />
        </label>
      </div>

      {error && <p className="alert">{error}</p>}
      <div className="card" aria-busy={loading}>
        {data && data.items.length === 0 && <p className="muted">{t('audit.empty')}</p>}
        {data && data.items.length > 0 && (
          <div className="table-scroll">
            <table className="data-table audit-table">
              <thead>
                <tr>
                  <th scope="col">{t('audit.time')}</th>
                  <th scope="col">{t('audit.actor')}</th>
                  <th scope="col">{t('audit.action')}</th>
                  <th scope="col">{t('audit.target')}</th>
                  <th scope="col">{t('audit.details')}</th>
                  <th scope="col">{t('audit.result')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDateTime(entry.at)}</td>
                    <td>{entry.actorName}</td>
                    <td>{actionLabel(entry.action)}</td>
                    <td>
                      {entry.targetType ? `${entry.targetType} ${entry.targetId ?? ''}`.trim() : ''}
                    </td>
                    <td className="audit-table__details">{formatDetails(entry.details)}</td>
                    <td>
                      {entry.status === null ? (
                        ''
                      ) : entry.status < 400 ? (
                        <span className="state state--active">{t('audit.ok')}</span>
                      ) : (
                        <span className="state state--idle">
                          {t('audit.failed', { status: entry.status })}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
