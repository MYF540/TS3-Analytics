import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, vi } from 'vitest';

// jsdom has no canvas: replace charts with an accessible placeholder carrying the option.
vi.mock('./charts/EChart', () => ({
  EChart: ({ label, option }: { label: string; option: unknown }) =>
    createElement('div', {
      role: 'img',
      'aria-label': label,
      'data-option': JSON.stringify(option),
    }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
