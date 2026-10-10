import { useAuthStore } from '../store/authStore';

function isAnonymous(): boolean {
  return useAuthStore.getState().user?.preferences?.anonymousMode === true;
}

/**
 * Mask sensitive text when anonymous mode is enabled.
 * Returns the original text unchanged when anonymous mode is off.
 *
 * @param text  The text to anonymize (hostname, IP, MAC, username, etc.)
 * @param kind  Optional hint for smarter masking
 */
export function anonymize(
  text: string | null | undefined,
  kind?: 'ip' | 'mac' | 'hostname' | 'username' | 'path',
): string {
  if (!text) return text ?? '';
  if (!isAnonymous()) return text;

  switch (kind) {
    case 'ip': {
      // 192.168.1.42 → 192.168.•••.•••
      const parts = text.split('.');
      if (parts.length === 4) return `${parts[0]}.${parts[1]}.${'•••'}.${'•••'}`;
      // IPv6 or other — mask last half
      return text.slice(0, Math.ceil(text.length / 2)) + '•'.repeat(Math.floor(text.length / 2));
    }
    case 'mac': {
      // AA:BB:CC:DD:EE:FF → AA:BB:CC:••:••:••
      const segs = text.split(':');
      if (segs.length === 6) return segs.slice(0, 3).join(':') + ':••:••:••';
      return '••:••:••:••:••:••';
    }
    case 'username':
      // og_johndoe → og_j•••••••
      if (text.length <= 2) return '••';
      return text.slice(0, Math.min(3, text.length)) + '•'.repeat(Math.max(text.length - 3, 3));
    case 'hostname':
      // srv-prod-01 → srv-••••••
      if (text.length <= 3) return '•'.repeat(text.length);
      return text.slice(0, 3) + '•'.repeat(Math.max(text.length - 3, 3));
    case 'path':
      return '•••/•••';
    default:
      // Generic: keep first 2 chars, mask the rest
      if (text.length <= 2) return '•'.repeat(text.length);
      return text.slice(0, 2) + '•'.repeat(Math.max(text.length - 2, 3));
  }
}

/**
 * React hook that returns the anonymize function.
 * Re-renders when anonymous mode changes (via store subscription).
 */
export function useAnonymize() {
  // Subscribe to the specific preferences value so components re-render on toggle
  const anonMode = useAuthStore((s) => s.user?.preferences?.anonymousMode === true);
  return { anonymize, isAnonymous: anonMode };
}
