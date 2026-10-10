import { z } from 'zod';

export const createChannelSchema = z.object({
  name: z.string().min(1).max(128),
  type: z.string().min(1).max(50),
  config: z.record(z.unknown()),
  isEnabled: z.boolean().optional(),
});

export const updateChannelSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  config: z.record(z.unknown()).optional(),
  isEnabled: z.boolean().optional(),
});

// IPAM binding scopes (Global → Group chain → Site). The global scope has no
// scopeId; a group / site binding always has one.
const dbId = z.number().int().positive().max(2_147_483_647);

const bindingTarget = {
  channelId: dbId,
  scope: z.enum(['global', 'group', 'site']),
  scopeId: dbId.nullable(),
};

function scopeIdMatchesScope(b: { scope: string; scopeId: number | null }): boolean {
  return (b.scope === 'global') === (b.scopeId === null);
}

const scopeIdIssue = {
  message: 'scopeId must be null for the global scope and set for a group or site',
  path: ['scopeId'],
};

export const addBindingSchema = z.object({
  ...bindingTarget,
  overrideMode: z.enum(['merge', 'replace', 'exclude']).optional(),
}).refine(scopeIdMatchesScope, scopeIdIssue);

export const removeBindingSchema = z.object(bindingTarget).refine(scopeIdMatchesScope, scopeIdIssue);

export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;
export type AddBindingInput = z.infer<typeof addBindingSchema>;
export type RemoveBindingInput = z.infer<typeof removeBindingSchema>;
