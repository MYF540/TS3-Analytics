import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { StaffSettings } from '../api/types';
import { ModuleBaseFields } from '../components/ModuleBaseFields';
import { useApi } from '../hooks/useApi';
import { t, type MessageKey } from '../i18n';
import { PageHeader } from './pages';

type Settings = StaffSettings['settings'];
type TextKey = 'groupLine' | 'memberLine' | 'online' | 'away' | 'offline' | 'empty';
type FlagKey = 'showInAll' | 'awayInAfkChannel' | 'hideEmptyGroups' | 'clickable';

const TEXTS: readonly { key: TextKey; label: MessageKey; max: number }[] = [
  { key: 'groupLine', label: 'staff.groupLine', max: 200 },
  { key: 'memberLine', label: 'staff.memberLine', max: 200 },
  { key: 'online', label: 'staff.online', max: 100 },
  { key: 'away', label: 'staff.away', max: 100 },
  { key: 'offline', label: 'staff.offline', max: 100 },
  { key: 'empty', label: 'staff.empty', max: 200 },
];

const FLAGS: readonly { key: FlagKey; label: MessageKey }[] = [
  { key: 'clickable', label: 'staff.clickable' },
  { key: 'awayInAfkChannel', label: 'staff.awayInAfk' },
  { key: 'showInAll', label: 'staff.showInAll' },
  { key: 'hideEmptyGroups', label: 'staff.hideEmpty' },
];

const GROUPS_MAX = 20;

function Form({ data }: { data: StaffSettings }) {
  const [saved, setSaved] = useState(() => JSON.stringify(data.settings));
  const [draft, setDraft] = useState(data.settings);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const dirty = JSON.stringify(draft) !== saved;
  const incomplete = draft.enabled && (draft.channelId === null || draft.groups.length === 0);
  const groupName = (id: number) =>
    data.groups.find((group) => group.id === id)?.name ?? t('automation.unknownGroup', { id });
  const free = data.groups.filter(
    (group) => !draft.groups.some((entry) => entry.groupId === group.id),
  );

  const change = (changes: Partial<Settings>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setMessage(undefined);
  };

  const moveGroup = (index: number, by: -1 | 1) => {
    const next = [...draft.groups];
    const [entry] = next.splice(index, 1);
    if (entry) next.splice(index + by, 0, entry);
    change({ groups: next });
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (incomplete) return;
    setBusy(true);
    setError(undefined);
    api.saveStaffSettings(draft).then(
      (result) => {
        setSaved(JSON.stringify(result.settings));
        setDraft(result.settings);
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
    <form className="card stack settings-form" onSubmit={submit} noValidate>
      <ModuleBaseFields value={draft} groups={data.groups} onChange={change} hideExempt />

      <label className="field field--narrow">
        <span>{t('staff.channel')}</span>
        <select
          value={draft.channelId ?? ''}
          onChange={(event) => {
            change({ channelId: event.target.value === '' ? null : Number(event.target.value) });
          }}
        >
          <option value="">{t('support.noChannel')}</option>
          {data.channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">{t('staff.channelHint')}</p>

      <fieldset className="settings-form__channels">
        <legend>{t('staff.groups')}</legend>
        <p className="muted small">{t('staff.groupsHint')}</p>
        {draft.groups.length === 0 && <p className="muted">{t('staff.noGroups')}</p>}
        <ol className="pattern-list" aria-label={t('staff.groups')}>
          {draft.groups.map((entry, index) => {
            const name = groupName(entry.groupId);
            return (
              <li key={entry.groupId} className="pattern-list__row">
                <strong className="pattern-list__name">{name}</strong>
                <label className="field">
                  <span>{t('staff.title', { group: name })}</span>
                  <input
                    type="text"
                    maxLength={200}
                    value={entry.title}
                    onChange={(event) => {
                      change({
                        groups: draft.groups.map((other) =>
                          other.groupId === entry.groupId
                            ? { ...other, title: event.target.value }
                            : other,
                        ),
                      });
                    }}
                  />
                </label>
                <span className="button-row">
                  <button
                    type="button"
                    className="button"
                    disabled={index === 0}
                    aria-label={t('staff.up', { group: name })}
                    onClick={() => {
                      moveGroup(index, -1);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={index === draft.groups.length - 1}
                    aria-label={t('staff.down', { group: name })}
                    onClick={() => {
                      moveGroup(index, 1);
                    }}
                  >
                    ↓
                  </button>
                </span>
                <button
                  type="button"
                  className="button"
                  aria-label={t('staff.remove', { group: name })}
                  onClick={() => {
                    change({
                      groups: draft.groups.filter((other) => other.groupId !== entry.groupId),
                    });
                  }}
                >
                  {t('nickname.removeShort')}
                </button>
              </li>
            );
          })}
        </ol>
        <div className="button-row button-row--end">
          <label className="field field--narrow">
            <span>{t('staff.add')}</span>
            <select
              value={adding}
              onChange={(event) => {
                setAdding(event.target.value);
              }}
            >
              <option value="">{t('support.noChannel')}</option>
              {free.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button"
            disabled={adding === '' || draft.groups.length >= GROUPS_MAX}
            onClick={() => {
              change({ groups: [...draft.groups, { groupId: Number(adding), title: '' }] });
              setAdding('');
            }}
          >
            {t('staff.addButton')}
          </button>
        </div>
      </fieldset>
      {incomplete && <p className="alert">{t('error.STAFF_INCOMPLETE')}</p>}

      {FLAGS.map(({ key, label }) => (
        <label className="checkbox" key={key}>
          <input
            type="checkbox"
            checked={draft[key]}
            onChange={(event) => {
              change({ [key]: event.target.checked });
            }}
          />
          {t(label)}
        </label>
      ))}

      <fieldset className="settings-form__channels">
        <legend>{t('staff.texts')}</legend>
        <p className="muted small">{t('staff.textsHint')}</p>
        <label className="field">
          <span>{t('staff.header')}</span>
          <textarea
            rows={3}
            maxLength={2000}
            value={draft.header}
            onChange={(event) => {
              change({ header: event.target.value });
            }}
          />
        </label>
        {TEXTS.map(({ key, label, max }) => (
          <label className="field" key={key}>
            <span>{t(label)}</span>
            <input
              type="text"
              maxLength={max}
              value={draft[key]}
              onChange={(event) => {
                change({ [key]: event.target.value });
              }}
            />
          </label>
        ))}
        <label className="field">
          <span>{t('staff.footer')}</span>
          <textarea
            rows={3}
            maxLength={2000}
            value={draft.footer}
            onChange={(event) => {
              change({ footer: event.target.value });
            }}
          />
        </label>
      </fieldset>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="button" disabled={busy || !dirty || incomplete}>
          {t('settings.save')}
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

/** Settings of the staff list (T10.5), admins only. */
export function StaffListPage() {
  const { data, error } = useApi((signal) => api.staffSettings(signal), []);
  return (
    <section className="stack">
      <PageHeader title={t('automation.module.staff')} intro={t('staff.intro')} />
      <p>
        <Link to="/automatik">{t('automation.back')}</Link>
      </p>
      {error && <p className="alert">{error}</p>}
      {data && <Form data={data} />}
    </section>
  );
}
