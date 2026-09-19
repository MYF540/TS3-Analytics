import { describe, expect, it } from 'vitest';
import { formatBucket, formatResolution, heatmapOption, onlineChartOption } from './options';
import { CHART_PALETTES } from './palette';

const utc = (iso: string) => Date.parse(iso) / 1000;

describe('onlineChartOption', () => {
  const points = [
    { t: utc('2026-09-19T10:00:00Z'), avgOnline: 3.14159, maxOnline: 5 },
    { t: utc('2026-09-19T11:00:00Z'), avgOnline: 4, maxOnline: 6 },
  ];

  it('uses the palette of the active theme for both series', () => {
    for (const theme of ['light', 'dark'] as const) {
      const option = onlineChartOption(points, 3600, CHART_PALETTES[theme]) as {
        series: { lineStyle: { color: string; width: number } }[];
      };
      expect(option.series.map((s) => s.lineStyle.color)).toEqual(CHART_PALETTES[theme].series);
      expect(option.series.every((s) => s.lineStyle.width === 2)).toBe(true);
    }
  });

  it('labels the time axis in Berlin time', () => {
    const option = onlineChartOption(points, 3600, CHART_PALETTES.light) as {
      xAxis: { data: string[] };
    };
    expect(option.xAxis.data).toEqual(['12:00', '13:00']); // CEST
  });
});

describe('heatmapOption', () => {
  it('produces one cell per weekday and hour and scales to the maximum', () => {
    const values = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    (values[2] as number[])[20] = 7.4;
    const option = heatmapOption(values, CHART_PALETTES.dark) as {
      series: { data: [number, number, number][] }[];
      visualMap: { max: number; inRange: { color: string[] } };
      yAxis: { data: string[] };
    };
    expect(option.series[0]?.data).toHaveLength(168);
    expect(option.series[0]?.data).toContainEqual([20, 2, 7.4]);
    expect(option.visualMap.max).toBe(8);
    expect(option.visualMap.inRange.color).toEqual(CHART_PALETTES.dark.ramp);
    expect(option.yAxis.data).toEqual(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);
  });
});

describe('formatting', () => {
  it('formats buckets and resolutions', () => {
    const t = utc('2026-09-19T10:00:00Z');
    expect(formatBucket(t, 86_400)).toBe('19.09.');
    expect(formatBucket(t, 300, true)).toContain('12:00');
    expect(formatResolution(300)).toBe('5 Minuten');
    expect(formatResolution(3600)).toBe('1 Std.');
    expect(formatResolution(86_400)).toBe('1 Tag');
    expect(formatResolution(7 * 86_400)).toBe('1 Woche');
  });
});
