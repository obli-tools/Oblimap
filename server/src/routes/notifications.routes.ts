import { Router } from 'express';
import { notificationsController } from '../controllers/notifications.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole, requireTenantCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import {
  createChannelSchema,
  updateChannelSchema,
  addBindingSchema,
  removeBindingSchema,
} from '../validators/notification.schema';

const router = Router();

// Mounted on the tenant router. Channels and bindings of the current tenant:
// 'notifications.manage' tenant capability — platform admins,
// tenant admins and roles granting it. Sharing a channel with OTHER tenants
// spans tenants: platform admins only.
router.use(requireAuth);
router.use(requireTenantCapability('notifications.manage'));

// Plugin info
router.get('/plugins', notificationsController.plugins);

// Channels CRUD
router.get('/channels', notificationsController.listChannels);
router.get('/channels/:id', notificationsController.getChannel);
router.post('/channels', validate(createChannelSchema), notificationsController.createChannel);
router.put('/channels/:id', validate(updateChannelSchema), notificationsController.updateChannel);
router.delete('/channels/:id', notificationsController.deleteChannel);
router.post('/channels/:id/test', notificationsController.testChannel);
router.get('/channels/:id/log', notificationsController.getChannelLog);
router.get('/channels/:id/tenants', requireRole('admin'), notificationsController.getChannelTenants);
router.put('/channels/:id/tenants', requireRole('admin'), notificationsController.setChannelTenants);

// Bindings
router.get('/bindings/resolved', notificationsController.resolvedBindings);
router.get('/bindings', notificationsController.listBindings);
router.post('/bindings', validate(addBindingSchema), notificationsController.addBinding);
router.delete('/bindings', validate(removeBindingSchema), notificationsController.removeBinding);

export default router;
