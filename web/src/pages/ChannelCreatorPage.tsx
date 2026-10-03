import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { ChannelsSettings } from '../api/types';
import { ModuleBaseFields } from '../components/ModuleBaseFields';
import { useApi } from '../hooks/useApi';
import { t, type MessageKey } from '../i18n';
import { PageHeader } from './pages';

type Settings = ChannelsSettings['settings'];
type Area = Settings['areas'][number];
type NumberKey =
  'minFree' | 'maxChannels' | 'maxClients' | 'codecQuality' | 'joinPower' | 'talkPower';

/** Numbers are edited as text so a field can be empty while typing; names as one per line. */
interface AreaDraft extends Omit<Area, NumberKey | 'names'> {
  names: string;
  numbers: Record<NumberKey, string>;
}

const NUMBERS: readonly { key: NumberKey; label: MessageKey; min: number; max: number }[] = [
  { key: 'minFree', label: 'channels.minFree', min: 1, max: 5 },
  { key: 'maxChannels', label: 'channels.maxChannels', min: 1, max: 50 },
  { key: 'maxClients', label: 'channels.maxClients', min: -1, max: 1000 },
  { key: 'codecQuality', label: 'channels.codecQuality', min: 0, max: 10 },
  { key: 'joinPower', label: 'channels.joinPower', min: 0, max: 1_000_000 },
  { key: 'talkPower', label: 'channels.talkPower', min: 0, max: 1_000_000 },
];

const AREAS_MAX = 20;

function toDraft(area: Area): AreaDraft {
  return {
    id: area.id,
    parentId: area.parentId,
    naming: area.naming,
    prefix: area.prefix,
    description: area.description,
    names: area.names.join('\n'),
    numbers: {
      minFree: String(area.minFree),
      maxChannels: String(area.maxChannels),
      maxClients: String(area.maxClients),
      codecQuality: String(area.codecQuality),
      joinPower: String(area.joinPower),
      talkPower: String(area.talkPower),
    },
  };
}

