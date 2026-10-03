import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { SpamCategory, SpamSettings } from '../api/types';
import { ModuleBaseFields } from '../components/ModuleBaseFields';
import { useApi } from '../hooks/useApi';
import { t, type MessageKey } from '../i18n';
import { PageHeader } from './pages';

type Settings = SpamSettings['settings'];
type Rules = Settings[SpamCategory];
type NumberKey = 'windowS' | 'warnAt' | 'kickAt' | 'banAt';

const KINDS: readonly SpamCategory[] = [
  'channelSwitch',
  'channelCreate',
  'nickname',
  'reconnect',
  'lobby',
];

const NUMBERS: readonly { key: NumberKey; label: MessageKey; min: number; max: number }[] = [
  { key: 'windowS', label: 'spam.window', min: 5, max: 3600 },
  { key: 'warnAt', label: 'spam.warnAt', min: 0, max: 1000 },
  { key: 'kickAt', label: 'spam.kickAt', min: 0, max: 1000 },
  { key: 'banAt', label: 'spam.banAt', min: 0, max: 1000 },
];

const BAN_MAX_MINUTES = 30 * 1440;

/** Numbers are edited as text so a field can be empty while typing. */
interface RulesDraft extends Omit<Rules, NumberKey | 'banDurationS'> {
  numbers: Record<NumberKey, string>;
  banMinutes: string;
}

type Draft = Pick<Settings, 'enabled' | 'dryRun' | 'exemptGroupIds'> &
  Record<SpamCategory, RulesDraft>;

function rulesDraft(rules: Rules): RulesDraft {
  return {
    enabled: rules.enabled,
    warnBy: rules.warnBy,
    warnMessage: rules.warnMessage,
    reason: rules.reason,
    numbers: {
      windowS: String(rules.windowS),
      warnAt: String(rules.warnAt),
      kickAt: String(rules.kickAt),
      banAt: String(rules.banAt),
    },
    banMinutes: String(Math.round(rules.banDurationS / 60)),
  };
}

function toDraft(settings: Settings): Draft {
  return {
    enabled: settings.enabled,
    dryRun: settings.dryRun,
    exemptGroupIds: settings.exemptGroupIds,
    channelSwitch: rulesDraft(settings.channelSwitch),
    channelCreate: rulesDraft(settings.channelCreate),
    nickname: rulesDraft(settings.nickname),
    reconnect: rulesDraft(settings.reconnect),
    lobby: rulesDraft(settings.lobby),
  };
}

function parseNumber(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : undefined;
}

/** Why the thresholds of a kind cannot be used, if so. */
function stepProblem(rules: Rules): MessageKey | undefined {
  const active = [rules.warnAt, rules.kickAt, rules.banAt].filter((value) => value > 0);
  if (rules.enabled && active.length === 0) return 'spam.noStep';
  const rising = active.every((value, index) => index === 0 || value > (active[index - 1] ?? 0));
  return rising ? undefined : 'spam.notRising';
}

function toRules(draft: RulesDraft): Rules | undefined {
  const numbers = {} as Record<NumberKey, number>;
  for (const { key, min, max } of NUMBERS) {
    const value = parseNumber(draft.numbers[key], min, max);
    if (value === undefined) return undefined;
    numbers[key] = value;
  }
  const banMinutes = parseNumber(draft.banMinutes, 1, BAN_MAX_MINUTES);
  if (banMinutes === undefined || draft.warnMessage.trim() === '' || draft.reason.trim() === '') {
    return undefined;
  }
  return {
    enabled: draft.enabled,
    windowS: numbers.windowS,
    warnAt: numbers.warnAt,
    kickAt: numbers.kickAt,
    banAt: numbers.banAt,
    banDurationS: banMinutes * 60,
    warnBy: draft.warnBy,
    warnMessage: draft.warnMessage.trim(),
    reason: draft.reason.trim(),
  };
}

