import type { SeriesPoint, UserDetail } from '../api/types';
import { formatDay, formatDuration, formatNumber, t, type MessageKey } from '../i18n';
import { eachDay } from '../util/days';
import type { ChartOption } from './EChart';
import type { ChartPalette } from './palette';

const TIME_ZONE = 'Europe/Berlin';

export const WEEKDAY_KEYS: MessageKey[] = [
  'weekday.mon',
  'weekday.tue',
  'weekday.wed',
  'weekday.thu',
  'weekday.fri',
  'weekday.sat',
  'weekday.sun',
];

const timeFormat = new Intl.DateTimeFormat('de-DE', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
});
const dayFormat = new Intl.DateTimeFormat('de-DE', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
});
const fullFormat = new Intl.DateTimeFormat('de-DE', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const fullDayFormat = new Intl.DateTimeFormat('de-DE', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** Axis label for a bucket start: time of day for sub-day resolutions, else the date. */
export function formatBucket(unixSeconds: number, resolution: number, full = false): string {
  const date = new Date(unixSeconds * 1000);
  if (full) return (resolution >= 86_400 ? fullDayFormat : fullFormat).format(date);
  return (resolution >= 86_400 ? dayFormat : timeFormat).format(date);
}

export function formatResolution(seconds: number): string {
  if (seconds >= 7 * 86_400) return t('resolution.week');
  if (seconds >= 86_400) return t('resolution.day');
  if (seconds >= 3600) return t('resolution.hours', { value: seconds / 3600 });
  return t('resolution.minutes', { value: seconds / 60 });
}

const round1 = (value: number) => Math.round(value * 10) / 10;

function axisStyle(palette: ChartPalette) {
  return {
    axisLine: { lineStyle: { color: palette.grid } },
    axisTick: { show: false },
    axisLabel: { color: palette.muted },
    splitLine: { lineStyle: { color: palette.grid } },
  };
}

function tooltipStyle(palette: ChartPalette) {
  return {
    backgroundColor: palette.surface,
    borderColor: palette.grid,
    textStyle: { color: palette.text },
  };
}

/** Line chart: average and maximum concurrent users per bucket (one axis, same unit). */
export function onlineChartOption(
  points: readonly SeriesPoint[],
  resolution: number,
  palette: ChartPalette,
): ChartOption {
  const avgName = t('chart.online.avg');
  const maxName = t('chart.online.max');
  const line = (name: string, color: string, values: number[]) => ({
    name,
    type: 'line',
    data: values,
    showSymbol: false,
    symbolSize: 8,
    lineStyle: { width: 2, color },
    itemStyle: { color, borderColor: palette.surface, borderWidth: 2 },
    emphasis: { focus: 'series' },
  });
  return {
    animation: false,
    grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
    legend: {
      top: 0,
      left: 0,
      icon: 'roundRect',
      itemWidth: 14,
      itemHeight: 4,
      textStyle: { color: palette.text },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: palette.muted } },
      ...tooltipStyle(palette),
      formatter: (
        params: { dataIndex: number; seriesName: string; value: number; marker: string }[],
      ) => {
        const first = params[0];
        if (!first) return '';
        const point = points[first.dataIndex];
        const header = point ? formatBucket(point.t, resolution, true) : '';
        const rows = params.map(
          (p) => `${p.marker}${p.seriesName}: <b>${formatNumber(p.value)}</b>`,
        );
        return [header, ...rows].join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: points.map((p) => formatBucket(p.t, resolution)),
      ...axisStyle(palette),
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      minInterval: 1,
      ...axisStyle(palette),
    },
    series: [
      line(
        avgName,
        palette.series[0],
        points.map((p) => round1(p.avgOnline)),
      ),
      line(
        maxName,
        palette.series[1],
        points.map((p) => p.maxOnline),
      ),
    ],
  };
}

/** Weekday × hour heatmap (Monday first, Berlin time) on the sequential ramp. */
export interface HeatmapLabels {
  /** Name of the value in the tooltip. */
  legend?: string | undefined;
  /** How a cell value is written; the default rounds to one decimal. */
  format?: ((value: number) => string) | undefined;
}

export function heatmapOption(
  values: readonly number[][],
  palette: ChartPalette,
  labels: HeatmapLabels = {},
): ChartOption {
  const legend = labels.legend ?? t('chart.heatmap.legend');
  const format = labels.format ?? ((value: number) => formatNumber(round1(value)));
  const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  const days = WEEKDAY_KEYS.map((key) => t(key));
  const data: [number, number, number][] = [];
  let max = 0;
  values.forEach((row, day) => {
    row.forEach((value, hour) => {
      data.push([hour, day, round1(value)]);
      max = Math.max(max, value);
    });
  });
  return {
    animation: false,
    grid: { left: 8, right: 8, top: 8, bottom: 48, containLabel: true },
    tooltip: {
      trigger: 'item',
      ...tooltipStyle(palette),
      formatter: (p: { value: [number, number, number] }) => {
        const [hour, day, value] = p.value;
        return `${days[day] ?? ''}, ${hours[hour] ?? ''}–${String(hour + 1).padStart(2, '0')} ${t('unit.clock')}<br/>${legend}: <b>${format(value)}</b>`;
      },
    },
    xAxis: {
      type: 'category',
      data: hours,
      ...axisStyle(palette),
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category',
      data: days,
      inverse: true,
      ...axisStyle(palette),
      splitLine: { show: false },
    },
    visualMap: {
      min: 0,
      max: Math.max(1, Math.ceil(max)),
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 160,
      itemWidth: 10,
      text: [t('chart.heatmap.high'), t('chart.heatmap.low')],
      textStyle: { color: palette.muted },
      inRange: { color: palette.ramp },
    },
    series: [
      {
        name: legend,
        type: 'heatmap',
        data,
        // 2px surface gap between cells.
        itemStyle: { borderColor: palette.surface, borderWidth: 2, borderRadius: 3 },
        emphasis: { itemStyle: { borderColor: palette.text, borderWidth: 1 } },
      },
    ],
  };
}

export const STATE_KEYS = [
  ['activeS', 'player.state.active'],
  ['idleS', 'player.state.idle'],
  ['afkS', 'player.state.afk'],
  ['unknownS', 'player.state.unknown'],
] as const satisfies readonly (readonly [keyof UserDetail['daily'][number], MessageKey])[];

/**
 * Stacked daily bars of a player's time by activity state (hours). Days without data are shown
 * as empty bars so the time axis stays continuous.
 */
export function playtimeChartOption(
  daily: UserDetail['daily'],
  fromDay: number,
  toDay: number,
  palette: ChartPalette,
): ChartOption {
  const days = eachDay(fromDay, toDay);
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const hours = (seconds: number) => Math.round((seconds / 3600) * 10) / 10;
  return {
    animation: false,
    grid: { left: 8, right: 8, top: 60, bottom: 8, containLabel: true },
    legend: {
      top: 0,
      left: 0,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: palette.text },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...tooltipStyle(palette),
      formatter: (
        params: { dataIndex: number; seriesName: string; marker: string; seriesIndex: number }[],
      ) => {
        const first = params[0];
        const day = first ? days[first.dataIndex] : undefined;
        if (day === undefined) return '';
        const entry = byDay.get(day);
        const rows = params.map((p) => {
          const key = STATE_KEYS[p.seriesIndex]?.[0];
          const seconds = entry && key ? entry[key] : 0;
          return `${p.marker}${p.seriesName}: <b>${formatDuration(seconds)}</b>`;
        });
        return [formatDay(day), ...rows].join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      data: days.map((d) => formatDay(d).slice(0, 6)),
      ...axisStyle(palette),
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: t('player.hours'),
      nameTextStyle: { color: palette.muted },
      min: 0,
      ...axisStyle(palette),
    },
    series: STATE_KEYS.map(([key, label], index) => ({
      name: t(label),
      type: 'bar',
      stack: 'time',
      barMaxWidth: 24,
      data: days.map((d) => hours(byDay.get(d)?.[key] ?? 0)),
      // Surface-coloured edge = visible gap between stacked segments.
      itemStyle: { color: palette.states[index], borderColor: palette.surface, borderWidth: 1 },
      emphasis: { focus: 'series' },
    })),
  };
}

export interface NetworkChartInput {
  nodes: { userId: number; nickname: string | null; seconds: number }[];
  edges: { a: number; b: number; seconds: number }[];
}

/**
 * Force-directed graph of who spends time with whom (T9.2). Node size is the counted time,
 * edge width the time two players spent together. Only the biggest nodes carry a label – with
 * two hundred names the picture would be unreadable, the table below lists them all.
 */
export function networkChartOption(
  data: NetworkChartInput,
  palette: ChartPalette,
  labelled = 15,
): ChartOption {
  const maxSeconds = Math.max(1, ...data.nodes.map((node) => node.seconds));
  const maxEdge = Math.max(1, ...data.edges.map((edge) => edge.seconds));
  const names = new Map(
    data.nodes.map((node) => [node.userId, node.nickname ?? `#${String(node.userId)}`]),
  );
  const withLabel = new Set(
    [...data.nodes]
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, labelled)
      .map((node) => node.userId),
  );

  return {
    animation: false,
    tooltip: {
      trigger: 'item',
      ...tooltipStyle(palette),
      formatter: (params: { dataType: string; data: Record<string, unknown> }) => {
        if (params.dataType === 'edge') {
          const edge = params.data as { source: string; target: string; seconds: number };
          return `${names.get(Number(edge.source)) ?? ''} ↔ ${names.get(Number(edge.target)) ?? ''}<br/>${t('network.tooltip.together')}: <b>${formatDuration(edge.seconds)}</b>`;
        }
        const node = params.data as { id: string; seconds: number; degree: number };
        return `${names.get(Number(node.id)) ?? ''}<br/>${t('network.tooltip.time')}: <b>${formatDuration(node.seconds)}</b><br/>${t('network.tooltip.partners')}: <b>${formatNumber(node.degree)}</b>`;
      },
    },
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        // Repulsion and edge length scale with the number of nodes so small and large
        // networks both stay readable.
        force: {
          repulsion: Math.max(60, 1200 / Math.max(1, Math.sqrt(data.nodes.length))),
          edgeLength: [30, 120],
          gravity: 0.08,
          friction: 0.2,
        },
        emphasis: { focus: 'adjacency', label: { show: true } },
        label: {
          show: true,
          position: 'right',
          color: palette.text,
          formatter: (params: { data: { id: string } }) =>
            withLabel.has(Number(params.data.id)) ? (names.get(Number(params.data.id)) ?? '') : '',
        },
        itemStyle: { color: palette.series[0], borderColor: palette.surface, borderWidth: 2 },
        // Muted ink, not the grid colour: the lines carry the structure and must be visible.
        lineStyle: { color: palette.muted, opacity: 0.35, curveness: 0 },
        data: data.nodes.map((node) => ({
          id: String(node.userId),
          name: names.get(node.userId) ?? '',
          seconds: node.seconds,
          degree: data.edges.filter((edge) => edge.a === node.userId || edge.b === node.userId)
            .length,
          // Area, not radius, carries the value: 8 px for the smallest, 46 px for the largest.
          symbolSize: 8 + 38 * Math.sqrt(node.seconds / maxSeconds),
        })),
        links: data.edges.map((edge) => ({
          source: String(edge.a),
          target: String(edge.b),
          seconds: edge.seconds,
          lineStyle: { width: 0.6 + 4.4 * (edge.seconds / maxEdge) },
        })),
      },
    ],
  };
}
