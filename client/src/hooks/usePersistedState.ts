import { useCallback, useState } from 'react';
import { storageGetJson, storageSetJson } from '@/utils/safeStorage';

/**
 * A useState variant backed by localStorage (ported from Obliance). Reads the
 * initial value from storage (falling back to `initial` on miss, parse error
 * or unavailable storage) and writes back on every change. Safe to call with
 * the same key from multiple components — each instance keeps its own
 * in-memory copy, but persists to the same slot.
 */
export function usePersistedState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => storageGetJson<T>(key, initial));
  const set = useCallback((v: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      storageSetJson(key, next);
      return next;
    });
  }, [key]);
  return [value, set];
}
