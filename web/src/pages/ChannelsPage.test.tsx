import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderAt, requested, sampleUnusedChannels } from '../test-utils';

function card(name: string) {
  const heading = screen.getByRole('heading', { level: 2, name });
  return within(heading.closest('section') as HTMLElement);
}

describe('ChannelsPage', () => {
  it('shows the busiest channels with time, players and visits', async () => {
    mockApi();
    renderAt('/channels');
    await screen.findByText('Gaming');
    const table = card('Zeit je Channel').getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(
      within(rows[0] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['7 h', '', '7', '31', expect.any(String)]);
    expect(within(rows[0] as HTMLElement).getByRole('rowheader')).toHaveTextContent('Gaming');
  });

  it('marks a channel that no longer exists on the server', async () => {
    mockApi();
    renderAt('/channels');
    await screen.findByText('Turnier 2025');
    expect(screen.getByText('Nicht mehr auf dem Server')).toBeInTheDocument();
  });

  it('reloads the usage when another range is picked', async () => {
    const fetchMock = mockApi();
    renderAt('/channels');
    await screen.findByRole('heading', { level: 2, name: 'Zeit je Channel' });
    await userEvent.click(screen.getByRole('radio', { name: '7 Tage' }));
    await waitFor(() => {
      expect(
        requested(fetchMock, '/api/channels/usage').map((url) => url.searchParams.get('range')),
      ).toContain('7d');
    });
  });

  it('lists unused channels and asks the server for another period', async () => {
    const fetchMock = mockApi();
    renderAt('/channels');
    await screen.findByText('Support');
    const unused = card('Ungenutzte Channels');
    for (const item of sampleUnusedChannels.items) {
      expect(unused.getByText(item.name)).toBeInTheDocument();
    }
    await userEvent.selectOptions(unused.getByLabelText('Zeitraum ohne Nutzung'), '90');
    await waitFor(() => {
      expect(
        requested(fetchMock, '/api/channels/unused').map((url) => url.searchParams.get('days')),
      ).toContain('90');
    });
  });

  it('says so when every channel was used', async () => {
    mockApi({ '/api/channels/unused': { days: 30, since: 1, items: [] } });
    renderAt('/channels');
    expect(
      await screen.findByText('Jeder Channel wurde in diesem Zeitraum genutzt.'),
    ).toBeInTheDocument();
  });
});
