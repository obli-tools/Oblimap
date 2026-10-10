/**
 * localStorage / sessionStorage access that never throws.
 *
 * Storage can be unavailable or throw: private windows, blocked site data,
 * quota exceeded, the cross-site ObliTools iframe with third-party storage
 * partitioned or denied. Every read returns null and every write is a no-op
 * on failure, so callers keep their in-memory state.
 */

type StorageKind = 'local' | 'session';

function store(kind: StorageKind): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Raw string read (null when missing or unavailable). */
export function storageGet(key: string, kind: StorageKind = 'local'): string | null {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Raw string write. Resolves false when the storage refused it. */
export function storageSet(key: string, value: string, kind: StorageKind = 'local'): boolean {
  try {
    const s = store(kind);
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function storageRemove(key: string, kind: StorageKind = 'local'): void {
  try {
    store(kind)?.removeItem(key);
  } catch {
    /* unavailable */
  }
}

/** JSON read: `fallback` when missing, unavailable or unparsable. */
export function storageGetJson<T>(key: string, fallback: T, kind: StorageKind = 'local'): T {
  const raw = storageGet(key, kind);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** JSON write. Returns false when the value could not be stored. */
export function storageSetJson(key: string, value: unknown, kind: StorageKind = 'local'): boolean {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    return false;
  }
  return storageSet(key, raw, kind);
}
