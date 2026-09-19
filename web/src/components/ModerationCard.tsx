import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { ModerationAction, ModerationSettings } from '../api/types';
import { useApi } from '../hooks/useApi';
import { t, type MessageKey } from '../i18n';
import { DURATIONS, durationLabel } from '../util/moderation';

const ACTIONS = ['poke', 'message', 'move', 'kick', 'ban'] as const;
type ActionType = (typeof ACTIONS)[number];

interface Props {
  userId: number;
  name: string;
  online: boolean;
}

function ActionForm({ userId, name, online, settings }: Props & { settings: ModerationSettings }) {
  const [type, setType] = useState<ActionType>(online ? 'poke' : 'ban');
  const [text, setText] = useState('');
  const [channelId, setChannelId] = useState('');
  const [kickFrom, setKickFrom] = useState<'server' | 'channel'>('server');
  const [templateId, setTemplateId] = useState(settings.banTemplates[0]?.id ?? '');
  const [durationS, setDurationS] = useState(86_400);
  const [includeIp, setIncludeIp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const channels = useApi(
    (signal) => (type === 'move' ? api.activitySettings(signal) : Promise.resolve(undefined)),
    [type],
  );

  const template = settings.banTemplates.find((tpl) => tpl.id === templateId);
  const available = online ? ACTIONS : (['ban'] as const);

  const build = (): ModerationAction | undefined => {
    switch (type) {
      case 'poke':
      case 'message':
        return text.trim() ? { type, message: text.trim() } : undefined;
      case 'move':
        return channelId ? { type, channelId: Number(channelId) } : undefined;
      case 'kick':
        return { type, from: kickFrom, reason: text.trim() };
      case 'ban':
        return template
          ? { type, templateId: template.id, includeIp: online && includeIp }
          : text.trim()
            ? { type, reason: text.trim(), durationS, includeIp: online && includeIp }
            : undefined;
    }
  };
  const action = build();

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!action) return;
    if (action.type === 'kick' && !window.confirm(t('mod.confirm.kick', { name }))) return;
    if (action.type === 'ban') {
      const duration = durationLabel(template?.durationS ?? durationS);
      if (!window.confirm(t('mod.confirm.ban', { name, duration }))) return;
    }
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    api.moderate(userId, action).then(
      (result) => {
        setMessage(
          action.type === 'ban' ? t('mod.doneBan') : t('mod.done', { count: result.affected }),
        );
        setText('');
        setBusy(false);
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
      },
    );
  };

  const textField = (label: MessageKey, max: number, hint: MessageKey) => (
    <>
      <label className="field">
        <span>{t(label)}</span>
        <textarea
          rows={type === 'message' ? 3 : 1}
          maxLength={max}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </label>
      <p className="muted small">{t(hint)}</p>
    </>
  );

  return (
    <form className="stack moderation" onSubmit={submit}>
      {!online && <p className="muted small">{t('mod.offline')}</p>}
      <div className="segmented" role="radiogroup" aria-label={t('mod.action')}>
        {available.map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={a === type}
            className={a === type ? 'segmented__item is-active' : 'segmented__item'}
            onClick={() => {
              setType(a);
              setText('');
              setError(undefined);
              setMessage(undefined);
            }}
          >
            {t(`mod.action.${a}`)}
          </button>
        ))}
      </div>

      {type === 'poke' && textField('mod.message', 100, 'mod.pokeHint')}
      {type === 'message' && textField('mod.message', 1024, 'mod.messageHint')}
      {type === 'move' && (
        <label className="field field--narrow">
          <span>{t('mod.channel')}</span>
          <select
            value={channelId}
            onChange={(event) => {
              setChannelId(event.target.value);
            }}
          >
            <option value="" />
            {channels.data?.channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {type === 'kick' && (
        <>
          <label className="field field--narrow">
            <span>{t('mod.kickFrom')}</span>
            <select
              value={kickFrom}
              onChange={(event) => {
                setKickFrom(event.target.value as 'server' | 'channel');
              }}
            >
              <option value="server">{t('mod.kickFrom.server')}</option>
              <option value="channel">{t('mod.kickFrom.channel')}</option>
            </select>
          </label>
          {textField('mod.reason', 40, 'mod.kickReasonHint')}
        </>
      )}
      {type === 'ban' && (
        <>
          <label className="field field--narrow">
            <span>{t('mod.template')}</span>
            <select
              value={templateId}
              onChange={(event) => {
                setTemplateId(event.target.value);
              }}
            >
              {settings.banTemplates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.label} ({durationLabel(tpl.durationS)})
                </option>
              ))}
              <option value="">{t('mod.template.custom')}</option>
            </select>
          </label>
          {!template && (
            <div className="field-row">
              <label className="field">
                <span>{t('mod.reason')}</span>
                <input
                  maxLength={200}
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value);
                  }}
                />
              </label>
              <label className="field field--narrow">
                <span>{t('mod.duration')}</span>
                <select
                  value={durationS}
                  onChange={(event) => {
                    setDurationS(Number(event.target.value));
                  }}
                >
                  {DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {durationLabel(d)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {online && (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={includeIp}
                  onChange={(event) => {
                    setIncludeIp(event.target.checked);
                  }}
                />
                {t('mod.includeIp')}
              </label>
              <p className="muted small">{t('mod.includeIpHint')}</p>
            </>
          )}
        </>
      )}

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button
          type="submit"
          className={
            type === 'ban' || type === 'kick' ? 'button button--danger' : 'button button--primary'
          }
          disabled={busy || !action}
        >
          {t('mod.submit')}
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

/** Kick, ban, poke, message and move for admins (T5.6); needs the global switch. */
export function ModerationCard(props: Props) {
  const { data, error } = useApi((signal) => api.moderationSettings(signal), []);
  if (error) return <p className="alert">{error}</p>;
  if (!data) return <p className="muted">{t('common.loading')}</p>;
  if (!data.enabled) {
    return (
      <p className="muted">
        {t('mod.disabled')} <Link to="/einstellungen">{t('mod.enableLink')}</Link>
      </p>
    );
  }
  return <ActionForm {...props} settings={data} />;
}
