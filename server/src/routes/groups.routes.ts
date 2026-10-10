import { Router } from 'express';
import { groupsController } from '../controllers/groups.controller';
import { requireAuth } from '../middleware/auth';
import { requireTenantCapability, requireGroupWrite, requireCanCreate, requireRootGroupOwner } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { requireAction } from '../middleware/stepUp';
import {
  createGroupSchema,
  updateGroupSchema,
  moveGroupSchema,
  reorderGroupsSchema,
} from '../validators/group.schema';

const router = Router();

// All routes require authentication (mounted on the tenant router: req.tenantId is set)
router.use(requireAuth);

// Read routes (visibility filtering / read permission in the controller)
router.get('/', groupsController.list);
router.get('/tree', groupsController.tree);
router.get('/stats', groupsController.stats);
router.get('/:id', groupsController.getById);
router.get('/:id/detail-stats', groupsController.groupDetailStats);
router.get('/:id/probes', groupsController.getGroupProbes);

// Write routes (groups of the current tenant only):
//  - create: admin, a can_create team of the tenant, or the 'groups.manage'
//    tenant capability (requireCanCreate); below the root the controller also
//    requires write permission on the parent. A top-level group needs admin
//    or a can_create team, which owns it (requireRootGroupOwner): created
//    through groups.manage alone, none of the creator's teams could reach it;
//  - reorder (sort order of the tenant's groups): 'groups.manage';
//  - update / move / delete: admin or team RW on the group (requireGroupWrite).
router.post('/', requireCanCreate(), validate(createGroupSchema), requireRootGroupOwner(), groupsController.create);
router.post('/reorder', requireTenantCapability('groups.manage'), validate(reorderGroupsSchema), groupsController.reorder);
router.put('/:id', requireGroupWrite(), validate(updateGroupSchema), groupsController.update);
router.post('/:id/move', requireGroupWrite(), validate(moveGroupSchema), groupsController.move);
router.delete('/:id', requireGroupWrite(), requireAction('group.delete'), groupsController.delete);

export default router;
