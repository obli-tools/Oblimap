import { z } from 'zod';
import { passwordSchema } from './password';

const dbIdSchema = z.number().int().positive().max(2_147_483_647);

export const createUserSchema = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'Only letters, numbers, _, ., -'),
  password: passwordSchema,
  displayName: z.string().max(128).nullable().optional(),
  role: z.enum(['admin', 'user']).optional(),
  // Tenants the new user joins (as 'viewer' unless the scoped schema of
  // users.routes.ts carries a tenantRole). Absent: the current tenant, so
  // no account is ever created without a tenant.
  tenantIds: z.array(dbIdSchema).min(1).max(500).optional(),
});

export const updateUserSchema = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'Only letters, numbers, _, ., -').optional(),
  displayName: z.string().max(128).nullable().optional(),
  role: z.enum(['admin', 'user']).optional(),
  isActive: z.boolean().optional(),
});

export const changePasswordSchema = z.object({
  password: passwordSchema,
});

export const setGroupAssignmentsSchema = z.object({
  groupIds: z.array(z.number().int().positive()),
});

// PUT /api/users/:id/tenants — replaces every membership of the user.
export const setUserTenantsSchema = z.object({
  assignments: z.array(z.object({
    tenantId: dbIdSchema,
    // 'admin', legacy 'member' or a permission set slug; the service checks
    // the slug exists inside its transaction (lockAssignableTenantRole).
    role: z.string().trim().min(1).max(64),
  })).max(500),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type SetGroupAssignmentsInput = z.infer<typeof setGroupAssignmentsSchema>;
export type SetUserTenantsInput = z.infer<typeof setUserTenantsSchema>;
