import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { PrivateSettings } from '../api/types';
import { EnglishTexts } from '../components/EnglishTexts';
import { ModuleBaseFields } from '../components/ModuleBaseFields';
import { useApi } from '../hooks/useApi';
import { t, type MessageKey } from '../i18n';
import { PageHeader } from './pages';
import { englishIncomplete } from '../util/english';

type Settings = PrivateSettings['settings'];
type Lobby = Settings['lobbies'][number];
type TextKey = 'createdMessage' | 'movedMessage' | 'deniedMessage' | 'passwordMessage';

/** Numbers are edited as text so a field can be empty while typing. */
interface LobbyDraft extends Omit<Lobby, 'deleteDelayS' | 'maxClients' | 'codecQuality'> {
  deleteDelayMinutes: string;
  maxClients: string;
  codecQuality: string;
}

interface Draft extends Omit<Settings, 'lobbies' | 'cooldownS'> {
  lobbies: LobbyDraft[];
  cooldownS: string;
}

const TEXTS: readonly { key: TextKey; label: MessageKey }[] = [
  { key: 'createdMessage', label: 'private.createdMessage' },
  { key: 'movedMessage', label: 'private.movedMessage' },
  { key: 'deniedMessage', label: 'private.deniedMessage' },
  { key: 'passwordMessage', label: 'private.passwordMessage' },
];

const LOBBIES_MAX = 10;
const DELAY_MAX_MINUTES = 31 * 1440;

function toDraft(settings: Settings): Draft {
  return {
    ...settings,
    cooldownS: String(settings.cooldownS),
    lobbies: settings.lobbies.map((lobby) => ({
      ...lobby,
      deleteDelayMinutes: String(Math.round(lobby.deleteDelayS / 60)),
      maxClients: String(lobby.maxClients),
      codecQuality: String(lobby.codecQuality),
    })),
  };
}

