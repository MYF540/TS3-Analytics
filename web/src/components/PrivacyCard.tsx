import { useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, describeError } from '../api/client';
import { hasRole, useCurrentUser } from '../auth/context';
import { t } from '../i18n';

/** GDPR export and anonymization of one player (T7.2); admins only. */
export function PrivacyCard({ userId, uid, name }: { userId: number; uid: string; name: string }) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const [confirmUid, setConfirmUid] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!hasRole(user, 'admin')) return null;

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (confirmUid.trim() !== uid) {
      setError(t('error.UID_MISMATCH'));
      return;
    }
    if (!window.confirm(t('privacy.confirm', { name }))) return;
    setBusy(true);
    setError(undefined);
    api.anonymizeUser(userId, confirmUid.trim()).then(
      () => {
        void navigate('/spieler');
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
      },
    );
  };

  return (
    <>
      <p className="muted small">{t('privacy.intro')}</p>
      <p>
        <a className="button button--small" href={api.exportUrl(userId)} download>
          {t('privacy.export')}
        </a>
      </p>
      <form className="stack" onSubmit={submit}>
        <p className="notice notice--warn">{t('privacy.anonymizeHint')}</p>
        <label className="field">
          <span>{t('privacy.confirmUid')}</span>
          <input
            value={confirmUid}
            autoComplete="off"
            spellCheck={false}
            placeholder={uid}
            onChange={(event) => {
              setConfirmUid(event.target.value);
            }}
          />
        </label>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <div className="button-row">
          <button
            type="submit"
            className="button button--danger button--small"
            disabled={busy || confirmUid.trim() === ''}
          >
            {t('privacy.anonymize')}
          </button>
        </div>
      </form>
    </>
  );
}
