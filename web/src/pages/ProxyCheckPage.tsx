import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { ProxySettings } from '../api/types';
import { ModuleBaseFields } from '../components/ModuleBaseFields';
import { useApi } from '../hooks/useApi';
import { formatDateTime, formatNumber, t } from '../i18n';
import { PageHeader } from './pages';

type Settings = ProxySettings['settings'];

/** Ban duration in minutes and the exempt players as a list of ids, both edited as text. */
interface Draft extends Omit<Settings, 'banDurationS' | 'exemptUserIds'> {
  banMinutes: string;
  exemptUsers: string;
}

const BAN_MAX_MINUTES = 30 * 1440;

function toDraft(settings: Settings): Draft {
  const { banDurationS, exemptUserIds, ...rest } = settings;
  return {
    ...rest,
    banMinutes: String(Math.round(banDurationS / 60)),
    exemptUsers: exemptUserIds.join(', '),
  };
}

function parseIds(text: string): number[] | undefined {
  const parts = text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.some((part) => !/^[1-9]\d{0,9}$/.test(part)) || parts.length > 500) return undefined;
  return [...new Set(parts.map(Number))];
}

function toSettings(draft: Draft): Settings | undefined {
  const minutes = /^\d+$/.test(draft.banMinutes.trim()) ? Number(draft.banMinutes) : 0;
  const exemptUserIds = parseIds(draft.exemptUsers);
  if (
    minutes < 1 ||
    minutes > BAN_MAX_MINUTES ||
    exemptUserIds === undefined ||
    draft.message.trim() === '' ||
    draft.notifyMessage.trim() === '' ||
    (draft.action === 'group' && draft.groupId === null)
  ) {
    return undefined;
  }
  return {
    enabled: draft.enabled,
    dryRun: draft.dryRun,
    exemptGroupIds: draft.exemptGroupIds,
    action: draft.action,
    message: draft.message.trim(),
    groupId: draft.groupId,
    banDurationS: minutes * 60,
    notifyGroupIds: draft.notifyGroupIds,
    notifyMessage: draft.notifyMessage.trim(),
    exemptUserIds,
  };
}

/** Fixed key order, so the form's copy and the server's compare equal. */
function fingerprint(settings: Settings): string {
  return JSON.stringify(toSettings(toDraft(settings)));
}

