import apiClient from './client';
import type { AxiosResponse } from 'axios';

/**
 * Per-tenant action restrictions and the 2FA step-up (server
 * routes/tenant.routes.ts /tenant/restrictions and middleware/stepUp.ts).
 */

/** Keys of server restriction.service ACTION_KEYS, in display order. */
export const RESTRICTION_ACTION_KEYS = [
  'tunnel.open',
  'device_check.credentials_set',
  'device_check.rule_enable',
  'probe.command.uninstall',
  'probe.delete',
  'probe.key_create',
  'probe.key_delete',
  'site.delete',
  'site.subnet_delete',
  'group.delete',
  'team.permissions_set',
] as const;

export type RestrictionActionKey = typeof RESTRICTION_ACTION_KEYS[number];
export type RestrictionLevel = 'none' | 'sensitive';

export interface RestrictionEntry {
  key: string;
  level: RestrictionLevel;
}

export type StepUpMethod = 'totp' | 'email';

/**
 * Window event dispatched (CustomEvent<StepUpPromptDetail>) when a request is
 * refused for a step-up: the dialog opens (step_up_required) or a refusal
 * toast is shown. A caller that opened a blank popup before its request
 * (TunnelDialog) listens to it to close the popup, so the dialog in this tab
 * is not hidden behind it.
 */
export const STEP_UP_PROMPT_EVENT = 'oblimap:step-up-prompt';

export interface StepUpPromptDetail {
  code: 'step_up_required' | 'step_up_unavailable_sso' | 'step_up_setup_required';
  action: string;
}

function actionsOf(r: AxiosResponse): RestrictionEntry[] {
  return (r.data as { data: { actions: RestrictionEntry[] } }).data.actions;
}

export const restrictionsApi = {
  /** The current tenant's matrix (tenant admins and platform admins). */
  get: (): Promise<RestrictionEntry[]> =>
    apiClient.get('/tenant/restrictions').then(actionsOf),

  /** Replaces the matrix (keys left out become 'none'). */
  save: (levels: Record<string, RestrictionLevel>): Promise<RestrictionEntry[]> =>
    apiClient.put('/tenant/restrictions', { restrictions: levels }).then(actionsOf),
};

export const stepUpApi = {
  /** Proves a second factor; the session may run sensitive actions for 5 minutes. */
  verify: (method: StepUpMethod, code: string): Promise<{ expiresAt: string }> =>
    apiClient.post('/auth/step-up', { method, code })
      .then((r: AxiosResponse) => (r.data as { data: { expiresAt: string } }).data),

  /** Mails a step-up code to the account's address (masked address answered). */
  sendEmail: (): Promise<{ sentTo: string }> =>
    apiClient.post('/auth/step-up/email', {})
      .then((r: AxiosResponse) => (r.data as { data: { sentTo: string } }).data),
};
