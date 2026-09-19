import { useSyncExternalStore } from 'react';
import type { Theme } from './theme';

function read(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    observer.disconnect();
  };
}

/** The theme currently applied to the page (charts re-colour when it changes). */
export function useCurrentTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => 'light');
}
