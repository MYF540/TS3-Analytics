import { useState, type SubmitEvent } from 'react';
import { api, describeError } from '../api/client';
import type { AlertEvent, AlertSettings } from '../api/types';
import { useApi } from '../hooks/useApi';
import { t } from '../i18n';

const EVENTS: readonly AlertEvent[] = [
  'flag.high',
  'flag.medium',
  'ban.added',
  'join.spike',
  'group.protected',
  'bot.connection',
];

function intIn(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value);
  return n >= min && n <= max ? n : undefined;
}

function AlertForm({ initial }: { initial: AlertSettings }) {
  const [saved, setSaved] = useState(initial);
  const [webhook, setWebhook] = useState('');
  const [events, setEvents] = useState<ReadonlySet<AlertEvent>>(new Set(initial.events));
  const [rate, setRate] = useState(String(initial.ratePerMinute));
  const [spikeWindow, setSpikeWindow] = useState(String(initial.joinSpike.windowMinutes));
  const [spikeThreshold, setSpikeThreshold] = useState(String(initial.joinSpike.threshold));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const rateValue = intIn(rate, 1, 30);
  const windowValue = intIn(spikeWindow, 1, 240);
  const thresholdValue = intIn(spikeThreshold, 2, 1000);
  const valid =
    rateValue !== undefined && windowValue !== undefined && thresholdValue !== undefined;

  const save = (webhookUrl: string | null | undefined) => {
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    api
      .saveAlertSettings({
        ...(webhookUrl === undefined ? {} : { webhookUrl }),
        events: EVENTS.filter((e) => events.has(e)),
        ratePerMinute: rateValue,
        joinSpike: { windowMinutes: windowValue, threshold: thresholdValue },
      })
      .then(
        (result) => {
          setSaved(result);
          setWebhook('');
          setMessage(t('alerts.saved'));
          setBusy(false);
        },
        (e: unknown) => {
          setError(describeError(e));
          setBusy(false);
        },
      );
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save(webhook.trim() === '' ? undefined : webhook.trim());
  };

  const test = () => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    api.testAlert().then(
      (result) => {
        if (result.ok) setMessage(t('alerts.testOk'));
        else
          setError(
            result.status === null
              ? t('alerts.testUnreachable')
              : t('alerts.testFailed', { status: result.status }),
          );
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
      <h2>{t('alerts.title')}</h2>
      <p className="muted small">{t('alerts.intro')}</p>
      <p className={saved.configured ? 'state state--active' : 'muted'}>
        {saved.configured && saved.webhookHint
          ? t('alerts.configured', { hint: saved.webhookHint })
          : t('alerts.notConfigured')}
      </p>

      <label className="field">
        <span>{t('alerts.webhook')}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={webhook}
          placeholder="https://discord.com/api/webhooks/…"
          aria-describedby="webhook-hint"
          onChange={(event) => {
            setWebhook(event.target.value);
          }}
        />
      </label>
      <p id="webhook-hint" className="muted small">
        {saved.configured ? t('alerts.webhookKeep') : t('alerts.webhookHelp')}
      </p>

      <fieldset className="settings-form__channels">
        <legend>{t('alerts.events')}</legend>
        {EVENTS.map((event) => (
          <label key={event} className="checkbox">
            <input
              type="checkbox"
              checked={events.has(event)}
              onChange={() => {
                setEvents((current) => {
                  const next = new Set(current);
                  if (next.has(event)) next.delete(event);
                  else next.add(event);
                  return next;
                });
              }}
            />
            {t(`alerts.event.${event}`)}
          </label>
        ))}
      </fieldset>

      <label className="field field--narrow">
        <span>{t('alerts.rate')}</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={30}
          value={rate}
          aria-invalid={rateValue === undefined}
          onChange={(event) => {
            setRate(event.target.value);
          }}
        />
      </label>
      <p className={rateValue === undefined ? 'alert' : 'muted small'}>{t('alerts.rateHint')}</p>

      <fieldset className="settings-form__channels">
        <legend>{t('alerts.spike.title')}</legend>
        <p className="muted small">{t('alerts.spike.hint')}</p>
        <div className="field-row">
          <label className="field field--narrow">
            <span>{t('alerts.spike.threshold')}</span>
            <input
              type="number"
              inputMode="numeric"
              min={2}
              max={1000}
              value={spikeThreshold}
              aria-invalid={thresholdValue === undefined}
              onChange={(event) => {
                setSpikeThreshold(event.target.value);
              }}
            />
          </label>
          <label className="field field--narrow">
            <span>{t('alerts.spike.window')}</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={240}
              value={spikeWindow}
              aria-invalid={windowValue === undefined}
              onChange={(event) => {
                setSpikeWindow(event.target.value);
              }}
            />
          </label>
        </div>
        {(thresholdValue === undefined || windowValue === undefined) && (
          <p className="alert">{t('alerts.spike.invalid')}</p>
        )}
      </fieldset>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={busy || !valid}>
          {t('alerts.save')}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || !saved.configured}
          onClick={test}
        >
          {t('alerts.test')}
        </button>
        {saved.configured && (
          <button
            type="button"
            className="button"
            disabled={busy || !valid}
            onClick={() => {
              save(null);
            }}
          >
            {t('alerts.removeWebhook')}
          </button>
        )}
        {message && (
          <span className="state state--active" role="status">
            {message}
          </span>
        )}
      </div>
    </form>
  );
}

/** Discord webhook and alert types (T5.4), admins only (the page is admin-only). */
export function AlertSettingsCard() {
  const { data, error } = useApi((signal) => api.alertSettings(signal), []);
  if (error) return <p className="alert">{error}</p>;
  if (!data) return null;
  return <AlertForm initial={data} />;
}
