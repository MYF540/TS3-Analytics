import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, describeError } from '../api/client';
import type { NetworkGraph, NetworkRange } from '../api/types';
import { EChart } from '../charts/EChart';
import {
  categorize,
  COLOR_MODES,
  filterGraph,
  type Categorized,
  type ColorMode,
} from '../charts/network-view';
import { networkChartOption } from '../charts/options';
import { CHART_PALETTES } from '../charts/palette';
import { RangePicker } from '../components/RangePicker';
import { useApi } from '../hooks/useApi';
import { formatDateTime, formatDuration, formatNumber, t } from '../i18n';
import { useCurrentTheme } from '../theme/useCurrentTheme';
import { PageHeader } from './pages';

const RANGES = ['30d', '90d', '1y', 'all'] as const;
const LIMITS = [25, 50, 100, 200, 400, 800, 1500] as const;
const DEFAULT_LIMIT_INDEX = 3;

function isRange(value: string | null): value is NetworkRange {
  return (RANGES as readonly string[]).includes(value ?? '');
}

function isColorMode(value: string | null): value is ColorMode {
  return (COLOR_MODES as readonly string[]).includes(value ?? '');
}

/** A positive whole number from the URL, or undefined. */
function positive(value: string | null): number | undefined {
  return value !== null && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : undefined;
}

