import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { storageGet, storageSet } from '@/utils/safeStorage';

// useState backed by sessionStorage (ported from Obliance). Survives in-tab
// navigation (React Router route changes, history.back) but resets on tab
// close / new tab: the shape needed for "restore filters when I navigate back
// from a detail page" without carrying state across browser sessions
// (usePersistedState uses localStorage, too sticky for filter state).
//
// Sets serialise as `{ __set: [...] }` so a `new Set()` round-trips
// correctly; everything else goes through plain JSON.stringify.

type Initial<T> = T | (() => T);

function serialise<T>(value: T): unknown {
  if (value instanceof Set) return { __set: Array.from(value) };
  return value;
}

function deserialise<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && '__set' in (raw as Record<string, unknown>)) {
    return new Set((raw as { __set: unknown[] }).__set) as unknown as T;
  }
  return raw as T;
}

function readInitial<T>(initial: Initial<T>): T {
  return typeof initial === 'function' ? (initial as () => T)() : initial;
}

export function useSessionState<T>(key: string, initial: Initial<T>): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const raw = storageGet(key, 'session');
    if (raw !== null) {
      try {
        return deserialise<T>(JSON.parse(raw));
      } catch { /* corrupt entry — fall through to initial */ }
    }
    return readInitial(initial);
  });
  useEffect(() => {
    try {
      storageSet(key, JSON.stringify(serialise(value)), 'session');
    } catch { /* unserialisable value */ }
  }, [key, value]);
  return [value, setValue];
}