function parseNumber(value: string, min: number, max: number): number | undefined {
  if (!/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : undefined;
}

function toLobby(draft: LobbyDraft): Lobby | undefined {
  const delay = parseNumber(draft.deleteDelayMinutes, 0, DELAY_MAX_MINUTES);
  const maxClients = parseNumber(draft.maxClients, -1, 1000);
  const codecQuality = parseNumber(draft.codecQuality, 0, 10);
  if (
    delay === undefined ||
    maxClients === undefined ||
    codecQuality === undefined ||
    draft.lobbyChannelId === 0 ||
    draft.parentId === 0 ||
    draft.lobbyChannelId === draft.parentId ||
    draft.nameTemplate.trim() === ''
  ) {
    return undefined;
  }
  return {
    id: draft.id,
    lobbyChannelId: draft.lobbyChannelId,
    parentId: draft.parentId,
    nameTemplate: draft.nameTemplate.trim(),
    channelGroupId: draft.channelGroupId,
    kind: draft.kind,
    deleteDelayS: delay * 60,
    description: draft.description,
    maxClients,
    codecQuality,
    password: draft.password,
    allowedGroupIds: draft.allowedGroupIds,
  };
}

function toSettings(draft: Draft): Settings | undefined {
  const cooldownS = parseNumber(draft.cooldownS, 0, 3600);
  const lobbies = draft.lobbies.map(toLobby);
  const entrances = draft.lobbies.map((lobby) => lobby.lobbyChannelId);
  if (
    cooldownS === undefined ||
    !lobbies.every((lobby): lobby is Lobby => lobby !== undefined) ||
    new Set(entrances).size !== entrances.length ||
    TEXTS.some(({ key }) => draft[key].trim() === '') ||
    englishIncomplete(
      draft.english.enabled,
      TEXTS.map(({ key }) => draft.english[key]),
    ) ||
    (draft.enabled && lobbies.length === 0)
  ) {
    return undefined;
  }
  return {
    enabled: draft.enabled,
    dryRun: draft.dryRun,
    exemptGroupIds: draft.exemptGroupIds,
    lobbies,
    cooldownS,
    createdMessage: draft.createdMessage.trim(),
    movedMessage: draft.movedMessage.trim(),
    deniedMessage: draft.deniedMessage.trim(),
    passwordMessage: draft.passwordMessage.trim(),
    english: {
      enabled: draft.english.enabled,
      createdMessage: draft.english.createdMessage.trim(),
      movedMessage: draft.english.movedMessage.trim(),
      deniedMessage: draft.english.deniedMessage.trim(),
      passwordMessage: draft.english.passwordMessage.trim(),
    },
  };
}

/** Fixed key order, so the form's copy and the server's compare equal. */
function fingerprint(settings: Settings): string {
  return JSON.stringify(toSettings(toDraft(settings)));
}

function newLobby(): LobbyDraft {
  return {
    id: `l${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    lobbyChannelId: 0,
    parentId: 0,
    nameTemplate: 'Privater Raum von {name}',
    channelGroupId: null,
    kind: 'temporary',
    deleteDelayMinutes: '5',
    description: '',
    maxClients: '-1',
    codecQuality: '6',
    password: false,
    allowedGroupIds: [],
  };
}

function Form({ data }: { data: PrivateSettings }) {
  const [saved, setSaved] = useState(() => fingerprint(data.settings));
  const [draft, setDraft] = useState(() => toDraft(data.settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const settings = toSettings(draft);
  const dirty = settings === undefined || JSON.stringify(settings) !== saved;
  const managed = (id: string) => data.managed.find((entry) => entry.lobbyId === id)?.count ?? 0;

  const change = (changes: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setMessage(undefined);
  };
  const changeLobby = (id: string, changes: Partial<LobbyDraft>) => {
    change({
      lobbies: draft.lobbies.map((lobby) => (lobby.id === id ? { ...lobby, ...changes } : lobby)),
    });
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError(undefined);
    api.savePrivateSettings(settings).then(
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

  const channelSelect = (
    label: string,
    value: number,
    onChange: (value: number) => void,
    invalid: boolean,
  ) => (
    <label className="field field--narrow">
      <span>{label}</span>
      <select
        value={value === 0 ? '' : value}
        aria-invalid={invalid}
        onChange={(event) => {
          onChange(Number(event.target.value) || 0);
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
  );

  return (
    <form className="card stack settings-form" onSubmit={submit} noValidate>
      <ModuleBaseFields value={draft} groups={data.groups} onChange={change} />

      {draft.lobbies.length === 0 && <p className="muted">{t('private.noLobbies')}</p>}
      {draft.lobbies.map((lobby, index) => {
        const label = t('private.lobby', { number: index + 1 });
        return (
          <fieldset key={lobby.id} className="settings-form__channels" aria-label={label}>
            <legend>{label}</legend>
            {channelSelect(
              t('private.entrance'),
              lobby.lobbyChannelId,
              (lobbyChannelId) => {
                changeLobby(lobby.id, { lobbyChannelId });
              },
              lobby.lobbyChannelId === 0,
            )}
            {channelSelect(
              t('private.parent'),
              lobby.parentId,
              (parentId) => {
                changeLobby(lobby.id, { parentId });
              },
              lobby.parentId === 0 || lobby.parentId === lobby.lobbyChannelId,
            )}
            <label className="field field--narrow">
              <span>{t('private.nameTemplate')}</span>
              <input
                type="text"
                maxLength={40}
                value={lobby.nameTemplate}
                aria-invalid={lobby.nameTemplate.trim() === ''}
                onChange={(event) => {
                  changeLobby(lobby.id, { nameTemplate: event.target.value });
                }}
              />
            </label>
            <label className="field field--narrow">
              <span>{t('private.channelGroup')}</span>
              {data.channelGroups.length > 0 ? (
                <select
                  value={lobby.channelGroupId ?? ''}
                  onChange={(event) => {
                    changeLobby(lobby.id, {
                      channelGroupId: event.target.value === '' ? null : Number(event.target.value),
                    });
                  }}
                >
                  <option value="">{t('private.noChannelGroup')}</option>
                  {data.channelGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                  {lobby.channelGroupId !== null &&
                    !data.channelGroups.some((group) => group.id === lobby.channelGroupId) && (
                      <option value={lobby.channelGroupId}>
                        {t('automation.unknownGroup', { id: lobby.channelGroupId })}
                      </option>
                    )}
                </select>
              ) : (
                <input
                  type="number"
                  min={1}
                  value={lobby.channelGroupId ?? ''}
                  onChange={(event) => {
                    const id = Number(event.target.value);
                    changeLobby(lobby.id, {
                      channelGroupId: Number.isInteger(id) && id > 0 ? id : null,
                    });
                  }}
                />
              )}
            </label>
            {data.channelGroups.length === 0 && (
              <p className="muted small">{t('private.channelGroupOffline')}</p>
            )}
            <label className="field field--narrow">
              <span>{t('private.kind')}</span>
              <select
                value={lobby.kind}
                onChange={(event) => {
                  changeLobby(lobby.id, { kind: event.target.value as Lobby['kind'] });
                }}
              >
                <option value="temporary">{t('private.kind.temporary')}</option>
                <option value="semi">{t('private.kind.semi')}</option>
                <option value="permanent">{t('private.kind.permanent')}</option>
              </select>
            </label>
            {lobby.kind === 'temporary' && (
              <label className="field field--narrow">
                <span>{t('private.deleteDelay')}</span>
                <input
                  type="number"
                  min={0}
                  max={DELAY_MAX_MINUTES}
                  value={lobby.deleteDelayMinutes}
                  aria-invalid={
                    parseNumber(lobby.deleteDelayMinutes, 0, DELAY_MAX_MINUTES) === undefined
                  }
                  onChange={(event) => {
                    changeLobby(lobby.id, { deleteDelayMinutes: event.target.value });
                  }}
                />
              </label>
            )}
            <label className="field field--narrow">
              <span>{t('channels.maxClients')}</span>
              <input
                type="number"
                min={-1}
                max={1000}
                value={lobby.maxClients}
                aria-invalid={parseNumber(lobby.maxClients, -1, 1000) === undefined}
                onChange={(event) => {
                  changeLobby(lobby.id, { maxClients: event.target.value });
                }}
              />
            </label>
            <label className="field field--narrow">
              <span>{t('channels.codecQuality')}</span>
              <input
                type="number"
                min={0}
                max={10}
                value={lobby.codecQuality}
                aria-invalid={parseNumber(lobby.codecQuality, 0, 10) === undefined}
                onChange={(event) => {
                  changeLobby(lobby.id, { codecQuality: event.target.value });
                }}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={lobby.password}
                onChange={(event) => {
                  changeLobby(lobby.id, { password: event.target.checked });
                }}
              />
              {t('private.password')}
            </label>
            <label className="field">
              <span>{t('private.description')}</span>
              <textarea
                rows={3}
                maxLength={2000}
                value={lobby.description}
                onChange={(event) => {
                  changeLobby(lobby.id, { description: event.target.value });
                }}
              />
            </label>
            {data.groups.length > 0 && (
              <>
                <p className="muted small">{t('private.allowed')}</p>
                <ul className="channel-list" aria-label={t('private.allowedLabel')}>
                  {data.groups.map((group) => (
                    <li key={group.id}>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={lobby.allowedGroupIds.includes(group.id)}
                          onChange={() => {
                            changeLobby(lobby.id, {
                              allowedGroupIds: lobby.allowedGroupIds.includes(group.id)
                                ? lobby.allowedGroupIds.filter((id) => id !== group.id)
                                : [...lobby.allowedGroupIds, group.id],
                            });
                          }}
                        />
                        {group.name}
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="muted small">{t('private.managed', { count: managed(lobby.id) })}</p>
            <div className="button-row">
              <button
                type="button"
                className="button"
                onClick={() => {
                  change({ lobbies: draft.lobbies.filter((entry) => entry.id !== lobby.id) });
                }}
              >
                {t('private.removeLobby')}
              </button>
            </div>
          </fieldset>
        );
      })}
      <div className="button-row">
        <button
          type="button"
          className="button"
          disabled={draft.lobbies.length >= LOBBIES_MAX}
          onClick={() => {
            change({ lobbies: [...draft.lobbies, newLobby()] });
          }}
        >
          {t('private.addLobby')}
        </button>
      </div>
      {draft.enabled && draft.lobbies.length === 0 && (
        <p className="alert">{t('error.PRIVATE_INCOMPLETE')}</p>
      )}

      <label className="field field--narrow">
        <span>{t('private.cooldown')}</span>
        <input
          type="number"
          min={0}
          max={3600}
          value={draft.cooldownS}
          aria-invalid={parseNumber(draft.cooldownS, 0, 3600) === undefined}
          onChange={(event) => {
            change({ cooldownS: event.target.value });
          }}
        />
      </label>
      {TEXTS.map(({ key, label }) => (
        <label className="field" key={key}>
          <span>{t(label)}</span>
          <input
            type="text"
            maxLength={1024}
            value={draft[key]}
            aria-invalid={draft[key].trim() === ''}
            onChange={(event) => {
              change({ [key]: event.target.value });
            }}
          />
        </label>
      ))}
      <p className="muted small">{t('private.placeholders')}</p>
      <EnglishTexts
        enabled={draft.english.enabled}
        onToggle={(enabled) => {
          change({ english: { ...draft.english, enabled } });
        }}
        fields={TEXTS.map(({ key, label }) => ({
          id: key,
          label: t(label),
          value: draft.english[key],
          max: 1024,
          onChange: (value: string) => {
            change({ english: { ...draft.english, [key]: value } });
          },
        }))}
      />

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

/** Settings of the private channels (T10.7), admins only. */
export function PrivateChannelPage() {
  const { data, error } = useApi((signal) => api.privateSettings(signal), []);
  return (
    <section className="stack">
      <PageHeader title={t('automation.module.private')} intro={t('private.intro')} />
      <p>
        <Link to="/automatik">{t('automation.back')}</Link>
      </p>
      {error && <p className="alert">{error}</p>}
      {data && <Form data={data} />}
    </section>
  );
}
