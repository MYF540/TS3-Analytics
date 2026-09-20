import { useState, type SubmitEvent } from 'react';
import { api, describeError } from '../api/client';
import type { NetworkSettings } from '../api/types';
import { useApi } from '../hooks/useApi';
import { formatDateTime, formatNumber, t } from '../i18n';

interface Draft {
  excludedChannelIds: ReadonlySet<number>;
  candidates: string;
  minEncounterMinutes: string;
  minPairMinutes: string;
}

function toDraft(settings: NetworkSettings['settings']): Draft {
  return {
    excludedChannelIds: new Set(settings.excludedChannelIds),
    candidates: String(settings.candidates),
    minEncounterMinutes: String(Math.round(settings.minEncounterS / 60)),
    minPairMinutes: String(Math.round(settings.minPairS / 60)),
  };
}

function parseNumber(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : undefined;
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.candidates.trim() === b.candidates.trim() &&
    a.minEncounterMinutes.trim() === b.minEncounterMinutes.trim() &&
    a.minPairMinutes.trim() === b.minPairMinutes.trim() &&
    a.excludedChannelIds.size === b.excludedChannelIds.size &&
    [...a.excludedChannelIds].every((id) => b.excludedChannelIds.has(id))
  );
}

function Form({ data, reload }: { data: NetworkSettings; reload: () => void }) {
  const [saved, setSaved] = useState(() => toDraft(data.settings));
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const candidates = parseNumber(draft.candidates, 10, 500);
  const minEncounter = parseNumber(draft.minEncounterMinutes, 0, 1440);
  const minPair = parseNumber(draft.minPairMinutes, 0, 14_400);
  const valid = candidates !== undefined && minEncounter !== undefined && minPair !== undefined;
  const dirty = !sameDraft(draft, saved);

  const change = (next: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setMessage(undefined);
  };

  const toggleChannel = (id: number) => {
    const next = new Set(draft.excludedChannelIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    change({ excludedChannelIds: next });
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    api
      .saveNetworkSettings({
        excludedChannelIds: [...draft.excludedChannelIds],
        candidates,
        minEncounterS: minEncounter * 60,
        minPairS: minPair * 60,
      })
      .then(
        (result) => {
          const next = toDraft(result.settings);
          setSaved(next);
          setDraft(next);
          setMessage(t('settings.saved'));
          setBusy(false);
          reload();
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
    api.runNetworkJob().then(
      () => {
        setMessage(t('settings.network.done'));
        setBusy(false);
        reload();
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
      },
    );
  };

  const state = data.state;
  return (
    <form className="card stack settings-form" onSubmit={submit} noValidate>
      <h2>{t('settings.network.title')}</h2>
      <p className="muted small">{t('settings.network.intro')}</p>

      <label className="field field--narrow">
        <span>{t('settings.network.candidates')}</span>
        <input
          type="number"
          inputMode="numeric"
          min={10}
          max={500}
          value={draft.candidates}
          aria-invalid={candidates === undefined}
          onChange={(event) => {
            change({ candidates: event.target.value });
          }}
        />
      </label>
      <p className="muted small">{t('settings.network.candidatesHint')}</p>

      <label className="field field--narrow">
        <span>{t('settings.network.minEncounter')}</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={1440}
          value={draft.minEncounterMinutes}
          aria-invalid={minEncounter === undefined}
          onChange={(event) => {
            change({ minEncounterMinutes: event.target.value });
          }}
        />
      </label>
      <label className="field field--narrow">
        <span>{t('settings.network.minPair')}</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={14400}
          value={draft.minPairMinutes}
          aria-invalid={minPair === undefined}
          onChange={(event) => {
            change({ minPairMinutes: event.target.value });
          }}
        />
      </label>

      <fieldset className="settings-form__channels">
        <legend>
          {t('settings.network.channels')}{' '}
          <span className="muted small">
            {t('settings.network.selected', { count: draft.excludedChannelIds.size })}
          </span>
        </legend>
        <p className="muted small">{t('settings.network.channelsHint')}</p>
        {data.channels.length === 0 ? (
          <p className="muted">{t('settings.afk.noChannels')}</p>
        ) : (
          <ul className="channel-list">
            {data.channels.map((channel) => (
              <li key={channel.id}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={channel.afk || draft.excludedChannelIds.has(channel.id)}
                    disabled={channel.afk}
                    onChange={() => {
                      toggleChannel(channel.id);
                    }}
                  />
                  {channel.name}
                  {channel.afk && (
                    <span className="muted small">{t('settings.network.alwaysAfk')}</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <p className="muted small">
        {state === null
          ? t('settings.network.never')
          : t('settings.network.lastRun', {
              time: formatDateTime(state.computedAt),
              seconds: formatNumber(Math.round(state.seconds * 10) / 10),
              nodes: formatNumber(state.ranges['30d']?.nodes ?? 0),
              edges: formatNumber(state.ranges['30d']?.edges ?? 0),
            })}
      </p>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="button" disabled={busy || !dirty || !valid}>
          {t('settings.save')}
        </button>
        <button type="button" className="button" disabled={busy} onClick={runNow}>
          {t('settings.network.run')}
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

/** Settings of the player network and the manual run (T9.1). */
export function NetworkSettingsCard() {
  const [version, setVersion] = useState(0);
  const { data, error } = useApi((signal) => api.networkSettings(signal), [version]);
  if (error) return <p className="alert">{error}</p>;
  if (!data) return null;
  return (
    <Form
      key={data.state?.computedAt ?? 0}
      data={data}
      reload={() => {
        setVersion((v) => v + 1);
      }}
    />
  );
}
