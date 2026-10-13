import { useEffect, useState } from 'react';
import { api, describeError } from '../api/client';
import type { UpdateInfo } from '../api/types';
import { formatDateTime, t } from '../i18n';

/** How often the card asks again while an update is running. */
const POLL_MS = 5000;

/**
 * Version of the running service, the latest release on GitHub and – for installations that
 * can update themselves – the button that hands the update to the setup script.
 */
export function UpdateCard() {
  const [info, setInfo] = useState<UpdateInfo>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** Version an update was started for in this session. */
  const [installing, setInstalling] = useState<string>();

  useEffect(() => {
    let active = true;
    api.update().then(
      (result) => {
        if (active) setInfo(result);
      },
      (e: unknown) => {
        if (active) setError(describeError(e));
      },
    );
    return () => {
      active = false;
    };
  }, []);

  // While the update runs the service restarts, so failed requests are expected and ignored.
  useEffect(() => {
    if (installing === undefined) return;
    const timer = setInterval(() => {
      api.update().then(
        (result) => {
          setInfo(result);
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [installing]);

  if (error && !info) return <p className="alert">{error}</p>;
  if (!info?.enabled) return null;

  const { latest, lastRun } = info;
  const finished = installing !== undefined && info.currentVersion === installing;
  const failed = lastRun?.state === 'failed' ? lastRun : undefined;
  const running = installing !== undefined && !finished && !failed;

  const act = (request: () => Promise<UpdateInfo>, started?: string) => {
    setBusy(true);
    setError(undefined);
    request().then(
      (result) => {
        setInfo(result);
        setInstalling(started);
        setBusy(false);
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
      },
    );
  };

  const install = () => {
    if (!latest) return;
    if (!window.confirm(t('update.confirm', { version: latest.version }))) return;
    act(() => api.installUpdate(), latest.version);
  };

  return (
    <section className="card stack" aria-busy={busy || running}>
      <h2>{t('update.title')}</h2>
      <p>
        {t('update.current', { version: info.currentVersion })}{' '}
        {latest && !info.updateAvailable && (
          <span className="state state--active">{t('update.upToDate')}</span>
        )}
        {info.updateAvailable && latest && (
          <span className="state state--idle">
            {t('update.available', { version: latest.version })}
          </span>
        )}
      </p>
      <p className="muted small">
        {latest
          ? t('update.checkedAt', { time: formatDateTime(latest.checkedAt) })
          : t('update.neverChecked')}
      </p>

      {info.updateAvailable && latest && (
        <>
          <details>
            <summary>{t('update.notes', { version: latest.version })}</summary>
            <pre className="release-notes">{latest.notes || t('update.noNotes')}</pre>
          </details>
          <p>
            <a href={latest.url} target="_blank" rel="noreferrer">
              {t('update.releasePage')}
            </a>
          </p>
          {info.installBlocker && (
            <p className="muted small">{t(`update.blocker.${info.installBlocker}`)}</p>
          )}
        </>
      )}

      {running && (
        <p className="notice" role="status">
          {t('update.running', { version: installing })}
        </p>
      )}
      {finished && (
        <p className="notice" role="status">
          {t('update.finished', { version: installing })}
        </p>
      )}
      {failed && (
        <p className="notice notice--warn" role="alert">
          {t('update.failed', {
            version: failed.version,
            time: formatDateTime(failed.at),
            message: failed.message || t('update.noMessage'),
          })}
        </p>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <div className="button-row">
        <button
          type="button"
          className="button"
          disabled={busy || running}
          onClick={() => {
            act(() => api.checkUpdate());
          }}
        >
          {t('update.check')}
        </button>
        {info.updateAvailable && latest && !info.installBlocker && (
          <button type="button" className="button" disabled={busy || running} onClick={install}>
            {t('update.install', { version: latest.version })}
          </button>
        )}
      </div>
      <p className="muted small">{t('update.hint')}</p>
    </section>
  );
}
