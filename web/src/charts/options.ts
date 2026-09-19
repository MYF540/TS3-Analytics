import type { SeriesPoint } from '../api/types';
import { formatNumber, t, type MessageKey } from '../i18n';
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
export function heatmapOption(values: readonly number[][], palette: ChartPalette): ChartOption {
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
        return `${days[day] ?? ''}, ${hours[hour] ?? ''}–${String(hour + 1).padStart(2, '0')} ${t('unit.clock')}<br/>${t('chart.heatmap.legend')}: <b>${formatNumber(value)}</b>`;
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
        name: t('chart.heatmap.legend'),
        type: 'heatmap',
        data,
        // 2px surface gap between cells.
        itemStyle: { borderColor: palette.surface, borderWidth: 2, borderRadius: 3 },
        emphasis: { itemStyle: { borderColor: palette.text, borderWidth: 1 } },
      },
    ],
  };
}
