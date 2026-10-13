import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { RulesSettings } from '../api/types';
import { ModuleBaseFields } from '../components/ModuleBaseFields';
import { useApi } from '../hooks/useApi';
import { formatNumber, t, type MessageKey } from '../i18n';
import { PageHeader } from './pages';

type Settings = RulesSettings['settings'];
type TextKey =
  'acceptCommand' | 'declineCommand' | 'prompt' | 'acceptedMessage' | 'declinedMessage';
type ChannelKey = 'ruleChannelId' | 'acceptChannelId' | 'returnChannelId';

/** The rules are edited as one text, a blank line between two messages. */
interface Draft extends Omit<Settings, 'rules' | 'deadlineS' | 'english'> {
  rules: string;
  deadlineMinutes: string;
  english: Omit<Settings['english'], 'rules'> & { rules: string };
}

type EnglishKey = TextKey | 'kickReason';
const ENGLISH_TEXTS: readonly { key: EnglishKey; label: MessageKey; max: number }[] = [
  { key: 'acceptCommand', label: 'rules.acceptCommand', max: 40 },
  { key: 'declineCommand', label: 'rules.declineCommand', max: 40 },
  { key: 'prompt', label: 'rules.prompt', max: 1024 },
  { key: 'acceptedMessage', label: 'rules.acceptedMessage', max: 1024 },
  { key: 'declinedMessage', label: 'rules.declinedMessage', max: 1024 },
  { key: 'kickReason', label: 'rules.kickReason', max: 40 },
];

const RULE_MAX = 1024;
const RULES_MAX = 30;
const DEADLINE_MAX_MINUTES = 1440;

function toDraft(settings: Settings): Draft {
  const { deadlineS, rules, english, ...rest } = settings;
  return {
    ...rest,
    rules: rules.join('\n\n'),
    deadlineMinutes: String(Math.round(deadlineS / 60)),
    english: { ...english, rules: english.rules.join('\n\n') },
  };
}

function splitRules(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((rule) => rule.trim())
    .filter((rule) => rule !== '');
}

function toSettings(draft: Draft): Settings | undefined {
  const rules = splitRules(draft.rules);
  const minutes = /^\d+$/.test(draft.deadlineMinutes.trim()) ? Number(draft.deadlineMinutes) : -1;
  const texts: TextKey[] = [
    'acceptCommand',
    'declineCommand',
    'prompt',
    'acceptedMessage',
    'declinedMessage',
  ];
  const english = draft.english;
  const englishRules = splitRules(english.rules);
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  // A word that confirms in one language must not decline in the other.
  const clash =
    english.enabled &&
    (same(english.acceptCommand, english.declineCommand) ||
      same(english.acceptCommand, draft.declineCommand) ||
      same(english.declineCommand, draft.acceptCommand));
  const incomplete =
    draft.enabled &&
    ((english.enabled && englishRules.length === 0) ||
      rules.length === 0 ||
      (!draft.viaChat && !draft.viaChannel) ||
      (draft.viaChannel && draft.acceptChannelId === null) ||
      (draft.trigger === 'channel' && draft.ruleChannelId === null));
  if (
    incomplete ||
    minutes < 0 ||
    minutes > DEADLINE_MAX_MINUTES ||
    rules.length > RULES_MAX ||
    rules.some((rule) => rule.length > RULE_MAX) ||
    englishRules.length > RULES_MAX ||
    englishRules.some((rule) => rule.length > RULE_MAX) ||
    ENGLISH_TEXTS.some(({ key }) => english[key].trim() === '') ||
    clash ||
    texts.some((key) => draft[key].trim() === '') ||
    draft.kickReason.trim() === '' ||
    draft.acceptCommand.trim().toLowerCase() === draft.declineCommand.trim().toLowerCase()
  ) {
    return undefined;
  }
  return {
    enabled: draft.enabled,
    dryRun: draft.dryRun,
    exemptGroupIds: draft.exemptGroupIds,
    version: draft.version,
    rules,
    trigger: draft.trigger,
    ruleChannelId: draft.ruleChannelId,
    viaChat: draft.viaChat,
    acceptCommand: draft.acceptCommand.trim(),
    declineCommand: draft.declineCommand.trim(),
    viaChannel: draft.viaChannel,
    acceptChannelId: draft.acceptChannelId,
    returnChannelId: draft.returnChannelId,
    prompt: draft.prompt.trim(),
    acceptedMessage: draft.acceptedMessage.trim(),
    declinedMessage: draft.declinedMessage.trim(),
    acceptedGroupId: draft.acceptedGroupId,
    kickOnDecline: draft.kickOnDecline,
    deadlineS: minutes * 60,
    kickReason: draft.kickReason.trim(),
    english: {
      enabled: english.enabled,
      rules: englishRules,
      acceptCommand: english.acceptCommand.trim(),
      declineCommand: english.declineCommand.trim(),
      prompt: english.prompt.trim(),
      acceptedMessage: english.acceptedMessage.trim(),
      declinedMessage: english.declinedMessage.trim(),
      kickReason: english.kickReason.trim(),
    },
  };
}

