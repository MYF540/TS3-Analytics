import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Health } from '../api/types';
import { t, type MessageKey } from '../i18n';

const POLL_MS = 30_000;

type Status = Health['status'] | 'checking' | 'unreachable';

const LABEL: Record<Status, MessageKey> = {
  checking: 'status.checking',
  ok: 'status.ok',
  degraded: 'status.degraded',
  down: 'status.down',
  unreachable: 'status.unreachable',
};

/** Small dot in the header showing whether the service is connected to TeamSpeak. */
export function StatusIndicator() {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    const controller = new AbortController();
    const check = () => {
      api
        .health(controller.signal)
        .then((health) => {
          setStatus(health.status);
        })
        .catch(() => {
          if (!controller.signal.aborted) setStatus('unreachable');
        });
    };
    check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  return (
    <span className={`status status--${status}`} role="status" title={t(LABEL[status])}>
      <span className="status__dot" aria-hidden="true" />
      <span className="status__label">{t(LABEL[status])}</span>
    </span>
  );
}
