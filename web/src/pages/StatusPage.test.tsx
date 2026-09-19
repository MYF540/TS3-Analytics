import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BotStatus } from '../api/types';
import { formatAgo, formatBytes, formatUptime } from '../i18n';
import { mockApi, renderAt, requested } from '../test-utils';

const NOW = 1_789_800_000;

const status: BotStatus = {
  process: {
    version: '0.1.0',
    nodeVersion: 'v22.20.0',
    startedAt: NOW - 3 * 86_400 - 4 * 3600,
    uptimeS: 3 * 86_400 + 4 * 3600,
    rssBytes: 150 * 1024 * 1024,
    heapUsedBytes: 60 * 1024 * 1024,
  },
  ts3: {
    state: 'waiting',
    since: NOW - 120,
    failedAttempts: 4,
    lastConnectedAt: NOW - 3600,
    lastError: { at: NOW - 120, message: 'connect ECONNREFUSED [IP]:10011' },
    queuedCommands: 0,
  },
  watcher: { lastHeartbeat: NOW - 45, onlineClients: 12, openSessions: 12 },
  database: {
    sizeBytes: 1_610_612_736,
    walBytes: 4096,
    freeBytes: 0,
    users: 2957,
    sessions: 120_000,
    segments: 480_000,
  },
  jobs: [
    {
      name: 'retention',
      intervalS: 86_400,
      lastRun: NOW - 3600,
      nextRun: NOW + 82_800,
      lastError: { at: NOW - 3600, message: 'disk full' },
    },
    { name: 'maintenance', intervalS: 604_800, lastRun: null, nextRun: NOW, lastError: null },
  ],
  problems: [
    {
      at: NOW - 120,
      level: 'warn',
      message: 'TS3 connection failed',
      detail: 'connect ECONNREFUSED [IP]:10011',
      count: 4,
    },
    { at: NOW - 7200, level: 'fatal', message: 'Crashed', detail: null, count: 1 },
  ],
};

function card(title: string) {
  const heading = screen.getByRole('heading', { level: 2, name: title });
  const section = heading.closest('section');
  if (!section) throw new Error(`card ${title} missing`);
  return within(section);
}

describe('formatters', () => {
  it('formats bytes, ages and uptimes in German', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_610_612_736)).toBe('1,5 GB');
    expect(formatAgo(45)).toBe('vor 45 s');
    expect(formatAgo(3 * 3600)).toBe('vor 3 h');
    expect(formatAgo(3 * 86_400)).toBe('vor 3 Tagen');
    expect(formatUptime(3 * 86_400 + 4 * 3600)).toBe('3 Tage 4 h');
    expect(formatUptime(86_400)).toBe('1 Tag 0 h');
    expect(formatUptime(600)).toBe('10 min');
  });
});

describe('StatusPage', () => {
  it('shows key figures, connection, database, jobs and problems', async () => {
    mockApi({ '/api/status': status });
    renderAt('/status');
    const kpi = async (label: string) =>
      (await screen.findByText(label)).parentElement?.querySelector('dd')?.textContent;
    expect(await kpi('TeamSpeak')).toBe('Getrennt, neuer Versuch folgt');
    expect(await kpi('Letzter Heartbeat')).toBe('vor 45 s');
    expect(await kpi('Laufzeit')).toBe('3 Tage 4 h');

    expect(card('TeamSpeak-Verbindung').getByText(/ECONNREFUSED/)).toBeInTheDocument();
    expect(card('Datenbank').getByText('480.000')).toBeInTheDocument();
    const jobs = card('Hintergrund-Jobs');
    expect(jobs.getByText('Aufbewahrung (IP-Daten, alte Segmente)')).toBeInTheDocument();
    expect(jobs.getByText('Fehler: disk full')).toBeInTheDocument();
    expect(jobs.getByText('fällig')).toBeInTheDocument();
    const problems = card('Letzte Warnungen und Fehler');
    expect(problems.getByText('4× hintereinander')).toBeInTheDocument();
    expect(problems.getByText('Absturz')).toBeInTheDocument();
    expect(screen.queryByText(/Heartbeat ist über 15 Minuten alt/)).not.toBeInTheDocument();
  });

  it('warns about a stale heartbeat and handles a missing watcher', async () => {
    mockApi({
      '/api/status': {
        ...status,
        ts3: null,
        watcher: { lastHeartbeat: NOW - 3600, onlineClients: null, openSessions: 0 },
        jobs: [],
        problems: [],
      },
    });
    renderAt('/status');
    expect(await screen.findByText(/Heartbeat ist über 15 Minuten alt/)).toBeInTheDocument();
    expect(screen.getByText('Der Watcher läuft in diesem Prozess nicht.')).toBeInTheDocument();
    expect(screen.getByText('Keine Jobs in diesem Prozess.')).toBeInTheDocument();
    expect(
      screen.getByText('Keine Warnungen oder Fehler in den letzten Logdateien.'),
    ).toBeInTheDocument();
  });

  it('reloads on demand', async () => {
    const fetchMock = mockApi({ '/api/status': status });
    renderAt('/status');
    await screen.findByText('Letzter Heartbeat');
    await userEvent.click(screen.getByRole('button', { name: 'Jetzt aktualisieren' }));
    await waitFor(() => {
      expect(requested(fetchMock, '/api/status')).toHaveLength(2);
    });
  });
});
