import apiClient from './client';
import type { ApiResponse } from '@oblimap/shared';

export interface TwoFactorStatus {
  totpEnabled: boolean;
  emailOtpEnabled: boolean;
  email: string | null;
}

export interface TotpSetupData {
  secret: string;
  qrDataUrl: string;
}

/**
 * Proof for managing a second factor: a current code of the authenticator app
 * (required to replace or remove it), or the current password (first
 * authenticator app; e-mail codes when no authenticator app is set up).
 */
export interface FactorProof {
  currentCode?: string;
  currentPassword?: string;
}

export const twoFactorApi = {
  async getStatus(): Promise<TwoFactorStatus> {
    const res = await apiClient.get<ApiResponse<TwoFactorStatus>>('/profile/2fa/status');
    return res.data.data!;
  },

  /** First setup: the current password. Replacing a live authenticator app: its current code. */
  async totpSetup(proof: FactorProof): Promise<TotpSetupData> {
    const res = await apiClient.post<ApiResponse<TotpSetupData>>('/profile/2fa/totp/setup', proof);
    return res.data.data!;
  },

  async totpEnable(code: string): Promise<void> {
    await apiClient.post('/profile/2fa/totp/enable', { code });
  },

  async totpDisable(currentCode: string): Promise<void> {
    await apiClient.delete('/profile/2fa/totp', { data: { currentCode } });
  },

  /** Sends a code to the e-mail address of the profile (never another one). */
  async emailSetup(proof: FactorProof): Promise<void> {
    await apiClient.post('/profile/2fa/email/setup', proof);
  },

  async emailEnable(code: string): Promise<void> {
    await apiClient.post('/profile/2fa/email/enable', { code });
  },

  async emailDisable(proof: FactorProof): Promise<void> {
    await apiClient.delete('/profile/2fa/email', { data: proof });
  },

  async verify(code: string, method: 'totp' | 'email'): Promise<{ user: unknown }> {
    const res = await apiClient.post<ApiResponse<{ user: unknown }>>('/profile/2fa/verify', { code, method });
    return res.data.data!;
  },

  async resendEmail(): Promise<void> {
    await apiClient.post('/profile/2fa/resend-email');
  },
};
