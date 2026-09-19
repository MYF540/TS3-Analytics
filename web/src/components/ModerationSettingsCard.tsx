import { useState, type SubmitEvent } from 'react';
import { api, describeError } from '../api/client';
import type { BanTemplate, ModerationSettings } from '../api/types';
import { useApi } from '../hooks/useApi';
import { t } from '../i18n';
import { DURATIONS, durationLabel } from '../util/moderation';

/** A new, unused id like `vorlage-3`. */
function nextId(templates: readonly BanTemplate[]): string {
  let n = templates.length + 1;
  while (templates.some((tpl) => tpl.id === `vorlage-${String(n)}`)) n++;
  return `vorlage-${String(n)}`;
}

function SettingsForm({ initial }: { initial: ModerationSettings }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [templates, setTemplates] = useState(initial.banTemplates);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const valid = templates.every((tpl) => tpl.label.trim() && tpl.reason.trim());

  const update = (index: number, changes: Partial<BanTemplate>) => {
    setTemplates((list) => list.map((tpl, i) => (i === index ? { ...tpl, ...changes } : tpl)));
    setMessage(undefined);
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    api
      .saveModerationSettings({
        enabled,
        banTemplates: templates.map((tpl) => ({
          ...tpl,
          label: tpl.label.trim(),
          reason: tpl.reason.trim(),
        })),
      })
      .then(
        (result) => {
          setEnabled(result.enabled);
          setTemplates(result.banTemplates);
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
      <h2>{t('mod.settings.title')}</h2>
      <p className="muted small">{t('mod.settings.intro')}</p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            setMessage(undefined);
          }}
        />
        {t('mod.settings.enabled')}
      </label>
      <p className="muted small">{t('mod.settings.enabledHint')}</p>

      <fieldset className="settings-form__channels">
        <legend>{t('mod.settings.templates')}</legend>
        <ul className="templates">
          {templates.map((tpl, index) => {
            const durations: number[] = (DURATIONS as readonly number[]).includes(tpl.durationS)
              ? [...DURATIONS]
              : [...DURATIONS, tpl.durationS];
            return (
              <li key={tpl.id} className="field-row">
                <label className="field">
                  <span>{t('mod.settings.label')}</span>
                  <input
                    maxLength={60}
                    value={tpl.label}
                    onChange={(event) => {
                      update(index, { label: event.target.value });
                    }}
                  />
                </label>
                <label className="field">
                  <span>{t('mod.reason')}</span>
                  <input
                    maxLength={200}
                    value={tpl.reason}
                    onChange={(event) => {
                      update(index, { reason: event.target.value });
                    }}
                  />
                </label>
                <label className="field field--narrow">
                  <span>{t('mod.duration')}</span>
                  <select
                    value={tpl.durationS}
                    onChange={(event) => {
                      update(index, { durationS: Number(event.target.value) });
                    }}
                  >
                    {durations.map((d) => (
                      <option key={d} value={d}>
                        {(DURATIONS as readonly number[]).includes(d)
                          ? durationLabel(d)
                          : t('mod.duration.custom', { value: durationLabel(d) })}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="icon-button templates__remove"
                  aria-label={t('mod.settings.remove', { name: tpl.label })}
                  title={t('mod.settings.remove', { name: tpl.label })}
                  onClick={() => {
                    setTemplates((list) => list.filter((_, i) => i !== index));
                    setMessage(undefined);
                  }}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
        <div>
          <button
            type="button"
            className="button button--small"
            disabled={templates.length >= 20}
            onClick={() => {
              setTemplates((list) => [
                ...list,
                { id: nextId(list), label: '', reason: '', durationS: 86_400 },
              ]);
            }}
          >
            {t('mod.settings.add')}
          </button>
        </div>
        {!valid && <p className="alert">{t('mod.settings.invalid')}</p>}
      </fieldset>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={busy || !valid}>
          {t('mod.settings.save')}
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

/** Global switch and ban templates for moderation actions (T5.6). */
export function ModerationSettingsCard() {
  const { data, error } = useApi((signal) => api.moderationSettings(signal), []);
  if (error) return <p className="alert">{error}</p>;
  if (!data) return null;
  return <SettingsForm initial={data} />;
}
