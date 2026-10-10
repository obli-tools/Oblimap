/**
 * Obli Android shell bridge (ported from Obliance client/src/native/bridge.ts).
 *
 * The ONLY module allowed to touch `window.__obli_native` / `window.ObliNative`.
 * Pages go through the helpers below (or through utils/download.ts,
 * utils/openExternal.ts), never through `window.*`.
 *
 * Oblimap has no native shell today: in a browser and inside the ObliTools
 * desktop iframe every `canUseNative()` is false, the helpers fall back to the
 * browser, and the Android back hook (`window.__obliHandleBack`) is never
 * installed — browser back keeps its normal behaviour. Only the Escape-key
 * stack used by Modal / Drawer / ActionMenu is always active.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type NativeCapability =
  | 'saveFile'
  | 'downloadUrl'
  | 'openExternal'
  | 'clipboard'
  | 'share'
  | 'notify'
  | 'settings'
  | 'back'
  | 'systemBars'
  | 'update';

/** Injected by the shell at document start. */
export interface ObliNativeInfo {
  platform: 'android';
  /** Flavor id, e.g. 'oblimap'. */
  app: string;
  appVersion: string;
  versionCode: number;
  bridgeVersion: number;
  capabilities: string[];
}

export interface NativeSaveFileResult { uri: string }
export interface NativeUpdateInfo { available: boolean; versionName: string; versionCode: number }
export interface NativeAppInfo {
  app: string;
  appVersion: string;
  versionCode: number;
  webViewVersion: string;
  serverUrl: string;
}

/** `window.ObliNative` — every method returns a Promise. */
export interface ObliNativeApi {
  saveFile(filename: string, mime: string, base64: string): Promise<NativeSaveFileResult>;
  downloadUrl(url: string, filename?: string): Promise<unknown>;
  openExternal(url: string): Promise<unknown>;
  copyText(text: string): Promise<unknown>;
  readClipboard(): Promise<string>;
  share(text: string, title?: string): Promise<unknown>;
  notify(title: string, body: string, navigateTo?: string): Promise<unknown>;
  openSettings(): Promise<unknown>;
  setSystemBars(colorHex: string, lightIcons: boolean): Promise<unknown>;
  requestNotificationPermission(): Promise<'granted' | 'denied'>;
  checkForUpdate(): Promise<NativeUpdateInfo>;
  getInfo(): Promise<NativeAppInfo>;
}

export type NativeMethod = keyof ObliNativeApi;

declare global {
  interface Window {
    __obli_native?: ObliNativeInfo;
    ObliNative?: Partial<ObliNativeApi>;
    /** Called by the Android shell on the system back button. */
    __obliHandleBack?: () => boolean;
  }
}

/** Rejection reason of `native.*` when the bridge / method / capability is absent. */
export class NativeUnavailableError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`Native bridge method "${method}" is not available`);
    this.name = 'NativeUnavailableError';
    this.method = method;
  }
}

// ── Detection ────────────────────────────────────────────────────────────────

/** Shell info injected by the Android app, or null in a normal browser. */
export function nativeInfo(): ObliNativeInfo | null {
  if (typeof window === 'undefined') return null;
  try {
    const info = window.__obli_native;
    return info && typeof info === 'object' ? info : null;
  } catch {
    return null;
  }
}

/** True when running inside the Obli Android shell (WebView) with its bridge object. */
export function isAndroidApp(): boolean {
  if (nativeInfo()?.platform !== 'android') return false;
  try {
    return typeof window.ObliNative === 'object' && window.ObliNative !== null;
  } catch {
    return false;
  }
}

/** True when the shell advertises capability `c` (always false in a browser). */
export function hasCapability(c: NativeCapability): boolean {
  const caps = nativeInfo()?.capabilities;
  return Array.isArray(caps) && caps.includes(c);
}

/** True for touch-first devices (primary pointer is coarse). Not reactive — use useIsCoarsePointer() in components. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

// Capability required by each bridge method (getInfo is always allowed).
const METHOD_CAPABILITY: Record<NativeMethod, NativeCapability | null> = {
  saveFile: 'saveFile',
  downloadUrl: 'downloadUrl',
  openExternal: 'openExternal',
  copyText: 'clipboard',
  readClipboard: 'clipboard',
  share: 'share',
  notify: 'notify',
  requestNotificationPermission: 'notify',
  openSettings: 'settings',
  setSystemBars: 'systemBars',
  checkForUpdate: 'update',
  getInfo: null,
};

/**
 * True when `window.ObliNative[method]` can be called: Android shell present,
 * method injected, and its capability advertised.
 */
export function canUseNative(method: NativeMethod): boolean {
  if (!isAndroidApp()) return false;
  const api = window.ObliNative;
  if (!api || typeof api[method] !== 'function') return false;
  const cap = METHOD_CAPABILITY[method];
  return cap === null || hasCapability(cap);
}

