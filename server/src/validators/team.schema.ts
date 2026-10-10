import { z } from 'zod';

/** Team permission scopes (the legacy Obliview 'monitor' scope is gone). */
export const TEAM_PERMISSION_SCOPES = ['group', 'site'] as const;
export type TeamPermissionScope = (typeof TEAM_PERMISSION_SCOPES)[number];

const dbIdSchema = z.number().int().positive().max(2_147_483_647);

// Teams are mono-tenant: a team is always created in the session's tenant
// (req.tenantId). A body `tenantId` is stripped like any unknown key (the
// controller used to read it after this schema had removed it).
// user_teams.name is varchar(128).
export const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(1000).nullable().optional(),
  canCreate: z.boolean().optional(),
});

export const updateTeamSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(1000).nullable().optional(),
  canCreate: z.boolean().optional(),
});

export const setTeamMembersSchema = z.object({
  userIds: z.array(dbIdSchema).max(5000),
});

export const setTeamPermissionsSchema = z.object({
  permissions: z.array(
    z.object({
      scope: z.enum(TEAM_PERMISSION_SCOPES),
      scopeId: dbIdSchema,
      level: z.enum(['ro', 'rw']),
    }),
  ).max(5000),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type SetTeamMembersInput = z.infer<typeof setTeamMembersSchema>;
export type SetTeamPermissionsInput = z.infer<typeof setTeamPermissionsSchema>;
