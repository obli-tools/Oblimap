import { useEffect, useRef } from 'react';
import { registerBackHandler, type BackHandler } from '@/native/bridge';

export interface UseNativeBackOptions {
  /**
   * Also receive the Escape key (handler gets `source === 'escape'`). Escape
   * only visits Escape-enabled entries, top-most first, so stacked overlays
   * close one at a time. Modal, Drawer, ConfirmDialog and ActionMenu use it;
   * default false (page-level handlers should not react to Escape).
   */
  escape?: boolean;
}

/**
 * Register `handler` for the Android shell's back button while `active` is
 * true (ported from Obliance). The most recently activated handler runs
 * first; return `false` from it to let the press fall through to the
 * previous one.
 *
 * Oblimap has no native shell: unless `window.ObliNative` exists the back
 * button is never intercepted (browser back, including inside the ObliTools
 * iframe, keeps its behaviour), so without `escape: true` this hook is a
 * no-op. With `escape: true` the Escape key reaches the handler everywhere.
 *
 *   useNativeBack(() => setOpen(false), open);
 */
export function useNativeBack(handler: BackHandler, active = true, options?: UseNativeBackOptions): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const escape = !!options?.escape;

  useEffect(() => {
    if (!active) return;
    return registerBackHandler((source) => handlerRef.current(source), { escape });
  }, [active, escape]);
}
