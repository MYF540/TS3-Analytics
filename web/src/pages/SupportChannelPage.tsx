import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { SupportSettings } from '../api/types';
import { EnglishTexts } from '../components/EnglishTexts';
import { ModuleBaseFields } from '../components/ModuleBaseFields';
import { useApi } from '../hooks/useApi';
import { t } from '../i18n';
import { PageHeader } from './pages';
import { englishIncomplete } from '../util/english';

type Settings = SupportSettings['settings'];

/** Number fields are edited as text so they can be empty while typing. */
interface Draft extends Omit<Settings, 'cooldownS' | 'autoOpen'> {
  cooldownS: string;
  autoOpen: Omit<Settings['autoOpen'], 'openMaxClients' | 'closedMaxClients'> & {
    openMaxClients: string;
    closedMaxClients: string;
  };
}

function toDraft(settings: Settings): Draft {
  return {
    ...settings,
    cooldownS: String(settings.cooldownS),
    autoOpen: {
      ...settings.autoOpen,
      openMaxClients: String(settings.autoOpen.openMaxClients),
      closedMaxClients: String(settings.autoOpen.closedMaxClients),
    },
  };
}

function parseNumber(value: string, min: number, max: number): number | undefined {
  if (!/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : undefined;
}

function toSettings(draft: Draft): Settings | undefined {
  const cooldownS = parseNumber(draft.cooldownS, 0, 3600);
  const openMaxClients = parseNumber(draft.autoOpen.openMaxClients, -1, 1000);
  const closedMaxClients = parseNumber(draft.autoOpen.closedMaxClients, -1, 1000);
  const texts = [draft.supporterMessage, draft.userMessage, draft.nobodyMessage];
  const names = [draft.autoOpen.openName.trim(), draft.autoOpen.closedName.trim()];
  if (
    cooldownS === undefined ||
    openMaxClients === undefined ||
    closedMaxClients === undefined ||
    texts.some((text) => text.trim() === '') ||
    englishIncomplete(draft.english.enabled, [
      draft.english.userMessage,
      draft.english.nobodyMessage,
    ]) ||
    names.some((name) => name === '') ||
    names[0] === names[1] ||
    (draft.enabled && (draft.channelId === null || draft.supporterGroupIds.length === 0))
  ) {
    return undefined;
  }
  return {
    ...draft,
    supporterMessage: draft.supporterMessage.trim(),
    userMessage: draft.userMessage.trim(),
    nobodyMessage: draft.nobodyMessage.trim(),
    english: {
      enabled: draft.english.enabled,
      userMessage: draft.english.userMessage.trim(),
      nobodyMessage: draft.english.nobodyMessage.trim(),
    },
    cooldownS,
    autoOpen: {
      enabled: draft.autoOpen.enabled,
      openName: draft.autoOpen.openName.trim(),
      closedName: draft.autoOpen.closedName.trim(),
      openMaxClients,
      closedMaxClients,
    },
  };
}

function Form({ data }: { data: SupportSettings }) {
  const [saved, setSaved] = useState(() => JSON.stringify(data.settings));
  const [draft, setDraft] = useState(() => toDraft(data.settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const settings = toSettings(draft);
  const dirty = settings === undefined || JSON.stringify(settings) !== saved;
  const incomplete =
    draft.enabled && (draft.channelId === null || draft.supporterGroupIds.length === 0);

  const change = (changes: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setMessage(undefined);
  };
  const changeAuto = (changes: Partial<Draft['autoOpen']>) => {
    change({ autoOpen: { ...draft.autoOpen, ...changes } });
  };

  const toggleSupporter = (id: number) => {
    change({
      supporterGroupIds: draft.supporterGroupIds.includes(id)
        ? draft.supporterGroupIds.filter((group) => group !== id)
        : [...draft.supporterGroupIds, id],
    });
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError(undefined);
    api.saveSupportSettings(settings).then(
      (result) => {
        setSaved(JSON.stringify(result.settings));
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

  const text = (
    key: 'supporterMessage' | 'userMessage' | 'nobodyMessage',
    label: string,
    maxLength: number,
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        value={draft[key]}
        maxLength={maxLength}
        aria-invalid={draft[key].trim() === ''}
        onChange={(event) => {
          change({ [key]: event.target.value });
        }}
      />
    </label>
  );

  return (
    <form className="card stack settings-form" onSubmit={submit} noValidate>
      <ModuleBaseFields value={draft} groups={data.groups} onChange={change} />

      <label className="field field--narrow">
        <span>{t('support.channel')}</span>
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

      <fieldset className="settings-form__channels">
        <legend>
          {t('support.team')}{' '}
          <span className="muted small">
            {t('settings.network.selected', { count: draft.supporterGroupIds.length })}
          </span>
        </legend>
        <p className="muted small">{t('support.teamHint')}</p>
        {data.groups.length === 0 ? (
          <p className="muted">{t('automation.noGroups')}</p>
        ) : (
          <ul className="channel-list" aria-label={t('support.team')}>
            {data.groups.map((group) => (
              <li key={group.id}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={draft.supporterGroupIds.includes(group.id)}
                    onChange={() => {
                      toggleSupporter(group.id);
                    }}
                  />
                  {group.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {incomplete && <p className="alert">{t('error.SUPPORT_INCOMPLETE')}</p>}

      <label className="field field--narrow">
        <span>{t('support.notify')}</span>
        <select
          value={draft.notify}
          onChange={(event) => {
            change({ notify: event.target.value as Settings['notify'] });
          }}
        >
          <option value="poke">{t('support.notify.poke')}</option>
          <option value="message">{t('support.notify.message')}</option>
        </select>
      </label>
      {text('supporterMessage', t('support.supporterMessage'), 100)}
      {text('userMessage', t('support.userMessage'), 1024)}
      {text('nobodyMessage', t('support.nobodyMessage'), 1024)}
      <p className="muted small">{t('support.placeholder')}</p>
      <EnglishTexts
        enabled={draft.english.enabled}
        onToggle={(enabled) => {
          change({ english: { ...draft.english, enabled } });
        }}
        fields={(['userMessage', 'nobodyMessage'] as const).map((key) => ({
          id: key,
          label: t(`support.${key}`),
          value: draft.english[key],
          max: 1024,
          onChange: (value: string) => {
            change({ english: { ...draft.english, [key]: value } });
          },
        }))}
      />

      <label className="field field--narrow">
        <span>{t('support.cooldown')}</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={3600}
          value={draft.cooldownS}
          aria-invalid={parseNumber(draft.cooldownS, 0, 3600) === undefined}
          onChange={(event) => {
            change({ cooldownS: event.target.value });
          }}
        />
      </label>

      <fieldset className="settings-form__channels">
        <legend>{t('support.auto')}</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.autoOpen.enabled}
            onChange={(event) => {
              changeAuto({ enabled: event.target.checked });
            }}
          />
          {t('support.auto.enabled')}
        </label>
        <p className="muted small">{t('support.auto.hint')}</p>
        <label className="field field--narrow">
          <span>{t('support.auto.openName')}</span>
          <input
            type="text"
            maxLength={40}
            value={draft.autoOpen.openName}
            onChange={(event) => {
              changeAuto({ openName: event.target.value });
            }}
          />
        </label>
        <label className="field field--narrow">
          <span>{t('support.auto.closedName')}</span>
          <input
            type="text"
            maxLength={40}
            value={draft.autoOpen.closedName}
            aria-invalid={draft.autoOpen.openName.trim() === draft.autoOpen.closedName.trim()}
            onChange={(event) => {
              changeAuto({ closedName: event.target.value });
            }}
          />
        </label>
        <label className="field field--narrow">
          <span>{t('support.auto.openMax')}</span>
          <input
            type="number"
            min={-1}
            max={1000}
            value={draft.autoOpen.openMaxClients}
            onChange={(event) => {
              changeAuto({ openMaxClients: event.target.value });
            }}
          />
        </label>
        <label className="field field--narrow">
          <span>{t('support.auto.closedMax')}</span>
          <input
            type="number"
            min={-1}
            max={1000}
            value={draft.autoOpen.closedMaxClients}
            onChange={(event) => {
              changeAuto({ closedMaxClients: event.target.value });
            }}
          />
        </label>
        <p className="muted small">{t('support.auto.maxHint')}</p>
      </fieldset>

      <p className="muted small">{t('support.discord')}</p>

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
    </form>
  );
}

/** Settings of the support channel (T10.4), admins only. */
export function SupportChannelPage() {
  const { data, error } = useApi((signal) => api.supportSettings(signal), []);
  return (
    <section className="stack">
      <PageHeader title={t('automation.module.support')} intro={t('support.intro')} />
      <p>
        <Link to="/automatik">{t('automation.back')}</Link>
      </p>
      {error && <p className="alert">{error}</p>}
      {data && <Form data={data} />}
    </section>
  );
}
