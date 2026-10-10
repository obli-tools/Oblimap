import { useSyncExternalStore } from 'react';

/* Subscribe to <html data-theme> changes so the logo re-renders when the theme
   is switched at runtime (e.g. live preview in Profile / Enrollment). */
function subscribe(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}

function getSnapshot(): string {
  return document.documentElement.dataset.theme ?? 'obli-operator';
}

/** Reactive read of the current <html data-theme> value. */
export function useCurrentTheme(): string {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'obli-operator');
}

interface LogoProps {
  className?: string;
  alt?: string;
}

/**
 * Oblimap wordmark. Swaps to the dark-text variant on the light Obli Daylight
 * theme (the default white-text wordmark is invisible on a white surface).
 * The test is a whitelist of LIGHT themes: every other theme, including the
 * mid-dark Obli Dim, keeps the white-text wordmark.
 */
export function Logo({ className, alt = 'Oblimap' }: LogoProps) {
  const theme = useCurrentTheme();
  const src = theme === 'obli-daylight' ? '/logo-daylight.svg' : '/logo.svg';
  return <img src={src} alt={alt} className={className} />;
}
