import { Router } from 'express';
import { z } from 'zod';
import { usersController } from '../controllers/users.controller';
import { requireAuth } from '../middleware/auth';
import { requireTenantCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { emailSchema } from '../validators/auth.schema';
import {
  createUserSchema,
  updateUserSchema,
  changePasswordSchema,
  setUserTenantsSchema,
} from '../validators/user.schema';

// Mounted on the tenant router (requireAuth + requireTenant).
// Platform admins keep the full, cross-tenant account administration.
// Holders of the tenant capability users.manage (tenant admins hold it) get
// a surface scoped to the current tenant, limited to the members they
// dominate (services/userScope.service.ts).

const router = Router();

router.use(requireAuth);
router.use(requireTenantCapability('users.manage'));

// Body extensions of the shared user schemas: the tenant role given to the
// new memberships (default 'viewer') and the e-mail address.
const tenantRoleSchema = z.string().trim().min(1).max(64);
export const createUserScopedSchema = createUserSchema.extend({
  email: emailSchema.nullable().optional(),
  tenantRole: tenantRoleSchema.optional(),
});
export const updateUserScopedSchema = updateUserSchema.extend({
  email: z.union([z.literal(''), emailSchema]).nullable().optional(),
});
export type CreateUserScopedInput = z.infer<typeof createUserScopedSchema>;
export type UpdateUserScopedInput = z.infer<typeof updateUserScopedSchema>;

router.get('/', usersController.list);
router.get('/:id', usersController.getById);
router.post('/', validate(createUserScopedSchema), usersController.create);
router.put('/:id', validate(updateUserScopedSchema), usersController.update);
router.patch('/:id', validate(updateUserScopedSchema), usersController.update);
router.put('/:id/password', validate(changePasswordSchema), usersController.changePassword);
router.delete('/:id/2fa', usersController.resetTwoFactor);
router.delete('/:id', usersController.delete);

// What the user may do and see in a tenant
router.get('/:id/effective-access', usersController.effectiveAccess);

// Team membership listing
router.get('/:id/teams', usersController.getTeams);

// Tenant assignment management
router.get('/:id/tenants', usersController.getTenants);
router.put('/:id/tenants', validate(setUserTenantsSchema), usersController.setTenants);

export default router;
