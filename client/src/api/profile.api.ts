import apiClient from './client';
import type { User, UserPreferences } from '@oblimap/shared';

export interface ProfileUpdate {
  displayName?: string | null;
  /** Changing (or removing) the e-mail address requires currentPassword — or, for an account without a local password, currentCode. */
  email?: string | null;
  preferredLanguage?: string;
  preferences?: UserPreferences | null;
  currentPassword?: string;
  currentCode?: string;
}

export const profileApi = {
  async get(): Promise<User> {
    const res = await apiClient.get('/profile');
    return res.data.data;
  },

  async update(data: ProfileUpdate): Promise<User> {
    const res = await apiClient.put('/profile', data);
    return res.data.data;
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await apiClient.put('/profile/password', { currentPassword, newPassword });
  },

  /** First local password of an account that has none, during enrollment only (403 'use_profile_password' otherwise). */
  async setLocalPassword(password: string): Promise<void> {
    await apiClient.post('/auth/set-password', { password });
  },

  /** Signs out every other session of the account. Returns how many were ended. */
  async revokeOtherSessions(): Promise<number> {
    const res = await apiClient.post('/profile/sessions/revoke-others');
    return res.data.data?.revoked ?? 0;
  },
};
