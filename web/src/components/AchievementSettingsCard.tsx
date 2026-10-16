import { useState, type SubmitEvent } from 'react';
import { api, describeError } from '../api/client';
import type { AchievementSettings } from '../api/types';
import { useApi } from '../hooks/useApi';
import { achievementText, formatDateTime, formatNumber, t } from '../i18n';

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function Form({ data, reload }: { data: AchievementSettings; reload: () => void }) {
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set(data.disabled));
  const [disabled, setDisabled] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const dirty = !sameSet(disabled, saved);

  const toggle = (id: string) => {
    const next = new Set(disabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDisabled(next);
    setMessage(undefined);
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    api.saveAchievementSettings([...disabled]).then(
      (result) => {
        const next = new Set(result.disabled);
        setSaved(next);
        setDisabled(next);
        setMessage(t('settings.saved'));
        setBusy(false);
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
      },
    );
  };

  const runNow = () => {
    setBusy(true);
    setError(undefined);
    api.runAchievementJob().then(
      () => {
        setMessage(t('settings.achievements.done'));
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
      <h2>{t('settings.achievements.title')}</h2>
      <p className="muted small">{t('settings.achievements.intro')}</p>
      <ul className="channel-list">
        {data.catalog.map((a) => (
          <li key={a.id}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!disabled.has(a.id)}
                onChange={() => {
                  toggle(a.id);
                }}
              />
              {achievementText('name', a.id)}
              {a.secret && <span className="muted small">{t('achievement.group.secret')}</span>}
            </label>
          </li>
        ))}
      </ul>
      <p className="muted small">
        {data.state
          ? t('settings.achievements.lastRun', {
              time: formatDateTime(data.state.lastRun),
              checked: formatNumber(data.state.checked),
              awarded: formatNumber(data.state.awarded),
            })
          : t('settings.achievements.never')}
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="button" disabled={busy || !dirty}>
          {t('settings.save')}
        </button>
        <button type="button" className="button" disabled={busy || dirty} onClick={runNow}>
          {t('settings.achievements.run')}
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

/** Switches per achievement and the manual run (T13.4), admins only. */
export function AchievementSettingsCard() {
  const [version, setVersion] = useState(0);
  const { data, error } = useApi((signal) => api.achievementSettings(signal), [version]);
  if (error) return <p className="alert">{error}</p>;
  if (!data) return null;
  return (
    <Form
      key={data.state?.lastRun ?? 0}
      data={data}
      reload={() => {
        setVersion((v) => v + 1);
      }}
    />
  );
}
