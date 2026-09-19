import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { createTestDatabase } from '../db/testing.js';
import { createSilentLogger } from '../logging/logger.js';
import { AlertNotifier, escapeMarkdown } from './notifier.js';
import { saveAlertSettings, type AlertSettings } from './settings.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123456/secret-TOKEN_abc';

let database: AppDatabase;
let fetchMock: ReturnType<typeof vi.fn>;
let notifier: AlertNotifier;

function configure(settings: Partial<AlertSettings> = {}) {
  saveAlertSettings(
    database.db,
    { webhookUrl: WEBHOOK, events: ['flag.high', 'ban.added'], ratePerMinute: 3, ...settings },
    0,
  );
}

function sentTexts(): string[] {
  return fetchMock.mock.calls.map(
    ([, init]) => (JSON.parse((init as RequestInit).body as string) as { content: string }).content,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  database = createTestDatabase();
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  notifier = new AlertNotifier({
    db: database.db,
    logger: createSilentLogger(),
    fetch: fetchMock as unknown as typeof fetch,
  });
});

afterEach(() => {
  notifier.stop();
  database.close();
  vi.useRealTimers();
});

describe('AlertNotifier', () => {
  it('sends enabled events with mentions disabled', async () => {
    configure();
    notifier.notify('flag.high', 'Hinweis: @everyone');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(JSON.parse(init.body as string)).toEqual({
      content: 'Hinweis: @everyone',
      allowed_mentions: { parse: [] },
    });
  });

  it('ignores disabled events and a missing webhook', async () => {
    configure({ events: ['ban.added'] });
    notifier.notify('flag.high', 'x');
    configure({ webhookUrl: null });
    notifier.notify('ban.added', 'y');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throttles to the rate per minute and summarises the rest', async () => {
    configure({ ratePerMinute: 3 });
    for (let i = 1; i <= 7; i++) notifier.notify('flag.high', `Meldung ${String(i)}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(sentTexts()).toEqual([
      'Meldung 1',
      'Meldung 2',
      'Meldung 3\n… und 4 weitere Meldungen (gedrosselt, Details im Webinterface)',
    ]);
    notifier.notify('flag.high', 'Meldung 8');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sentTexts().at(-1)).toBe('Meldung 8');
  });

  it('waits for Discord after a rate limit and retries', async () => {
    configure();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ retry_after: 2.5 }), { status: 429 }),
    );
    notifier.notify('flag.high', 'Wichtig');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_499);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(sentTexts()).toEqual(['Wichtig', 'Wichtig']);
  });

  it('reports test results without throwing', async () => {
    configure();
    await expect(notifier.sendTest('Test')).resolves.toEqual({ ok: true });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(notifier.sendTest('Test')).resolves.toEqual({ ok: false, status: 404 });
    fetchMock.mockRejectedValueOnce(new Error(`connect failed ${WEBHOOK}`));
    await expect(notifier.sendTest('Test')).resolves.toEqual({ ok: false, status: null });
    configure({ webhookUrl: null });
    await expect(notifier.sendTest('Test')).resolves.toEqual({ ok: false, status: null });
  });
});

describe('escapeMarkdown', () => {
  it('escapes Discord formatting in player names', () => {
    expect(escapeMarkdown('**Boss**_x_ `y` [link](z)')).toBe(
      '\\*\\*Boss\\*\\*\\_x\\_ \\`y\\` \\[link\\]\\(z\\)',
    );
  });
});
