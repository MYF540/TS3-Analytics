import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderAt, requested, sampleLoyalty } from '../test-utils';

const section = async (name: string) =>
  within(
    (await screen.findByRole('heading', { level: 2, name })).closest('section') as HTMLElement,
  );

describe('LoyaltyPage', () => {
  it('shows cohorts with shares, newest first, and marks too-early checks', async () => {
    mockApi({ '/api/auth/me': { user: { id: 2, username: 'gast', role: 'viewer' } } });
    renderAt('/bindung');
    const cohorts = await section('Kohorten');
    const rows = cohorts.getAllByRole('row').slice(1);
    expect(within(rows[0] as HTMLElement).getByRole('rowheader')).toHaveTextContent('Sept. 2026');
    expect(rows[0]).toHaveTextContent('25 %');
    expect(within(rows[1] as HTMLElement).getByText('75 %')).toHaveAttribute('title', '30 von 40');
    expect(within(rows[1] as HTMLElement).getAllByText('Noch zu früh')).toHaveLength(1);
    // Viewers cannot recompute.
    expect(screen.queryByRole('button', { name: 'Jetzt berechnen' })).not.toBeInTheDocument();
  });

  it('draws the monthly balance with a table view', async () => {
    mockApi();
    renderAt('/bindung');
    const months = await section('Monatsbilanz');
    const chart = months.getByRole('img', { name: /Monatsbilanz/ });
    const option = JSON.parse(chart.getAttribute('data-option') ?? '{}') as {
      series: { name: string; data: number[] }[];
    };
    expect(option.series.map((s) => [s.name, s.data])).toEqual([
      ['Aktiv', [120, 110]],
      ['Neu', [40, 20]],
      ['Wiedergekehrt', [3, 1]],
      ['Verloren', [12, 9]],
    ]);
    expect(months.getByRole('cell', { name: '120' })).toBeInTheDocument();
  });

  it('lists missing regulars with adjustable filter and CSV link', async () => {
    const fetchMock = mockApi();
    renderAt('/bindung');
    const missing = await section('Vermisste Stammspieler');
    expect(await missing.findByRole('link', { name: 'Alice' })).toHaveAttribute(
      'href',
      '/spieler/1',
    );
    expect(missing.getByText('10.09.2026')).toBeInTheDocument();
    expect(missing.getByText('Stammgast')).toBeInTheDocument();
    const first = requested(fetchMock, '/api/loyalty/missing')[0];
    expect(first?.searchParams.get('minHours')).toBe('20');
    expect(first?.searchParams.get('weeks')).toBe('4');

    fireEvent.change(missing.getByRole('spinbutton', { name: 'Mindestens Stunden' }), {
      target: { value: '50' },
    });
    fireEvent.change(missing.getByRole('spinbutton', { name: 'Fehlt seit Wochen' }), {
      target: { value: '8' },
    });
    expect(missing.getByRole('link', { name: 'Als CSV exportieren' })).toHaveAttribute(
      'href',
      '/api/loyalty/missing.csv?minHours=50&weeks=8',
    );
    await missing.findByText(/mindestens 50 h .* seit 8 Wochen/);
    const last = requested(fetchMock, '/api/loyalty/missing').at(-1);
    expect(last?.searchParams.get('minHours')).toBe('50');
    expect(last?.searchParams.get('weeks')).toBe('8');
  });

  it('lets admins recompute', async () => {
    const fetchMock = mockApi({
      '/api/loyalty/run': () => ({ body: sampleLoyalty }),
    });
    renderAt('/bindung');
    await userEvent.click(await screen.findByRole('button', { name: 'Jetzt berechnen' }));
    expect(await screen.findByText('Neu berechnet.')).toHaveAttribute('role', 'status');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
  });

  it('is in the navigation for every role', async () => {
    mockApi({ '/api/auth/me': { user: { id: 2, username: 'gast', role: 'viewer' } } });
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Hauptnavigation' });
    expect(within(nav).getByRole('link', { name: 'Bindung' })).toHaveAttribute('href', '/bindung');
  });
});
