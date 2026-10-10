import { Router } from 'express';
import { teamsController } from '../controllers/teams.controller';
import { requireAuth } from '../middleware/auth';
import { requireTenantCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { requireAction } from '../middleware/stepUp';
import {
  createTeamSchema,
  updateTeamSchema,
  setTeamMembersSchema,
  setTeamPermissionsSchema,
} from '../validators/team.schema';

const router = Router();

// Mounted on the tenant router. Teams of the current tenant (the controller
// answers 404 for another tenant's team): 'users.manage' tenant capability
// (platform admins, tenant admins and roles granting it).
// Teams decide WHERE members may read and write, so users.manage is an
// administrative capability of the tenant.
router.use(requireAuth);
router.use(requireTenantCapability('users.manage'));

// Team CRUD
router.get('/', teamsController.list);
router.get('/:id', teamsController.getById);
router.post('/', validate(createTeamSchema), teamsController.create);
router.put('/:id', validate(updateTeamSchema), teamsController.update);
// Deleting a team drops all its grants: same restriction as editing them.
router.delete('/:id', requireAction('team.permissions_set'), teamsController.delete);

// Members
router.get('/:id/members', teamsController.getMembers);
router.put('/:id/members', validate(setTeamMembersSchema), teamsController.setMembers);

// Permissions
router.get('/:id/permissions', teamsController.getPermissions);
router.put('/:id/permissions', validate(setTeamPermissionsSchema), requireAction('team.permissions_set'), teamsController.setPermissions);
router.delete('/:id/permissions/:permId', requireAction('team.permissions_set'), teamsController.removePermission);

export default router;
