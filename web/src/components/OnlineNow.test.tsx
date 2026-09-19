import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderAt } from '../test-utils';

describe('OnlineNow on the dashboard', () => {
  it('lists who is online with channel and state', async () => {
    mockApi();
    renderAt('/');
    const heading = await screen.findByRole('heading', { name: 'Gerade online' });
    const card = heading.closest('section');
    if (!card) throw new Error('card missing');
    const box = within(card);
    expect(await box.findByRole('link', { name: 'Alice' })).toHaveAttribute('href', '/spieler/1');
    expect(box.getByText('Gaming')).toBeInTheDocument();
    expect(box.getByText('Aktiv')).toBeInTheDocument();
    expect(box.getByText('2 verbunden')).toBeInTheDocument();
  });

  it('does not show an outdated list without a query connection', async () => {
    mockApi({ '/api/online': { connected: false, items: [] } });
    renderAt('/');
    expect(await screen.findByText(/Keine Verbindung zum TeamSpeak-Server –/)).toBeInTheDocument();
  });

  it('says when nobody is online', async () => {
    mockApi({ '/api/online': { connected: true, items: [] } });
    renderAt('/');
    expect(await screen.findByText('Gerade ist niemand online.')).toBeInTheDocument();
  });
});
