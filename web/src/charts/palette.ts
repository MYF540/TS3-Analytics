import type { Theme } from '../theme/theme';

/**
 * Chart colours per theme. Categorical slots 1–2 and the blue sequential ramp come from the
 * validated reference palette (dataviz skill): both modes pass lightness, chroma, CVD and
 * contrast checks. Text never uses series colours.
 */
export interface ChartPalette {
  text: string;
  muted: string;
  grid: string;
  surface: string;
  /** Categorical slot 1 (blue) and 2 (orange). */
  series: [string, string];
  /** Sequential ramp from "near zero" (close to the surface) to "high". */
  ramp: string[];
  /**
   * Activity states active/idle/afk/unknown = categorical slots 1–4 (validated for adjacent
   * stacking in both modes; light aqua/yellow are below 3:1 → legend + table view required).
   */
  states: [string, string, string, string];
  /**
   * Categories of a node graph (T12.2). Every node can sit next to every other, so the colours
   * must pass all pairs, not only adjacent ones: the validator allows three hues, everything
   * past them is folded into `other`.
   */
  categories: [string, string, string];
  /** "Other" and "unknown" – a neutral grey that carries no identity. */
  other: string;
  /** Three ordered steps of the blue ramp for ordinal data, strongest first (>= 2:1 to surface). */
  ordinal: [string, string, string];
}

export const CHART_PALETTES: Record<Theme, ChartPalette> = {
  light: {
    text: '#1b1f27',
    muted: '#5d6675',
    grid: '#e3e6ec',
    surface: '#ffffff',
    series: ['#2a78d6', '#eb6834'],
    ramp: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
    states: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'],
    categories: ['#2a78d6', '#eb6834', '#1baf7a'],
    other: '#9aa3b2',
    ordinal: ['#0d366b', '#2a78d6', '#86b6ef'],
  },
  dark: {
    text: '#e6e9ef',
    muted: '#9aa3b2',
    grid: '#2b3140',
    surface: '#171b23',
    series: ['#3987e5', '#d95926'],
    // On the dark surface "near zero" is the dark end and magnitude gets lighter.
    ramp: ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
    states: ['#3987e5', '#d95926', '#199e70', '#c98500'],
    categories: ['#3987e5', '#d95926', '#199e70'],
    other: '#5d6675',
    ordinal: ['#cde2fb', '#5598e7', '#184f95'],
  },
};