function Form({ data, reload }: { data: ProxySettings; reload: () => void }) {
  const [saved, setSaved] = useState(() => fingerprint(data.settings));
  const [draft, setDraft] = useState(() => toDraft(data.settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const settings = toSettings(draft);
  const dirty = settings === undefined || JSON.stringify(settings) !== saved;

  const change = (changes: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setMessage(undefined);
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError(undefined);
    api.saveProxySettings(settings).then(
      (result) => {
        setSaved(fingerprint(result.settings));
        setDraft(toDraft(result.settings));
        setMessage(t('settings.saved'));
        setBusy(false);
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
      },
    );
  };

  const clear = (userId: number) => {
    setBusy(true);
    setError(undefined);
    api.clearProxyVerdict(userId).then(
      () => {
        setMessage(t('proxy.cleared'));
        setBusy(false);
        reload();
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
      },
    );
  };

  return (
    <form className="card stack settings-form" onSubmit={submit} noValidate>
      <p className="notice notice--warn">{t('proxy.privacy')}</p>
      {!data.keyConfigured && <p className="notice">{t('proxy.noKey')}</p>}
      <ModuleBaseFields value={draft} groups={data.groups} onChange={change} />

      <label className="field field--narrow">
        <span>{t('proxy.action')}</span>
        <select
          value={draft.action}
          onChange={(event) => {
            change({ action: event.target.value as Settings['action'] });
          }}
        >
          <option value="none">{t('proxy.action.none')}</option>
          <option value="message">{t('nickname.action.message')}</option>
          <option value="poke">{t('nickname.action.poke')}</option>
          <option value="group">{t('proxy.action.group')}</option>
          <option value="kick">{t('nickname.action.kick')}</option>
          <option value="ban">{t('proxy.action.ban')}</option>
        </select>
      </label>
      {draft.action === 'group' && (
        <label className="field field--narrow">
          <span>{t('proxy.group')}</span>
          <select
            value={draft.groupId ?? ''}
            aria-invalid={draft.groupId === null}
            onChange={(event) => {
              change({ groupId: event.target.value === '' ? null : Number(event.target.value) });
            }}
          >
            <option value="">{t('support.noChannel')}</option>
            {data.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
            {draft.groupId !== null && !data.groups.some((g) => g.id === draft.groupId) && (
              <option value={draft.groupId}>
                {t('automation.unknownGroup', { id: draft.groupId })}
              </option>
            )}
          </select>
        </label>
      )}
      {draft.action === 'ban' && (
        <label className="field field--narrow">
          <span>{t('spam.banMinutes')}</span>
          <input
            type="number"
            min={1}
            max={BAN_MAX_MINUTES}
            value={draft.banMinutes}
            onChange={(event) => {
              change({ banMinutes: event.target.value });
            }}
          />
        </label>
      )}
      <label className="field">
        <span>{t('proxy.message')}</span>
        <input
          type="text"
          maxLength={1024}
          value={draft.message}
          aria-invalid={draft.message.trim() === ''}
          onChange={(event) => {
            change({ message: event.target.value });
          }}
        />
      </label>

      <fieldset className="settings-form__channels">
        <legend>{t('proxy.notify')}</legend>
        <p className="muted small">{t('proxy.notifyHint')}</p>
        {data.groups.length === 0 ? (
          <p className="muted">{t('automation.noGroups')}</p>
        ) : (
          <ul className="channel-list" aria-label={t('proxy.notify')}>
            {data.groups.map((group) => (
              <li key={group.id}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={draft.notifyGroupIds.includes(group.id)}
                    onChange={() => {
                      change({
                        notifyGroupIds: draft.notifyGroupIds.includes(group.id)
                          ? draft.notifyGroupIds.filter((id) => id !== group.id)
                          : [...draft.notifyGroupIds, group.id],
                      });
                    }}
                  />
                  {group.name}
                </label>
              </li>
            ))}
          </ul>
        )}
        <label className="field">
          <span>{t('proxy.notifyMessage')}</span>
          <input
            type="text"
            maxLength={1024}
            value={draft.notifyMessage}
            aria-invalid={draft.notifyMessage.trim() === ''}
            onChange={(event) => {
              change({ notifyMessage: event.target.value });
            }}
          />
        </label>
      </fieldset>

      <label className="field">
        <span>{t('proxy.exemptUsers')}</span>
        <input
          type="text"
          value={draft.exemptUsers}
          aria-invalid={parseIds(draft.exemptUsers) === undefined}
          onChange={(event) => {
            change({ exemptUsers: event.target.value });
          }}
        />
      </label>
      <p className="muted small">{t('proxy.exemptUsersHint')}</p>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="button" disabled={busy || !dirty || !settings}>
          {t('settings.save')}
        </button>
        {message && (
          <span className="state state--active" role="status">
            {message}
          </span>
        )}
      </div>

      <h2>{t('proxy.flagged')}</h2>
      <p className="muted small">
        {t('proxy.stats', {
          listed: formatNumber(data.stats.listed),
          clean: formatNumber(data.stats.clean),
          proxy: formatNumber(data.stats.proxy),
        })}
      </p>
      {data.flagged.length === 0 ? (
        <p className="muted">{t('proxy.noFlagged')}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('automation.col.player')}</th>
                <th scope="col">{t('proxy.col.when')}</th>
                <th scope="col">{t('proxy.col.undo')}</th>
              </tr>
            </thead>
            <tbody>
              {data.flagged.map((entry) => {
                const name = entry.nickname ?? t('automation.unknownPlayer');
                return (
                  <tr key={entry.userId}>
                    <th scope="row">
                      <Link to={`/spieler/${String(entry.userId)}`}>{name}</Link>
                    </th>
                    <td>{formatDateTime(entry.checkedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="button"
                        disabled={busy}
                        aria-label={t('proxy.clearFor', { name })}
                        onClick={() => {
                          clear(entry.userId);
                        }}
                      >
                        {t('proxy.clear')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">{t('proxy.clearHint')}</p>
    </form>
  );
}

/** Settings of the proxy check (T10.10), admins only. */
export function ProxyCheckPage() {
  const [version, setVersion] = useState(0);
  const { data, error } = useApi((signal) => api.proxySettings(signal), [version]);
  return (
    <section className="stack">
      <PageHeader title={t('automation.module.proxy')} intro={t('proxy.intro')} />
      <p>
        <Link to="/automatik">{t('automation.back')}</Link>
      </p>
      {error && <p className="alert">{error}</p>}
      {data && (
        <Form
          data={data}
          reload={() => {
            setVersion((v) => v + 1);
          }}
        />
      )}
    </section>
  );
}