function parseNumber(value: string, min: number, max: number): number | undefined {
  if (!/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : undefined;
}

function splitNames(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The area as the API wants it, or undefined while something is missing or out of range. */
function toArea(draft: AreaDraft): Area | undefined {
  const numbers = {} as Record<NumberKey, number>;
  for (const { key, min, max } of NUMBERS) {
    const value = parseNumber(draft.numbers[key], min, max);
    if (value === undefined) return undefined;
    numbers[key] = value;
  }
  const names = splitNames(draft.names);
  const prefix = draft.prefix.trim();
  if (draft.parentId === 0) return undefined;
  if (draft.naming === 'numbered' && prefix === '') return undefined;
  if (draft.naming === 'list' && (names.length === 0 || new Set(names).size !== names.length)) {
    return undefined;
  }
  return {
    id: draft.id,
    parentId: draft.parentId,
    naming: draft.naming,
    prefix,
    names,
    description: draft.description,
    ...numbers,
  };
}

/** Settings in a fixed key order, so the form's copy and the server's compare equal. */
function fingerprint(settings: Settings): string {
  return JSON.stringify({
    enabled: settings.enabled,
    dryRun: settings.dryRun,
    exemptGroupIds: settings.exemptGroupIds,
    areas: settings.areas.map((area) => toArea(toDraft(area))),
  });
}

function newAreaId(): string {
  return `a${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

function Form({ data, reload }: { data: ChannelsSettings; reload: () => void }) {
  const [saved, setSaved] = useState(() => fingerprint(data.settings));
  const [base, setBase] = useState({
    enabled: data.settings.enabled,
    dryRun: data.settings.dryRun,
    exemptGroupIds: data.settings.exemptGroupIds,
  });
  const [areas, setAreas] = useState(() => data.settings.areas.map(toDraft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const parsed = areas.map(toArea);
  const complete = parsed.every((area): area is Area => area !== undefined);
  const parents = areas.map((area) => area.parentId);
  const duplicateParent = new Set(parents).size !== parents.length;
  const settings: Settings | undefined =
    complete && !duplicateParent ? { ...base, areas: parsed } : undefined;
  const dirty = settings === undefined || fingerprint(settings) !== saved;
  const managed = (id: string) => data.managed.find((entry) => entry.areaId === id)?.count ?? 0;

  const changeArea = (id: string, changes: Partial<AreaDraft>) => {
    setAreas((current) => current.map((area) => (area.id === id ? { ...area, ...changes } : area)));
    setMessage(undefined);
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError(undefined);
    api.saveChannelsSettings(settings).then(
      (result) => {
        setSaved(fingerprint(result.settings));
        setAreas(result.settings.areas.map(toDraft));
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

  const adopt = (areaId: string) => {
    setBusy(true);
    setError(undefined);
    api.adoptChannels(areaId).then(
      ({ adopted }) => {
        setMessage(t('channels.adopted', { count: adopted }));
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
      <ModuleBaseFields
        value={base}
        groups={[]}
        hideExempt
        onChange={(changes) => {
          setBase((current) => ({ ...current, ...changes }));
          setMessage(undefined);
        }}
      />

      {areas.length === 0 && <p className="muted">{t('channels.noAreas')}</p>}
      {areas.map((area, index) => {
        const label = t('channels.area', { number: index + 1 });
        const isSaved = data.settings.areas.some((entry) => entry.id === area.id);
        return (
          <fieldset key={area.id} className="settings-form__channels" aria-label={label}>
            <legend>{label}</legend>
            <label className="field field--narrow">
              <span>{t('channels.parent')}</span>
              <select
                value={area.parentId === 0 ? '' : area.parentId}
                aria-invalid={area.parentId === 0}
                onChange={(event) => {
                  changeArea(area.id, { parentId: Number(event.target.value) || 0 });
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
            <label className="field field--narrow">
              <span>{t('channels.naming')}</span>
              <select
                value={area.naming}
                onChange={(event) => {
                  changeArea(area.id, { naming: event.target.value as Area['naming'] });
                }}
              >
                <option value="numbered">{t('channels.naming.numbered')}</option>
                <option value="list">{t('channels.naming.list')}</option>
              </select>
            </label>
            {area.naming === 'numbered' ? (
              <label className="field field--narrow">
                <span>{t('channels.prefix')}</span>
                <input
                  type="text"
                  maxLength={35}
                  value={area.prefix}
                  aria-invalid={area.prefix.trim() === ''}
                  onChange={(event) => {
                    changeArea(area.id, { prefix: event.target.value });
                  }}
                />
              </label>
            ) : (
              <label className="field">
                <span>{t('channels.names')}</span>
                <textarea
                  rows={4}
                  value={area.names}
                  aria-invalid={splitNames(area.names).length === 0}
                  onChange={(event) => {
                    changeArea(area.id, { names: event.target.value });
                  }}
                />
              </label>
            )}
            {NUMBERS.map(({ key, label: numberLabel, min, max }) => (
              <label className="field field--narrow" key={key}>
                <span>{t(numberLabel)}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={min}
                  max={max}
                  value={area.numbers[key]}
                  aria-invalid={parseNumber(area.numbers[key], min, max) === undefined}
                  onChange={(event) => {
                    changeArea(area.id, {
                      numbers: { ...area.numbers, [key]: event.target.value },
                    });
                  }}
                />
              </label>
            ))}
            <p className="muted small">{t('channels.numbersHint')}</p>
            <label className="field">
              <span>{t('channels.description')}</span>
              <textarea
                rows={3}
                maxLength={2000}
                value={area.description}
                onChange={(event) => {
                  changeArea(area.id, { description: event.target.value });
                }}
              />
            </label>
            <p className="muted small">{t('channels.managed', { count: managed(area.id) })}</p>
            <div className="button-row">
              <button
                type="button"
                className="button"
                disabled={busy || dirty || !isSaved}
                onClick={() => {
                  adopt(area.id);
                }}
              >
                {t('channels.adopt')}
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setAreas((current) => current.filter((entry) => entry.id !== area.id));
                  setMessage(undefined);
                }}
              >
                {t('channels.removeArea')}
              </button>
            </div>
            <p className="muted small">{t('channels.adoptHint')}</p>
          </fieldset>
        );
      })}
      {duplicateParent && <p className="alert">{t('channels.duplicateParent')}</p>}

      <div className="button-row">
        <button
          type="button"
          className="button"
          disabled={areas.length >= AREAS_MAX}
          onClick={() => {
            setAreas((current) => [
              ...current,
              toDraft({
                id: newAreaId(),
                parentId: 0,
                naming: 'numbered',
                prefix: '',
                names: [],
                minFree: 1,
                maxChannels: 20,
                maxClients: -1,
                codecQuality: 6,
                joinPower: 0,
                talkPower: 0,
                description: '',
              }),
            ]);
            setMessage(undefined);
          }}
        >
          {t('channels.addArea')}
        </button>
      </div>

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

/** Settings of the channel creator (T10.6), admins only. */
export function ChannelCreatorPage() {
  const [version, setVersion] = useState(0);
  const { data, error } = useApi((signal) => api.channelsSettings(signal), [version]);
  return (
    <section className="stack">
      <PageHeader title={t('automation.module.channels')} intro={t('channels.intro')} />
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
