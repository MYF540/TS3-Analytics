import { useState } from 'react';
import { Link } from 'react-router';
import { api, describeError } from '../api/client';
import type { RankConfig, RankDraft, RankPreview, RankRunResult, RankSettings } from '../api/types';
import { useApi } from '../hooks/useApi';
import { formatDateTime, formatDuration, t } from '../i18n';
import { PageHeader } from './pages';

interface Row {
  key: number;
  id: number | undefined;
  name: string;
  hours: string;
  groupId: string;
}

function toRows(config: RankConfig): Row[] {
  return config.ranks.map((r) => ({
    key: r.id,
    id: r.id,
    name: r.name,
    hours: String(Math.round((r.requiredS / 3600) * 100) / 100),
    groupId: String(r.serverGroupId),
  }));
}

function parseHours(value: string): number | undefined {
  const n = Number(value.trim().replace(',', '.'));
  return value.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function Editor({
  initial,
  lastRun,
  onChanged,
}: {
  initial: RankConfig;
  lastRun: number | null;
  onChanged: () => void;
}) {
  const [config, setConfig] = useState(initial);
  const [rows, setRows] = useState(() => toRows(initial));
  const [settings, setSettings] = useState<RankSettings>(initial.settings);
  const [nextKey, setNextKey] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [preview, setPreview] = useState<RankPreview>();
  const [runResult, setRunResult] = useState<RankRunResult>();

  const groups = [
    ...config.knownGroups,
    ...config.ranks
      .filter((r) => !config.knownGroups.some((g) => g.id === r.serverGroupId))
      .map((r) => ({
        id: r.serverGroupId,
        name: t('ranks.groupUnknown', { id: r.serverGroupId }),
      })),
  ];
  const valid = rows.every(
    (r) => r.name.trim() !== '' && r.groupId !== '' && parseHours(r.hours) !== undefined,
  );

  const draft = (): RankDraft => ({
    ranks: rows.map((r) => ({
      ...(r.id === undefined ? {} : { id: r.id }),
      name: r.name.trim(),
      requiredS: Math.round((parseHours(r.hours) ?? 0) * 3600),
      serverGroupId: Number(r.groupId),
    })),
    settings,
  });

  const update = (key: number, changes: Partial<Row>) => {
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...changes } : r)));
    setMessage(undefined);
    setPreview(undefined);
  };
  const change = (next: Partial<RankSettings>) => {
    setSettings((s) => ({ ...s, ...next }));
    setMessage(undefined);
    setPreview(undefined);
  };

  const act = (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    action().then(
      () => {
        setBusy(false);
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
      },
    );
  };

  const save = () => {
    act(async () => {
      const saved = await api.saveRanks(draft());
      setConfig(saved);
      setRows(toRows(saved));
      setSettings(saved.settings);
      setMessage(t('ranks.saved'));
      onChanged();
    });
  };
  const showPreview = () => {
    act(async () => {
      setPreview(await api.previewRanks(draft()));
    });
  };
  const run = () => {
    if (!config.settings.dryRun && !window.confirm(t('ranks.runConfirm'))) return;
    act(async () => {
      setRunResult(await api.runRanks());
      onChanged();
    });
  };

  return (
    <>
      <p className={settings.dryRun ? 'notice' : 'notice notice--warn'} role="status">
        {settings.dryRun ? t('ranks.dryRunOn') : t('ranks.dryRunOff')}
      </p>

      <section className="card stack settings-form">
        <h2>{t('ranks.ladder')}</h2>
        <p className="muted small">{t('ranks.ladderHint')}</p>
        {groups.length === 0 && <p className="muted small">{t('ranks.noGroups')}</p>}
        {rows.length === 0 ? (
          <p className="muted">{t('ranks.empty')}</p>
        ) : (
          <ul className="templates">
            {rows.map((row) => (
              <li key={row.key} className="field-row">
                <label className="field">
                  <span>{t('ranks.name')}</span>
                  <input
                    maxLength={60}
                    value={row.name}
                    onChange={(event) => {
                      update(row.key, { name: event.target.value });
                    }}
                  />
                </label>
                <label className="field field--narrow">
                  <span>{t('ranks.hours')}</span>
                  <input
                    inputMode="decimal"
                    value={row.hours}
                    aria-invalid={parseHours(row.hours) === undefined}
                    onChange={(event) => {
                      update(row.key, { hours: event.target.value });
                    }}
                  />
                </label>
                <label className="field">
                  <span>{t('ranks.group')}</span>
                  <select
                    value={row.groupId}
                    onChange={(event) => {
                      update(row.key, { groupId: event.target.value });
                    }}
                  >
                    <option value="" />
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="icon-button templates__remove"
                  aria-label={t('ranks.remove', { name: row.name })}
                  title={t('ranks.remove', { name: row.name })}
                  onClick={() => {
                    setRows((list) => list.filter((r) => r.key !== row.key));
                    setPreview(undefined);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <button
            type="button"
            className="button button--small"
            onClick={() => {
              setRows((list) => [
                ...list,
                { key: nextKey, id: undefined, name: '', hours: '', groupId: '' },
              ]);
              setNextKey((k) => k - 1);
            }}
          >
            {t('ranks.add')}
          </button>
        </div>
        {!valid && <p className="alert">{t('ranks.invalid')}</p>}
      </section>

      <section className="card stack settings-form">
        <h2>{t('ranks.settings')}</h2>
        <fieldset className="settings-form__channels">
          <legend>{t('ranks.countMode')}</legend>
          {(['online', 'active'] as const).map((mode) => (
            <label key={mode} className="checkbox">
              <input
                type="radio"
                name="countMode"
                checked={settings.countMode === mode}
                onChange={() => {
                  change({ countMode: mode });
                }}
              />
              {t(`ranks.countMode.${mode}`)}
            </label>
          ))}
          <p className="muted small">{t('ranks.countHint')}</p>
        </fieldset>
        <label className="field field--narrow">
          <span>{t('ranks.interval')}</span>
          <input
            type="number"
            min={1}
            max={1440}
            value={settings.intervalMinutes}
            onChange={(event) => {
              change({
                intervalMinutes: Math.min(1440, Math.max(1, Number(event.target.value) || 1)),
              });
            }}
          />
        </label>
        {groups.length > 0 && (
          <fieldset className="settings-form__channels">
            <legend>{t('ranks.excluded')}</legend>
            <ul className="channel-list">
              {groups.map((g) => (
                <li key={g.id}>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.excludedGroupIds.includes(g.id)}
                      onChange={(event) => {
                        change({
                          excludedGroupIds: event.target.checked
                            ? [...settings.excludedGroupIds, g.id]
                            : settings.excludedGroupIds.filter((id) => id !== g.id),
                        });
                      }}
                    />
                    {g.name}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.promotionMessage.enabled}
            onChange={(event) => {
              change({
                promotionMessage: { ...settings.promotionMessage, enabled: event.target.checked },
              });
            }}
          />
          {t('ranks.message')}
        </label>
        {settings.promotionMessage.enabled && (
          <label className="field">
            <span>{t('ranks.messageText')}</span>
            <input
              maxLength={1024}
              value={settings.promotionMessage.text}
              onChange={(event) => {
                change({ promotionMessage: { enabled: true, text: event.target.value } });
              }}
            />
            <span className="muted small">{t('ranks.messageHint')}</span>
          </label>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.dryRun}
            onChange={(event) => {
              change({ dryRun: event.target.checked });
            }}
          />
          {t('ranks.dryRun')}
        </label>
        <p className="muted small">{t('ranks.dryRunHint')}</p>
      </section>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="button" className="button" disabled={busy || !valid} onClick={showPreview}>
          {t('ranks.preview')}
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={busy || !valid || settings.promotionMessage.text.trim() === ''}
          onClick={save}
        >
          {t('ranks.save')}
        </button>
        <button type="button" className="button" disabled={busy} onClick={run}>
          {t('ranks.run')}
        </button>
        {message && (
          <span className="state state--active" role="status">
            {message}
          </span>
        )}
      </div>
      <p className="muted small">
        {lastRun === null
          ? t('ranks.neverRun')
          : t('ranks.lastRun', { time: formatDateTime(lastRun) })}
      </p>
      {runResult && (
        <p className="muted small" role="status">
          {runResult.skipped
            ? t(`ranks.runSkipped.${runResult.skipped}`)
            : t('ranks.runResult', {
                checked: runResult.checked,
                changed: runResult.changed,
                commands: runResult.commands,
                pending: runResult.pending,
                failed: runResult.failed,
              })}
        </p>
      )}

      {preview && (
        <section className="card stack">
          <h2>{t('ranks.previewTitle')}</h2>
          <p className="muted small">{t('ranks.previewDraft')}</p>
          <p>{t('ranks.previewCounts', preview.counts)}</p>
          {preview.changes.length === 0 ? (
            <p className="muted">{t('ranks.previewEmpty')}</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table text-table">
                <thead>
                  <tr>
                    <th scope="col">{t('ranks.col.player')}</th>
                    <th scope="col">{t('ranks.col.time')}</th>
                    <th scope="col">{t('ranks.col.change')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((c) => (
                    <tr key={c.userId}>
                      <td>
                        <Link to={`/spieler/${String(c.userId)}`}>
                          {c.nickname ?? t('players.unknownNick')}
                        </Link>
                        {c.accounts > 1 && (
                          <span className="badge">
                            {t('ranks.accounts', { count: c.accounts })}
                          </span>
                        )}
                      </td>
                      <td>{formatDuration(c.rankingS)}</td>
                      <td>
                        <span
                          className={
                            c.direction === 'up' ? 'state state--active' : 'state state--idle'
                          }
                        >
                          {c.fromRankName ?? t('ranks.none')} → {c.toRankName ?? t('ranks.none')}
                        </span>
                        {c.frozen && <span className="badge">{t('ranks.frozen')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function History() {
  const { data, error } = useApi((signal) => api.rankHistory({ pageSize: 20 }, signal), []);
  if (error) return <p className="alert">{error}</p>;
  if (!data) return null;
  if (data.items.length === 0) return <p className="muted">{t('ranks.historyEmpty')}</p>;
  return (
    <div className="table-scroll">
      <table className="data-table text-table">
        <thead>
          <tr>
            <th scope="col">{t('ranks.col.when')}</th>
            <th scope="col">{t('ranks.col.player')}</th>
            <th scope="col">{t('ranks.col.change')}</th>
            <th scope="col">{t('ranks.col.time')}</th>
            <th scope="col">{t('ranks.col.result')}</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((h) => (
            <tr key={h.id}>
              <td>{formatDateTime(h.at)}</td>
              <td>
                <Link to={`/spieler/${String(h.userId)}`}>
                  {h.nickname ?? t('players.unknownNick')}
                </Link>
              </td>
              <td>
                {h.fromRankName ?? t('ranks.none')} → {h.toRankName ?? t('ranks.none')}
              </td>
              <td>{formatDuration(h.rankingS)}</td>
              <td>{t(`ranks.outcome.${h.outcome}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RanksPage() {
  const [version, setVersion] = useState(0);
  const { data, error } = useApi((signal) => api.ranks(signal), [version]);
  // The editor keeps its own state; only "last run" and the history follow reloads.
  const [initial, setInitial] = useState<RankConfig>();
  if (data && !initial) setInitial(data);
  return (
    <section className="stack">
      <PageHeader title={t('page.ranks.title')} intro={t('page.ranks.intro')} />
      {error && <p className="alert">{error}</p>}
      {initial && (
        <Editor
          initial={initial}
          lastRun={data?.lastRun ?? initial.lastRun}
          onChanged={() => {
            setVersion((v) => v + 1);
          }}
        />
      )}
      <section className="card stack">
        <h2>{t('ranks.history')}</h2>
        <History key={version} />
      </section>
    </section>
  );
}