/** The categories of the current colour, each with a switch to hide it (T12.2). */
function Legend({
  categorized,
  hidden,
  onToggle,
  hint,
}: {
  categorized: Categorized;
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
  hint: string;
}) {
  return (
    <fieldset className="network-legend" aria-label={t('network.legend')}>
      <ul className="network-legend__list">
        {categorized.categories.map((category) => (
          <li key={category.key}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!hidden.has(category.key)}
                onChange={() => {
                  onToggle(category.key);
                }}
              />
              <span
                className="network-legend__swatch"
                style={{ background: category.color }}
                aria-hidden="true"
              />
              {category.label} <span className="muted">({formatNumber(category.count)})</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="muted small">{hint}</p>
    </fieldset>
  );
}

/** The strongest pairs as a table – a force graph alone is not readable for everyone. */
function PairTable({ data }: { data: NetworkGraph }) {
  const names = new Map(data.nodes.map((node) => [node.userId, node.nickname]));
  const name = (id: number) => names.get(id) ?? t('flags.unknownPlayer', { id });
  return (
    <details className="table-view">
      <summary>{t('network.showTable')}</summary>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('network.col.pair')}</th>
              <th scope="col">{t('network.col.together')}</th>
              <th scope="col">{t('network.col.encounters')}</th>
              <th scope="col">{t('network.col.share')}</th>
            </tr>
          </thead>
          <tbody>
            {data.edges.slice(0, 100).map((edge) => (
              <tr key={`${String(edge.a)}-${String(edge.b)}`}>
                <th scope="row">
                  <Link to={`/spieler/${String(edge.a)}`}>{name(edge.a)}</Link>
                  {' ↔ '}
                  <Link to={`/spieler/${String(edge.b)}`}>{name(edge.b)}</Link>
                </th>
                <td>{formatDuration(edge.seconds)}</td>
                <td>{formatNumber(edge.encounters)}</td>
                <td>
                  {t('network.shareValue', {
                    a: formatNumber(Math.round(edge.shareA * 100)),
                    b: formatNumber(Math.round(edge.shareB * 100)),
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function NetworkPage() {
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get('zeitraum');
  const range: NetworkRange = isRange(rangeParam) ? rangeParam : '30d';
  const colorParam = params.get('farbe');
  const colorMode: ColorMode = isColorMode(colorParam) ? colorParam : 'community';
  const focus = positive(params.get('spieler'));
  const depth: 1 | 2 = params.get('umfeld') === '2' ? 2 : 1;
  const minHours = positive(params.get('stunden')) ?? 0;
  const groupId = positive(params.get('gruppe')) ?? null;
  const weight = params.get('gewicht') === 'anteil' ? 'share' : 'seconds';

  const [limitIndex, setLimitIndex] = useState(DEFAULT_LIMIT_INDEX);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string>();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState('');
  const theme = useCurrentTheme();
  const palette = CHART_PALETTES[theme];

  const limit = LIMITS[limitIndex] ?? 200;
  const { data, error, loading } = useApi(
    (signal) =>
      api.network(
        {
          range,
          limit,
          ...(minHours > 0 ? { minS: minHours * 3600 } : {}),
          ...(focus === undefined ? {} : { focus, depth }),
        },
        signal,
      ),
    [range, limit, minHours, focus, depth, version],
  );

  // "Last seen" is measured against the time the page was opened.
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  // Categories come from the whole answer, so hiding one never repaints the others.
  const categorized = useMemo(
    () => (data ? categorize(data, colorMode, palette, now) : undefined),
    [data, colorMode, palette, now],
  );
  const shown = useMemo(
    () =>
      data && categorized
        ? filterGraph(data, categorized, { hidden, groupId, keep: focus })
        : undefined,
    [data, categorized, hidden, groupId, focus],
  );
  const option = useMemo(() => {
    if (!shown || !categorized) return undefined;
    const byKey = new Map(categorized.categories.map((category) => [category.key, category]));
    return networkChartOption(shown, palette, {
      categoryOf: (userId) => byKey.get(categorized.of.get(userId) ?? ''),
      weight,
      focus,
    });
  }, [shown, categorized, palette, weight, focus]);

  const setParam = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value === undefined) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const setRange = (next: NetworkRange) => {
    setParam('zeitraum', next === '30d' ? undefined : next);
  };

  const setColorMode = (next: ColorMode) => {
    setHidden(new Set());
    setParam('farbe', next === 'community' ? undefined : next);
  };

  const toggleCategory = (key: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const focusName =
    focus === undefined
      ? undefined
      : (data?.nodes.find((node) => node.userId === focus)?.nickname ??
        t('flags.unknownPlayer', { id: focus }));

  const chooseSearch = (value: string) => {
    setSearch(value);
    const match = data?.nodes.find(
      (node) =>
        node.nickname !== null && node.nickname.toLowerCase() === value.trim().toLowerCase(),
    );
    if (match) {
      setSearch('');
      setParam('spieler', String(match.userId));
    }
  };

  const recompute = () => {
    setBusy(true);
    setRunError(undefined);
    api.runNetworkJob().then(
      () => {
        setBusy(false);
        setVersion((v) => v + 1);
      },
      (e: unknown) => {
        setBusy(false);
        setRunError(describeError(e));
      },
    );
  };

  const names = data
    ? [
        ...new Set(data.nodes.flatMap((node) => (node.nickname === null ? [] : [node.nickname]))),
      ].sort((a, b) => a.localeCompare(b, 'de'))
    : [];

  return (
    <section className="stack">
      <PageHeader title={t('page.network.title')} intro={t('page.network.intro')} />

      <div className="toolbar">
        <RangePicker value={range} options={RANGES} onChange={setRange} />
        <label className="field field--narrow">
          <span>{t('network.limit', { count: formatNumber(limit) })}</span>
          <input
            type="range"
            min={0}
            max={LIMITS.length - 1}
            step={1}
            value={limitIndex}
            onChange={(event) => {
              setLimitIndex(Number(event.target.value));
            }}
          />
        </label>
        <button type="button" className="button button--small" disabled={busy} onClick={recompute}>
          {t('network.recompute')}
        </button>
      </div>

      <div className="toolbar">
        <label className="field field--narrow">
          <span>{t('network.search')}</span>
          <input
            type="search"
            list="network-players"
            value={search}
            placeholder={t('network.searchHint')}
            onChange={(event) => {
              chooseSearch(event.target.value);
            }}
          />
          <datalist id="network-players">
            {names.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        {focus !== undefined && (
          <>
            <label className="field field--narrow">
              <span>{t('network.depth')}</span>
              <select
                value={depth}
                onChange={(event) => {
                  setParam('umfeld', event.target.value === '2' ? '2' : undefined);
                }}
              >
                <option value="1">{t('network.depth.1')}</option>
                <option value="2">{t('network.depth.2')}</option>
              </select>
            </label>
            <p className="network-focus">
              <span>{t('network.focus', { name: focusName ?? '' })}</span>{' '}
              <button
                type="button"
                className="button button--small"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete('spieler');
                  next.delete('umfeld');
                  setParams(next, { replace: true });
                }}
              >
                {t('network.focusClear')}
              </button>
            </p>
          </>
        )}
        <label className="field field--narrow">
          <span>{t('network.minHours')}</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={10000}
            value={minHours === 0 ? '' : minHours}
            placeholder="0"
            onChange={(event) => {
              const value = event.target.value.trim();
              setParam('stunden', /^[1-9]\d{0,4}$/.test(value) ? value : undefined);
            }}
          />
        </label>
        <label className="field field--narrow">
          <span>{t('network.group')}</span>
          <select
            value={groupId ?? ''}
            onChange={(event) => {
              setParam('gruppe', event.target.value === '' ? undefined : event.target.value);
            }}
          >
            <option value="">{t('network.group.all')}</option>
            {(data?.groups ?? []).map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--narrow">
          <span>{t('network.color')}</span>
          <select
            value={colorMode}
            onChange={(event) => {
              setColorMode(event.target.value as ColorMode);
            }}
          >
            {COLOR_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`network.color.${mode}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--narrow">
          <span>{t('network.weight')}</span>
          <select
            value={weight}
            onChange={(event) => {
              setParam('gewicht', event.target.value === 'share' ? 'anteil' : undefined);
            }}
          >
            <option value="seconds">{t('network.weight.seconds')}</option>
            <option value="share">{t('network.weight.share')}</option>
          </select>
        </label>
      </div>

      {error && <p className="alert">{error}</p>}
      {runError && (
        <p className="alert" role="alert">
          {runError}
        </p>
      )}

      {data && shown && categorized && (
        <section className="card chart-card" aria-busy={loading || busy}>
          <header className="chart-card__header">
            <p className="muted small">
              {data.computedAt === null
                ? t('network.never')
                : t('network.computedAt', { time: formatDateTime(data.computedAt) })}
            </p>
            <p className="muted small">
              {t('network.counts', {
                nodes: formatNumber(data.nodes.length),
                edges: formatNumber(data.edges.length),
                total: formatNumber(data.edgesTotal),
              })}
              {shown.edges.length !== data.edges.length && (
                <>
                  <br />
                  {t('network.filtered', {
                    nodes: formatNumber(shown.nodes.length),
                    edges: formatNumber(shown.edges.length),
                  })}
                </>
              )}
            </p>
          </header>

          {data.edges.length > 0 && (
            <Legend
              categorized={categorized}
              hidden={hidden}
              onToggle={toggleCategory}
              hint={
                colorMode === 'community'
                  ? `${t('network.color.hint')} ${t('network.color.communityHint')}`
                  : t('network.color.hint')
              }
            />
          )}

          {shown.edges.length === 0 ? (
            <p className="muted">{t('network.empty')}</p>
          ) : (
            <>
              {option && <EChart option={option} label={t('network.label')} height={560} />}
              <p className="muted small">{t('network.hint')}</p>
              <PairTable data={shown} />
            </>
          )}
        </section>
      )}

      <p className="notice">{t('network.caveats')}</p>
    </section>
  );
}