function toSettings(draft: Draft): Settings | undefined {
  const parsed = {} as Record<SpamCategory, Rules>;
  for (const kind of KINDS) {
    const rules = toRules(draft[kind]);
    if (rules === undefined || stepProblem(rules) !== undefined) return undefined;
    parsed[kind] = rules;
  }
  return {
    enabled: draft.enabled,
    dryRun: draft.dryRun,
    exemptGroupIds: draft.exemptGroupIds,
    channelSwitch: parsed.channelSwitch,
    channelCreate: parsed.channelCreate,
    nickname: parsed.nickname,
    reconnect: parsed.reconnect,
    lobby: parsed.lobby,
  };
}

/** Fixed key order, so the form's copy and the server's compare equal. */
function fingerprint(settings: Settings): string {
  return JSON.stringify(toSettings(toDraft(settings)));
}

function Form({ data }: { data: SpamSettings }) {
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
  const changeKind = (kind: SpamCategory, changes: Partial<RulesDraft>) => {
    change({ [kind]: { ...draft[kind], ...changes } });
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError(undefined);
    api.saveSpamSettings(settings).then(
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

  return (
    <form className="card stack settings-form" onSubmit={submit} noValidate>
      <ModuleBaseFields value={draft} groups={data.groups} onChange={change} />
      <p className="muted small">{t('spam.stepsHint')}</p>

      {KINDS.map((kind) => {
        const rules = draft[kind];
        const title = t(`spam.kind.${kind}`);
        const parsed = toRules(rules);
        const problem = parsed ? stepProblem(parsed) : undefined;
        return (
          <fieldset key={kind} className="settings-form__channels" aria-label={title}>
            <legend>{title}</legend>
            <p className="muted small">{t(`spam.about.${kind}`)}</p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={rules.enabled}
                onChange={(event) => {
                  changeKind(kind, { enabled: event.target.checked });
                }}
              />
              {t('spam.watch')}
            </label>
            {NUMBERS.map(({ key, label, min, max }) => (
              <label className="field field--narrow" key={key}>
                <span>{t(label)}</span>
                <input
                  type="number"
                  min={min}
                  max={max}
                  value={rules.numbers[key]}
                  aria-invalid={parseNumber(rules.numbers[key], min, max) === undefined}
                  onChange={(event) => {
                    changeKind(kind, { numbers: { ...rules.numbers, [key]: event.target.value } });
                  }}
                />
              </label>
            ))}
            {problem && <p className="alert">{t(problem)}</p>}
            <label className="field field--narrow">
              <span>{t('spam.banMinutes')}</span>
              <input
                type="number"
                min={1}
                max={BAN_MAX_MINUTES}
                value={rules.banMinutes}
                aria-invalid={parseNumber(rules.banMinutes, 1, BAN_MAX_MINUTES) === undefined}
                onChange={(event) => {
                  changeKind(kind, { banMinutes: event.target.value });
                }}
              />
            </label>
            <label className="field field--narrow">
              <span>{t('spam.warnBy')}</span>
              <select
                value={rules.warnBy}
                onChange={(event) => {
                  changeKind(kind, { warnBy: event.target.value as Rules['warnBy'] });
                }}
              >
                <option value="poke">{t('support.notify.poke')}</option>
                <option value="message">{t('support.notify.message')}</option>
              </select>
            </label>
            <label className="field">
              <span>{t('spam.warnMessage')}</span>
              <input
                type="text"
                maxLength={100}
                value={rules.warnMessage}
                aria-invalid={rules.warnMessage.trim() === ''}
                onChange={(event) => {
                  changeKind(kind, { warnMessage: event.target.value });
                }}
              />
            </label>
            <label className="field">
              <span>{t('spam.reason')}</span>
              <input
                type="text"
                maxLength={80}
                value={rules.reason}
                aria-invalid={rules.reason.trim() === ''}
                onChange={(event) => {
                  changeKind(kind, { reason: event.target.value });
                }}
              />
            </label>
          </fieldset>
        );
      })}

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

/** Settings of the spam control (T10.9), admins only. */
export function SpamControlPage() {
  const { data, error } = useApi((signal) => api.spamSettings(signal), []);
  return (
    <section className="stack">
      <PageHeader title={t('automation.module.spam')} intro={t('spam.intro')} />
      <p>
        <Link to="/automatik">{t('automation.back')}</Link>
      </p>
      {error && <p className="alert">{error}</p>}
      {data && <Form data={data} />}
    </section>
  );
}
