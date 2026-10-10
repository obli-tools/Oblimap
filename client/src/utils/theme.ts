import type { AppTheme } from '@oblimap/shared';

export { type AppTheme };

const STORAGE_KEY = 'ov-theme';

/** All theme IDs this app knows how to render. */
const KNOWN_THEMES: readonly AppTheme[] = ['obli-operator', 'obli-daylight', 'obli-dim', 'modern', 'neon'];

/** True when `theme` is an id this app can render (see KNOWN_THEMES). */
export function isKnownTheme(theme: unknown): theme is AppTheme {
  return typeof theme === 'string' && (KNOWN_THEMES as readonly string[]).includes(theme);
}

/** Normalize any incoming value to a known theme, falling back to the default. */
function normalizeTheme(theme: string): AppTheme {
  return (KNOWN_THEMES as readonly string[]).includes(theme)
    ? (theme as AppTheme)
    : 'obli-operator';
}

/**
 * Apply a theme by setting data-theme on <html> and persisting it.
 * Accepts any string and falls back to 'obli-operator' on unknown IDs, so a
 * future theme added to Obligate can never brick the app.
 */
export function applyTheme(theme: string): void {
  const safe = normalizeTheme(theme);
  document.documentElement.dataset.theme = safe;
  // obli-daylight is the only light theme — keep the `dark` class off for it
  // (obli-dim is a mid-dark theme: it keeps the class).
  document.documentElement.classList.toggle('dark', safe !== 'obli-daylight');
  try {
    localStorage.setItem(STORAGE_KEY, safe);
  } catch {
    // localStorage unavailable
  }
}

/** Load the theme from localStorage (used before session check to avoid flash). */
export function loadSavedTheme(): AppTheme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeTheme(saved);
  } catch {
    // ignore
  }
  return 'obli-operator';
}

/** Called once on app boot in main.tsx to prevent flash of wrong theme. */
export function initTheme(): void {
  applyTheme(loadSavedTheme());
}
