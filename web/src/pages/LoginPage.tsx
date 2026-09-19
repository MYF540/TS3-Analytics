import { useState, type SubmitEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ApiRequestError } from '../api/client';
import { safeRedirect, useAuth } from '../auth/context';
import { errorMessage, t } from '../i18n';

export function LoginPage() {
  const { state, login } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const target = safeRedirect(params.get('weiter'));

  if (state.status === 'authenticated') return <Navigate to={target} replace />;

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    login(username, password)
      .then(() => {
        void navigate(target, { replace: true });
      })
      .catch((failure: unknown) => {
        setPassword('');
        if (failure instanceof ApiRequestError && failure.code === 'RATE_LIMITED') {
          const seconds = failure.retryAfterS ?? 60;
          setError(t('login.locked', { minutes: Math.max(1, Math.ceil(seconds / 60)) }));
        } else {
          setError(failure instanceof ApiRequestError ? failure.message : errorMessage('UNKNOWN'));
        }
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <main className="login">
      <form className="card login__card stack" onSubmit={submit} noValidate>
        <h1>{t('app.title')}</h1>
        <p className="muted">{t('login.intro')}</p>
        <label className="field">
          <span>{t('login.username')}</span>
          <input
            name="username"
            autoComplete="username"
            required
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>{t('login.password')}</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </label>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="button button--primary"
          disabled={busy || !username || !password}
        >
          {busy ? t('login.busy') : t('login.submit')}
        </button>
        <p className="muted small">{t('login.hint')}</p>
      </form>
    </main>
  );
}
