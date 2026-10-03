/**
 * Lookup at proxycheck.io (T10.10). The address is only passed on in the request; it is never
 * logged or returned, and error texts are our own so they cannot carry it either (rule 1).
 */

export type ProxyLookupResult =
  | { verdict: 'proxy'; kind: string | undefined }
  | { verdict: 'clean' }
  /** The service did not answer usefully; `reason` is a fixed text without the address. */
  | { verdict: 'unavailable'; reason: string };

export type ProxyLookup = (address: string) => Promise<ProxyLookupResult>;

export interface ProxycheckOptions {
  apiKey: string | undefined;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const ENDPOINT = 'https://proxycheck.io/v2/';

/** Reads the answer of the v2 API for one address. Exported for tests. */
export function readProxycheckAnswer(body: unknown, address: string): ProxyLookupResult {
  if (typeof body !== 'object' || body === null) {
    return { verdict: 'unavailable', reason: 'unexpected answer' };
  }
  const answer = body as Record<string, unknown>;
  const status = answer.status;
  if (status !== 'ok' && status !== 'warning') {
    // "denied" is what an exhausted quota or a blocked key look like.
    return {
      verdict: 'unavailable',
      reason: status === 'denied' ? 'request denied (quota or key)' : 'service reported an error',
    };
  }
  const entry = answer[address];
  if (typeof entry !== 'object' || entry === null) {
    return { verdict: 'unavailable', reason: 'no result for the address' };
  }
  const { proxy, type } = entry as { proxy?: unknown; type?: unknown };
  if (proxy === 'yes') {
    return { verdict: 'proxy', kind: typeof type === 'string' ? type.slice(0, 40) : undefined };
  }
  return proxy === 'no'
    ? { verdict: 'clean' }
    : { verdict: 'unavailable', reason: 'no result for the address' };
}

/** A lookup against the real service. Never throws. */
export function createProxycheckLookup(options: ProxycheckOptions): ProxyLookup {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  return async (address) => {
    const url = new URL(encodeURIComponent(address), ENDPOINT);
    url.searchParams.set('vpn', '1');
    if (options.apiKey) url.searchParams.set('key', options.apiKey);
    try {
      const response = await request(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        return { verdict: 'unavailable', reason: `HTTP ${String(response.status)}` };
      }
      return readProxycheckAnswer(await response.json(), address);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return { verdict: 'unavailable', reason: timedOut ? 'timeout' : 'request failed' };
    }
  };
}
