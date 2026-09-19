import { useEffect, useState } from 'react';
import { ApiRequestError } from '../api/client';
import { errorMessage } from '../i18n';

export interface ApiState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
}

interface Stored<T> {
  /** Which request (deps) the stored result belongs to. */
  key: string | undefined;
  data: T | undefined;
  error: string | undefined;
}

/**
 * Loads data with `load` whenever `deps` change; aborts outdated requests. Keeps the previous
 * data while reloading so charts do not flicker. `loading` is derived from whether the stored
 * result belongs to the current `deps`, so the effect only sets state asynchronously.
 */
export function useApi<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): ApiState<T> {
  const key = JSON.stringify(deps);
  const [stored, setStored] = useState<Stored<T>>({
    key: undefined,
    data: undefined,
    error: undefined,
  });

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setStored({ key, data, error: undefined });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof ApiRequestError ? error.message : errorMessage('UNKNOWN');
        setStored((s) => ({ key, data: s.data, error: message }));
      });
    return () => {
      controller.abort();
    };
    // `load` is recreated on every render; `key` (the serialised deps) decides when to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = stored.key === key;
  return {
    data: stored.data,
    error: current ? stored.error : undefined,
    loading: !current,
  };
}
