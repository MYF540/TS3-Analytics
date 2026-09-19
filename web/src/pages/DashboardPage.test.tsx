import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderAt, requested, sampleSeries } from '../test-utils';

describe('DashboardPage', () => {
  it('shows the key figures', async () => {
    mockApi();
    renderAt('/');
    const kpi = async (label: string) =>
      (await screen.findByText(label)).parentElement?.querySelector('dd')?.textContent;
    await waitFor(async () => {
      expect(await kpi('Online jetzt')).toBe('12');
    });
    expect(await kpi('Höchststand heute')).toBe('30');
    expect(await kpi('Höchststand aller Zeiten')).toBe('87');
    expect(await kpi('Spieler gesamt')).toBe('8.512');
  });

  it('draws the online history and offers it as a table', async () => {
    mockApi();
    renderAt('/');
    const chart = await screen.findByRole('img', { name: /Liniendiagramm/ });
    const option = JSON.parse(chart.dataset.option ?? '{}') as {
      series: { name: string; data: number[] }[];
      yAxis: unknown;
    };
    expect(option.series.map((s) => s.name)).toEqual(['Ø online', 'Maximal gleichzeitig']);
    expect(option.series[0]?.data).toEqual([10.3, 11, 9.5]);
    expect(Array.isArray(option.yAxis)).toBe(false); // one axis only
    expect(screen.getByText('Auflösung: 5 Minuten')).toBeInTheDocument();

    const section = chart.closest('section');
    if (!section) throw new Error('chart section missing');
    await userEvent.click(within(section).getByText('Als Tabelle anzeigen'));
    expect(within(section).getAllByRole('row')).toHaveLength(1 + sampleSeries.points.length);
  });

  it('reloads figures and history when the range changes', async () => {
    const fetchMock = mockApi();
    renderAt('/');
    await screen.findByRole('img', { name: /Liniendiagramm/ });
    const picker = screen.getAllByRole('radiogroup')[0];
    if (!picker) throw new Error('range picker missing');
    await userEvent.click(within(picker).getByRole('radio', { name: '7 Tage' }));
    await waitFor(() => {
      expect(requested(fetchMock, '/api/stats/online').at(-1)?.searchParams.get('range')).toBe(
        '7d',
      );
    });
    expect(requested(fetchMock, '/api/stats/overview').at(-1)?.searchParams.get('range')).toBe(
      '7d',
    );
    expect(within(picker).getByRole('radio', { name: '7 Tage' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('shows the heatmap with its own range and a 7 × 24 table', async () => {
    const fetchMock = mockApi();
    renderAt('/');
    const heatmap = await screen.findByRole('img', { name: /Heatmap/ });
    const section = heatmap.closest('section');
    if (!section) throw new Error('heatmap section missing');
    expect(within(section).getAllByRole('row')).toHaveLength(8); // header + 7 weekdays
    await userEvent.click(within(section).getByRole('radio', { name: '1 Jahr' }));
    await waitFor(() => {
      expect(requested(fetchMock, '/api/stats/heatmap').at(-1)?.searchParams.get('range')).toBe(
        '1y',
      );
    });
  });

  it('explains empty periods and shows API errors', async () => {
    mockApi({
      '/api/stats/online': { ...sampleSeries, points: [] },
      '/api/stats/overview': () => ({
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      }),
    });
    renderAt('/');
    expect(
      await screen.findByText('Für diesen Zeitraum liegen noch keine Daten vor.'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Interner Fehler. Details stehen im Server-Log.'),
    ).toBeInTheDocument();
  });
});