/** Fixed key order, so the form's copy and the server's compare equal. */
function fingerprint(settings: Settings): string {
  return JSON.stringify(toSettings({ ...toDraft(settings), enabled: false }));
}

function Form({ data }: { data: RulesSettings }) {
  const [saved, setSaved] = useState(data.settings);
  const [draft, setDraft] = useState(() => toDraft(data.settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const settings = toSettings(draft);
  const dirty =
    settings === undefined ||
    settings.enabled !== saved.enabled ||
    fingerprint(settings) !== fingerprint(saved);
  const rules = splitRules(draft.rules);

  const change = (changes: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setMessage(undefined);
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError(undefined);
    api.saveRulesSettings(settings).then(
      (result) => {
        setSaved(result.settings);
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

  const channelSelect = (key: ChannelKey, label: MessageKey, empty: MessageKey) => (
    <label className="field field--narrow">
      <span>{t(label)}</span>
      <select
        value={draft[key] ?? ''}
        onChange={(event) => {
          change({ [key]: event.target.value === '' ? null : Number(event.target.value) });
        }}
      >
        <option value="">{t(empty)}</option>
        {data.channels.map((channel) => (
          <option key={channel.id} value={channel.id}>
            {channel.name}
          </option>
        ))}
      </select>
    </label>
  );

  const textField = (key: TextKey | 'kickReason', label: MessageKey, maxLength: number) => (
    <label className="field">
      <span>{t(label)}</span>
      <input
        type="text"
        maxLength={maxLength}
        value={draft[key]}
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

      <fieldset className="settings-form__channels">
        <legend>{t('rules.text')}</legend>
        <label className="field">
          <span>{t('rules.rules')}</span>
          <textarea
            rows={10}
            value={draft.rules}
            aria-invalid={rules.some((rule) => rule.length > RULE_MAX) || rules.length > RULES_MAX}
            onChange={(event) => {
              change({ rules: event.target.value });
            }}
          />
        </label>
        <p className="muted small">{t('rules.rulesHint', { count: rules.length })}</p>
        <p>
          {t('rules.version', { version: draft.version })}{' '}
          <span className="muted small">
            {t('rules.stats', {
              accepted: formatNumber(data.stats.accepted),
              declined: formatNumber(data.stats.declined),
            })}
          </span>
        </p>
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={draft.version !== saved.version}
            onClick={() => {
              change({ version: draft.version + 1 });
            }}
          >
            {t('rules.newVersion')}
          </button>
        </div>
        <p className="muted small">{t('rules.newVersionHint')}</p>
      </fieldset>

      <fieldset className="settings-form__channels">
        <legend>{t('rules.delivery')}</legend>
        <label className="field field--narrow">
          <span>{t('rules.trigger')}</span>
          <select
            value={draft.trigger}
            onChange={(event) => {
              change({ trigger: event.target.value as Settings['trigger'] });
            }}
          >
            <option value="join">{t('rules.trigger.join')}</option>
            <option value="channel">{t('rules.trigger.channel')}</option>
          </select>
        </label>
        {draft.trigger === 'channel' &&
          channelSelect('ruleChannelId', 'rules.ruleChannel', 'support.noChannel')}
      </fieldset>

      <fieldset className="settings-form__channels">
        <legend>{t('rules.confirm')}</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.viaChat}
            onChange={(event) => {
              change({ viaChat: event.target.checked });
            }}
          />
          {t('rules.viaChat')}
        </label>
        {draft.viaChat && (
          <>
            {textField('acceptCommand', 'rules.acceptCommand', 40)}
            {textField('declineCommand', 'rules.declineCommand', 40)}
            {textField('prompt', 'rules.prompt', 1024)}
            <p className="muted small">{t('rules.promptHint')}</p>
          </>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.viaChannel}
            onChange={(event) => {
              change({ viaChannel: event.target.checked });
            }}
          />
          {t('rules.viaChannel')}
        </label>
        {draft.viaChannel && (
          <>
            {channelSelect('acceptChannelId', 'rules.acceptChannel', 'support.noChannel')}
            {channelSelect('returnChannelId', 'rules.returnChannel', 'rules.returnBack')}
          </>
        )}
        {draft.enabled && !draft.viaChat && !draft.viaChannel && (
          <p className="alert">{t('rules.noWay')}</p>
        )}
      </fieldset>

      <fieldset className="settings-form__channels" aria-label={t('rules.english')}>
        <legend>{t('rules.english')}</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.english.enabled}
            onChange={(event) => {
              change({ english: { ...draft.english, enabled: event.target.checked } });
            }}
          />
          {t('rules.english.enabled')}
        </label>
        <p className="muted small">{t('rules.english.hint')}</p>
        {draft.english.enabled && (
          <>
            <label className="field">
              <span>{t('rules.rules')}</span>
              <textarea
                rows={10}
                lang="en"
                value={draft.english.rules}
                aria-invalid={splitRules(draft.english.rules).length === 0}
                onChange={(event) => {
                  change({ english: { ...draft.english, rules: event.target.value } });
                }}
              />
            </label>
            {ENGLISH_TEXTS.map(({ key, label, max }) => (
              <label className="field" key={key}>
                <span>{t(label)}</span>
                <input
                  type="text"
                  lang="en"
                  maxLength={max}
                  value={draft.english[key]}
                  aria-invalid={draft.english[key].trim() === ''}
                  onChange={(event) => {
                    change({ english: { ...draft.english, [key]: event.target.value } });
                  }}
                />
              </label>
            ))}
          </>
        )}
      </fieldset>

      <fieldset className="settings-form__channels">
        <legend>{t('rules.after')}</legend>
        {textField('acceptedMessage', 'rules.acceptedMessage', 1024)}
        {textField('declinedMessage', 'rules.declinedMessage', 1024)}
        <label className="field field--narrow">
          <span>{t('rules.group')}</span>
          <select
            value={draft.acceptedGroupId ?? ''}
            onChange={(event) => {
              change({
                acceptedGroupId: event.target.value === '' ? null : Number(event.target.value),
              });
            }}
          >
            <option value="">{t('private.noChannelGroup')}</option>
            {data.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
            {draft.acceptedGroupId !== null &&
              !data.groups.some((group) => group.id === draft.acceptedGroupId) && (
                <option value={draft.acceptedGroupId}>
                  {t('automation.unknownGroup', { id: draft.acceptedGroupId })}
                </option>
              )}
          </select>
        </label>
        <p className="muted small">{t('rules.groupHint')}</p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.kickOnDecline}
            onChange={(event) => {
              change({ kickOnDecline: event.target.checked });
            }}
          />
          {t('rules.kickOnDecline')}
        </label>
        <label className="field field--narrow">
          <span>{t('rules.deadline')}</span>
          <input
            type="number"
            min={0}
            max={DEADLINE_MAX_MINUTES}
            value={draft.deadlineMinutes}
            onChange={(event) => {
              change({ deadlineMinutes: event.target.value });
            }}
          />
        </label>
        <p className="muted small">{t('rules.deadlineHint')}</p>
        {textField('kickReason', 'rules.kickReason', 40)}
      </fieldset>

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

/** Settings of the rule confirmation (T10.8), admins only. */
export function RulesPage() {
  const { data, error } = useApi((signal) => api.rulesSettings(signal), []);
  return (
    <section className="stack">
      <PageHeader title={t('automation.module.rules')} intro={t('rules.intro')} />
      <p>
        <Link to="/automatik">{t('automation.back')}</Link>
      </p>
      {error && <p className="alert">{error}</p>}
      {data && <Form data={data} />}
    </section>
  );
}