function call<M extends NativeMethod>(
  method: M,
  ...args: Parameters<ObliNativeApi[M]>
): ReturnType<ObliNativeApi[M]> {
  if (!canUseNative(method)) {
    return Promise.reject(new NativeUnavailableError(method)) as ReturnType<ObliNativeApi[M]>;
  }
  try {
    const fn = window.ObliNative![method] as unknown as (...a: unknown[]) => unknown;
    return Promise.resolve(fn.apply(window.ObliNative, args)) as ReturnType<ObliNativeApi[M]>;
  } catch (err) {
    return Promise.reject(err) as ReturnType<ObliNativeApi[M]>;
  }
}

/**
 * Typed wrappers around `window.ObliNative`. Every call returns a Promise that
 * rejects with NativeUnavailableError when the bridge/method/capability is
 * absent (never throws synchronously). Check `canUseNative('x')` first when
 * you have a browser fallback.
 */
export const native = {
  saveFile: (filename: string, mime: string, base64: string) => call('saveFile', filename, mime, base64),
  downloadUrl: (url: string, filename?: string) => call('downloadUrl', url, filename),
  openExternal: (url: string) => call('openExternal', url),
  copyText: (text: string) => call('copyText', text),
  readClipboard: () => call('readClipboard'),
  share: (text: string, title?: string) => call('share', text, title),
  notify: (title: string, body: string, navigateTo?: string) => call('notify', title, body, navigateTo),
  openSettings: () => call('openSettings'),
  setSystemBars: (colorHex: string, lightIcons: boolean) => call('setSystemBars', colorHex, lightIcons),
  requestNotificationPermission: () => call('requestNotificationPermission'),
  checkForUpdate: () => call('checkForUpdate'),
  getInfo: () => call('getInfo'),
} as const;

// ── Back button / Escape stack ───────────────────────────────────────────────

/**
 * A back handler. `source` tells whether the Android back button or the
 * Escape key triggered it. Return `false` to let the event fall through to
 * the next handler (and, for back, ultimately to the shell's
 * webView.goBack()); anything else consumes it.
 */
export type BackHandler = (source: 'back' | 'escape') => boolean | void;

export interface BackHandlerOptions {
  /**
   * Also receive the Escape key. Escape walks the stack from the top but only
   * visits Escape-enabled entries (others are transparent to it), so stacked
   * overlays close one at a time. Default false.
   */
  escape?: boolean;
}

interface BackEntry {
  handler: BackHandler;
  escape: boolean;
}

const backStack: BackEntry[] = [];

/**
 * Push a back handler on the stack (most recent wins). Returns the unregister
 * function. Prefer the `useNativeBack()` hook in components. Installs the
 * global dispatchers on first use (idempotent).
 */
export function registerBackHandler(handler: BackHandler, options?: BackHandlerOptions): () => void {
  installBackHandler();
  const entry: BackEntry = { handler, escape: !!options?.escape };
  backStack.push(entry);
  return () => {
    const i = backStack.indexOf(entry);
    if (i >= 0) backStack.splice(i, 1);
  };
}

function runStack(source: 'back' | 'escape'): boolean {
  // Snapshot: a handler may unregister itself (closing a modal) while we iterate.
  const entries = backStack.slice().reverse();
  for (const entry of entries) {
    if (source === 'escape' && !entry.escape) continue;
    let result: boolean | void;
    try {
      result = entry.handler(source);
    } catch (err) {
      console.error(`[obli-native] ${source} handler failed`, err);
      result = true;
    }
    if (result !== false) return true;
  }
  return false;
}

/**
 * Run the back stack from the most recent handler down. Returns true when one
 * consumed the press. This is what `window.__obliHandleBack` calls.
 */
export function handleNativeBack(): boolean {
  return runStack('back');
}

function onEscapeKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  if (runStack('escape')) e.preventDefault();
}

let escapeInstalled = false;
let backInstalled = false;

/**
 * Install the global Escape dispatcher (always) and, only inside the Android
 * shell, `window.__obliHandleBack`. In a browser or the ObliTools iframe the
 * back button is never intercepted. Idempotent.
 */
export function installBackHandler(): void {
  if (typeof window === 'undefined') return;
  if (!escapeInstalled) {
    escapeInstalled = true;
    // Bubble phase on window: React handlers (and inputs/comboboxes that call
    // preventDefault on Escape) run first.
    window.addEventListener('keydown', onEscapeKey);
  }
  if (!backInstalled && isAndroidApp()) {
    backInstalled = true;
    window.__obliHandleBack = handleNativeBack;
    try { document.documentElement.dataset.native = 'android'; } catch { /* ignore */ }
  }
}

// ── Lifecycle events (obli:resume / obli:pause) ──────────────────────────────

/** Subscribe to the shell's `obli:resume` / `obli:pause` events. Returns the unsubscribe fn. */
export function onNativeLifecycle(event: 'resume' | 'pause', cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const name = `obli:${event}`;
  const listener = () => cb();
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}
