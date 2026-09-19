import { useState, type SubmitEvent } from 'react';
import { api, describeError } from '../api/client';
import type { ActivitySettings, ActivitySettingsResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { formatDateTime, t } from '../i18n';
import { PageHeader } from './pages';

/** A channel counts as gone when the bot has not seen it for a day longer than the newest one. */
const GONE_AFTER_S = 86_400;

interface Draft {
  idleMinutes: string;
  afkChannelIds: ReadonlySet<number>;
  awayIsAfk: boolean;
  outputMutedIsAfk: boolean;
}

function toDraft(settings: ActivitySettings): Draft {
  return {
    idleMinutes: String(Math.round(settings.idleThresholdS / 60)),
    afkChannelIds: new Set(settings.afkChannelIds),
    awayIsAfk: settings.awayIsAfk,
    outputMutedIsAfk: settings.outputMutedIsAfk,
  };
}

function parseIdle(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const minutes = Number(value);
  return minutes >= 1 && minutes <= 1440 ? minutes : undefined;
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.idleMinutes.trim() === b.idleMinutes.trim() &&
    a.awayIsAfk === b.awayIsAfk &&
    a.outputMutedIsAfk === b.outputMutedIsAfk &&
    a.afkChannelIds.size === b.afkChannelIds.size &&
    [...a.afkChannelIds].every((id) => b.afkChannelIds.has(id))
  );
}

function ActivityForm({ data }: { data: ActivitySettingsResponse }) {
  const [saved, setSaved] = useState(() => toDraft(data.settings));
  const [draft, setDraft] = useState(saved);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const idleMinutes = parseIdle(draft.idleMinutes);
  const dirty = !sameDraft(draft, saved);
  const newest = Math.max(0, ...data.channels.map((c) => c.lastSeen));
  const known = new Set(data.channels.map((c) => c.id));
  const unknownSelected = [...draft.afkChannelIds].filter((id) => !known.has(id));
  const needle = filter.trim().toLocaleLowerCase('de');
  const visible = data.channels.filter(
    (c) =>
      !needle || c.name.toLocaleLowerCase('de').includes(needle) || draft.afkChannelIds.has(c.id),
  );

  const change = (next: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setMessage(undefined);
  };

  const toggleChannel = (id: number) => {
    const next = new Set(draft.afkChannelIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    change({ afkChannelIds: next });
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (idleMinutes === undefined) return;
    setBusy(true);
    setError(undefined);
    api
      .saveActivitySettings({
        idleThresholdS: idleMinutes * 60,
        afkChannelIds: [...draft.afkChannelIds],
        awayIsAfk: draft.awayIsAfk,
        outputMutedIsAfk: draft.outputMutedIsAfk,
      })
      .then(
        (result) => {
          const next = toDraft(result);
          setSaved(next);
          setDraft(next);
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
      <h2>{t('settings.activity.title')}</h2>
      <p className="notice">{t('settings.activity.futureOnly')}</p>

      <label className="field field--narrow">
        <span>{t('settings.idle.label')}</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={1440}
          value={draft.idleMinutes}
          aria-invalid={idleMinutes === undefined}
          aria-describedby="idle-hint"
          onChange={(event) => {
            change({ idleMinutes: event.target.value });
          }}
        />
      </label>
      <p id="idle-hint" className={idleMinutes === undefined ? 'alert' : 'muted small'}>
        {idleMinutes === undefined ? t('settings.invalidIdle') : t('settings.idle.hint')}
      </p>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={draft.awayIsAfk}
          onChange={(event) => {
            change({ awayIsAfk: event.target.checked });
          }}
        />
        {t('settings.away.label')}
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={draft.outputMutedIsAfk}
          onChange={(event) => {
            change({ outputMutedIsAfk: event.target.checked });
          }}
        />
        {t('settings.muted.label')}
      </label>

      <fieldset className="settings-form__channels">
        <legend>
          {t('settings.afk.title')}{' '}
          <span className="muted small">
            {t('settings.afk.selected', { count: draft.afkChannelIds.size })}
          </span>
        </legend>
        <p className="muted small">{t('settings.afk.hint')}</p>
        {data.channels.length === 0 ? (
          <p className="muted">{t('settings.afk.noChannels')}</p>
        ) : (
          <>
            <label className="field field--narrow">
              <span>{t('settings.afk.filter')}</span>
              <input
                type="search"
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                }}
              />
            </label>
            <ul className="channel-list">
              {unknownSelected.map((id) => (
                <li key={`unknown-${String(id)}`}>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked
                      onChange={() => {
                        toggleChannel(id);
                      }}
                    />
                    {t('settings.afk.unknown', { id })}
                  </label>
                </li>
              ))}
              {visible.map((c) => (
                <li key={c.id}>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={draft.afkChannelIds.has(c.id)}
                      onChange={() => {
                        toggleChannel(c.id);
                      }}
                    />
                    {c.name}
                    {newest - c.lastSeen > GONE_AFTER_S && (
                      <span className="muted small">
                        {t('settings.afk.gone', { time: formatDateTime(c.lastSeen) })}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </fieldset>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button
          type="submit"
          className="button button--primary"
          disabled={busy || !dirty || idleMinutes === undefined}
        >
          {t('settings.save')}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || !dirty}
          onClick={() => {
            setDraft(saved);
            setMessage(undefined);
          }}
        >
          {t('settings.reset')}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || sameDraft(draft, toDraft(data.defaults))}
          onClick={() => {
            change(toDraft(data.defaults));
          }}
        >
          {t('settings.defaults')}
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

export function SettingsPage() {
  const { data, error } = useApi((signal) => api.activitySettings(signal), []);
  return (
    <section className="stack">
      <PageHeader title={t('page.settings.title')} intro={t('page.settings.intro')} />
      {error && <p className="alert">{error}</p>}
      {!data && !error && <p className="muted">{t('common.loading')}</p>}
      {data && <ActivityForm data={data} />}
    </section>
  );
}
