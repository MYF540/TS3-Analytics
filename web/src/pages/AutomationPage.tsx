import { Link, useSearchParams } from 'react-router';
import { api } from '../api/client';
import type { AutomationLogEntry, AutomationModule } from '../api/types';
import { Pagination } from '../components/Pagination';
import { useApi } from '../hooks/useApi';
import { automationActionLabel, formatDateTime, t } from '../i18n';
import { PageHeader } from './pages';

const PAGE_SIZE = 50;

const MODULE_IDS: readonly AutomationModule[] = [
  'nickname',
  'support',
  'staff',
  'channels',
  'private',
  'rules',
  'spam',
  'proxy',
];

function isModule(value: string): value is AutomationModule {
  return (MODULE_IDS as readonly string[]).includes(value);
}

function ResultBadge({ result }: { result: AutomationLogEntry['result'] }) {
  const tone = result === 'done' ? 'active' : result === 'dry' ? 'unknown' : 'idle';
  return <span className={`state state--${tone}`}>{t(`automation.result.${result}`)}</span>;
}

/** Overview of the bot modules and the log of what they did (T10.2), admins only. */
export function AutomationPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('modul') ?? '';
  const module = isModule(selected) ? selected : undefined;
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

  const overview = useApi((signal) => api.automation(signal), []);
  const log = useApi(
    (signal) => api.automationLog({ module, page, pageSize: PAGE_SIZE }, signal),
    [module, page],
  );

  return (
    <section className="stack">
      <PageHeader title={t('page.automation.title')} intro={t('page.automation.intro')} />

      {overview.error && <p className="alert">{overview.error}</p>}
      <div className="card" aria-busy={overview.loading}>
        <h2>{t('automation.modules')}</h2>
        {overview.data && overview.data.modules.length === 0 && (
          <p className="muted">{t('automation.noModules')}</p>
        )}
        {overview.data && overview.data.modules.length > 0 && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('automation.col.module')}</th>
                  <th scope="col">{t('automation.col.state')}</th>
                  <th scope="col">{t('automation.col.what')}</th>
                  <th scope="col">{t('automation.col.settings')}</th>
                </tr>
              </thead>
              <tbody>
                {overview.data.modules.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">{t(`automation.module.${entry.id}`)}</th>
                    <td>
                      {!entry.enabled ? (
                        <span className="state state--unknown">{t('automation.state.off')}</span>
                      ) : entry.dryRun ? (
                        <span className="state state--idle">{t('automation.state.dry')}</span>
                      ) : (
                        <span className="state state--active">{t('automation.state.live')}</span>
                      )}
                    </td>
                    <td className="muted">{t(`automation.about.${entry.id}`)}</td>
                    <td>
                      <Link
                        to={`/automatik/${entry.id}`}
                        aria-label={t('automation.configureModule', {
                          module: t(`automation.module.${entry.id}`),
                        })}
                      >
                        {t('automation.configure')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">{t('automation.dryHint')}</p>
      </div>

      <div className="toolbar card">
        <label className="field">
          <span>{t('automation.col.module')}</span>
          <select
            value={module ?? ''}
            onChange={(event) => {
              update({ modul: event.target.value });
            }}
          >
            <option value="">{t('audit.all')}</option>
            {MODULE_IDS.map((id) => (
              <option key={id} value={id}>
                {t(`automation.module.${id}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {log.error && <p className="alert">{log.error}</p>}
      <div className="card" aria-busy={log.loading}>
        <h2>{t('automation.log')}</h2>
        {log.data && log.data.items.length === 0 && (
          <p className="muted">{t('automation.empty')}</p>
        )}
        {log.data && log.data.items.length > 0 && (
          <div className="table-scroll">
            <table className="data-table audit-table">
              <thead>
                <tr>
                  <th scope="col">{t('audit.time')}</th>
                  <th scope="col">{t('automation.col.module')}</th>
                  <th scope="col">{t('audit.action')}</th>
                  <th scope="col">{t('automation.col.player')}</th>
                  <th scope="col">{t('audit.details')}</th>
                  <th scope="col">{t('audit.result')}</th>
                </tr>
              </thead>
              <tbody>
                {log.data.items.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDateTime(entry.at)}</td>
                    <td>{t(`automation.module.${entry.module}`)}</td>
                    <td>{automationActionLabel(entry.action)}</td>
                    <td>
                      {entry.userId === null ? (
                        ''
                      ) : (
                        <Link to={`/spieler/${String(entry.userId)}`}>
                          {entry.nickname ?? t('automation.unknownPlayer')}
                        </Link>
                      )}
                    </td>
                    <td className="audit-table__details">{entry.detail ?? ''}</td>
                    <td>
                      <ResultBadge result={entry.result} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {log.data && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={log.data.total}
            onChange={(next) => {
              update({ page: String(next) }, false);
            }}
          />
        )}
        {overview.data && (
          <p className="muted">
            {t('automation.retention', { days: overview.data.retentionDays })}
          </p>
        )}
      </div>
    </section>
  );
}
