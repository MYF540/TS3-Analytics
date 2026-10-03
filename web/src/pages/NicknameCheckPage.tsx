import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { NicknameSettings } from '../api/types';
import { ModuleBaseFields } from '../components/ModuleBaseFields';
import { useApi } from '../hooks/useApi';
import { t } from '../i18n';
import { PageHeader } from './pages';

type Settings = NicknameSettings['settings'];

interface PatternDraft {
  /** Stable key for React; patterns have no id of their own. */
  key: number;
  pattern: string;
  regex: boolean;
  message: string;
}

interface Draft extends Omit<Settings, 'patterns'> {
  patterns: PatternDraft[];
}

const KICK_REASON_MAX = 40;
const MESSAGE_MAX = 100;
const PATTERNS_MAX = 100;

let nextKey = 1;

function toDraft(settings: Settings): Draft {
  return {
    ...settings,
    patterns: settings.patterns.map((entry) => ({
      key: nextKey++,
      pattern: entry.pattern,
      regex: entry.regex,
      message: entry.message ?? '',
    })),
  };
}

function toSettings(draft: Draft): Settings {
  return {
    ...draft,
    message: draft.message.trim(),
    patterns: draft.patterns.map(({ pattern, regex, message }) => ({
      pattern,
      regex,
      ...(message.trim() === '' ? {} : { message: message.trim() }),
    })),
  };
}

/** Client-side check of a regular expression; the server decides in the end. */
function isBrokenRegex(entry: PatternDraft): boolean {
  if (!entry.regex) return false;
  try {
    new RegExp(entry.pattern, 'iu');
    return false;
  } catch {
    return true;
  }
}

function Form({ data }: { data: NicknameSettings }) {
  const [saved, setSaved] = useState(() => JSON.stringify(data.settings));
  const [draft, setDraft] = useState(() => toDraft(data.settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [probe, setProbe] = useState('');
  const [verdict, setVerdict] = useState<string>();

  const settings = toSettings(draft);
  const dirty = JSON.stringify(settings) !== saved;
  const valid =
    settings.message !== '' &&
    draft.patterns.every((entry) => entry.pattern.trim() !== '' && !isBrokenRegex(entry));

  const change = (changes: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setMessage(undefined);
    setVerdict(undefined);
  };

  const changePattern = (key: number, changes: Partial<PatternDraft>) => {
    change({
      patterns: draft.patterns.map((entry) =>
        entry.key === key ? { ...entry, ...changes } : entry,
      ),
    });
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    api.saveNicknameSettings(settings).then(
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

  const test = () => {
    setError(undefined);
    api
      .testNickname({
        nickname: probe,
        patterns: settings.patterns,
        lookalikes: settings.lookalikes,
      })
      .then(
        ({ match }) => {
          setVerdict(
            match === null
              ? t('nickname.test.ok')
              : t('nickname.test.hit', { pattern: settings.patterns[match]?.pattern ?? '' }),
          );
        },
        (e: unknown) => {
          setError(describeError(e));
        },
      );
  };

  return (
    <form className="card stack settings-form" onSubmit={submit} noValidate>
      <ModuleBaseFields value={draft} groups={data.groups} onChange={change} />

      <fieldset className="settings-form__channels">
        <legend>{t('nickname.patterns')}</legend>
        <p className="muted small">{t('nickname.patternsHint')}</p>
        {draft.patterns.length === 0 && <p className="muted">{t('nickname.noPatterns')}</p>}
        <ul className="pattern-list">
          {draft.patterns.map((entry, index) => (
            <li key={entry.key} className="pattern-list__row">
              <label className="field">
                <span>{t('nickname.pattern', { number: index + 1 })}</span>
                <input
                  type="text"
                  value={entry.pattern}
                  maxLength={200}
                  aria-invalid={entry.pattern.trim() === '' || isBrokenRegex(entry)}
                  onChange={(event) => {
                    changePattern(entry.key, { pattern: event.target.value });
                  }}
                />
              </label>
              <label className="field">
                <span>{t('nickname.ownMessage')}</span>
                <input
                  type="text"
                  value={entry.message}
                  maxLength={MESSAGE_MAX}
                  onChange={(event) => {
                    changePattern(entry.key, { message: event.target.value });
                  }}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={entry.regex}
                  onChange={(event) => {
                    changePattern(entry.key, { regex: event.target.checked });
                  }}
                />
                {t('nickname.regex')}
              </label>
              <button
                type="button"
                className="button"
                aria-label={t('nickname.remove', { number: index + 1 })}
                onClick={() => {
                  change({ patterns: draft.patterns.filter((other) => other.key !== entry.key) });
                }}
              >
                {t('nickname.removeShort')}
              </button>
              {isBrokenRegex(entry) && (
                <p className="alert pattern-list__problem">{t('nickname.brokenRegex')}</p>
              )}
            </li>
          ))}
        </ul>
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={draft.patterns.length >= PATTERNS_MAX}
            onClick={() => {
              change({
                patterns: [
                  ...draft.patterns,
                  { key: nextKey++, pattern: '', regex: false, message: '' },
                ],
              });
            }}
          >
            {t('nickname.add')}
          </button>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.lookalikes}
            onChange={(event) => {
              change({ lookalikes: event.target.checked });
            }}
          />
          {t('nickname.lookalikes')}
        </label>
        <p className="muted small">{t('nickname.lookalikesHint')}</p>
      </fieldset>

      <label className="field field--narrow">
        <span>{t('nickname.action')}</span>
        <select
          value={draft.action}
          onChange={(event) => {
            change({ action: event.target.value as Settings['action'] });
          }}
        >
          <option value="message">{t('nickname.action.message')}</option>
          <option value="poke">{t('nickname.action.poke')}</option>
          <option value="kick">{t('nickname.action.kick')}</option>
        </select>
      </label>
      <label className="field">
        <span>{t('nickname.message')}</span>
        <input
          type="text"
          value={draft.message}
          maxLength={MESSAGE_MAX}
          aria-invalid={settings.message === ''}
          onChange={(event) => {
            change({ message: event.target.value });
          }}
        />
      </label>
      {draft.action === 'kick' && settings.message.length > KICK_REASON_MAX && (
        <p className="muted small">
          {t('nickname.kickCut', { text: settings.message.slice(0, KICK_REASON_MAX) })}
        </p>
      )}

      <fieldset className="settings-form__channels">
        <legend>{t('nickname.test')}</legend>
        <p className="muted small">{t('nickname.testHint')}</p>
        <div className="button-row button-row--end">
          <label className="field field--narrow">
            <span>{t('nickname.test.label')}</span>
            <input
              type="text"
              value={probe}
              maxLength={100}
              onChange={(event) => {
                setProbe(event.target.value);
                setVerdict(undefined);
              }}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={probe.trim() === '' || !valid}
            onClick={test}
          >
            {t('nickname.test.run')}
          </button>
        </div>
        {verdict && <p role="status">{verdict}</p>}
      </fieldset>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="button" disabled={busy || !dirty || !valid}>
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

/** Settings of the nickname checker (T10.3), admins only. */
export function NicknameCheckPage() {
  const { data, error } = useApi((signal) => api.nicknameSettings(signal), []);
  return (
    <section className="stack">
      <PageHeader title={t('automation.module.nickname')} intro={t('nickname.intro')} />
      <p>
        <Link to="/automatik">{t('automation.back')}</Link>
      </p>
      {error && <p className="alert">{error}</p>}
      {data && <Form data={data} />}
    </section>
  );
}
