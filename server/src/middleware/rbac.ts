import type { Request, Response, NextFunction } from 'express';
import type { UserRole } from '@oblimap/shared';
import { AppError } from './errorHandler';
import { permissionService } from '../services/permission.service';
import type { TenantCapability } from '../services/permissionSet.service';
import { toDbId } from '../utils/dbId';
import { requireAuth } from './auth';
import { requireTenant } from './tenant';

// ── Gate metadata ─────────────────────────────────────────────────
// Every gate middleware carries a non-enumerable description of what it
// checks, read by the route-gate matrix test (tests/unit/rbac) to compare
// each route of the API with its declared gates. Pure metadata: it changes
// nothing in how a request is handled.

/** What a gate middleware checks. */
export type GateMeta =
  | { kind: 'auth' }
  | { kind: 'tenant' }
  | { kind: 'role'; roles: readonly UserRole[] }
  | { kind: 'capability'; mode: 'all' | 'any'; caps: readonly TenantCapability[] }
  | { kind: 'capabilityInResourceTenant'; caps: readonly TenantCapability[] }
  | { kind: 'siteRead'; param: string }
  | { kind: 'siteWrite'; param: string }
  | { kind: 'groupWrite'; param: string }
  | { kind: 'canCreate' }
  | { kind: 'rootGroupOwner' }
  | { kind: 'stepUp'; action?: string }
  | { kind: 'probeAuth'; requireApproved?: boolean; requireSite?: boolean };

/** Property under which a gate middleware carries its GateMeta. */
export const GATE_META_KEY = '__gate';

/** Attaches `meta` to the gate middleware `fn` (non-enumerable, read-only) and returns `fn`. */
export function tagGate<F extends (...args: never[]) => unknown>(fn: F, meta: GateMeta): F {
  if (!Object.prototype.hasOwnProperty.call(fn, GATE_META_KEY)) {
    Object.defineProperty(fn, GATE_META_KEY, { value: Object.freeze({ ...meta }), enumerable: false });
  }
  return fn;
}

/** The GateMeta of a middleware, or undefined when it is not a tagged gate. */
export function gateMetaOf(fn: unknown): GateMeta | undefined {
  if (typeof fn !== 'function') return undefined;
  return (fn as unknown as Record<string, GateMeta | undefined>)[GATE_META_KEY];
}

// requireAuth / requireTenant are plain middlewares of their own modules,
// tagged here so every gate is described in one place.
tagGate(requireAuth, { kind: 'auth' });
tagGate(requireTenant, { kind: 'tenant' });

/**
 * Platform role gate (users.role). Only for platform functions — tenants,
 * users, app config, MAC vendors, system, permission sets, cross-tenant
 * views. Work inside a tenant uses requireTenantCapability (below) and the
 * group / site gates.
 */
export function requireRole(...roles: UserRole[]) {
  return tagGate((req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      next(new AppError(401, 'Authentication required'));
      return;
    }

    if (!roles.includes(req.session.role as UserRole)) {
      next(new AppError(403, 'Insufficient permissions'));
      return;
    }

    next();
  }, { kind: 'role', roles: [...roles] });
}

// Group / site permission gates. They run after
// requireAuth + requireTenant (tenant router). Order of the checks:
//  1. the id is a strict positive integer (400 otherwise);
//  2. the group / site belongs to req.tenantId — for everyone, platform
//     admins included (404 otherwise, so another tenant's ids leak nothing);
//  3. platform admins pass; tenant admins and team members through
//     permissionService (403 otherwise).

interface TenantContext {
  userId: number;
  tenantId: number;
  isPlatformAdmin: boolean;
}

function tenantContext(req: Request): TenantContext | AppError {
  const userId = toDbId(req.session?.userId);
  if (userId === null) return new AppError(401, 'Authentication required');
  const tenantId = toDbId(req.tenantId);
  if (tenantId === null) return new AppError(403, 'no_tenant_access');
  return { userId, tenantId, isPlatformAdmin: req.session.role === 'admin' };
}

/**
 * Require write permission on a group of the current tenant
 * (id from req.params[paramName], default 'id').
 */
export function requireGroupWrite(paramName = 'id') {
  return tagGate(async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = tenantContext(req);
      if (ctx instanceof AppError) return next(ctx);
      const groupId = toDbId(req.params[paramName]);
      if (groupId === null) return next(new AppError(400, 'Invalid group ID'));
      if (!(await permissionService.findGroup(groupId, ctx.tenantId))) {
        return next(new AppError(404, 'Group not found'));
      }
      if (ctx.isPlatformAdmin) return next();
      const canWrite = await permissionService.canWriteGroup(ctx.userId, groupId, ctx.tenantId, false);
      if (!canWrite) return next(new AppError(403, 'Insufficient permissions'));
      next();
    } catch (err) {
      next(err);
    }
  }, { kind: 'groupWrite', param: paramName });
}

function requireSiteLevel(level: 'read' | 'write', paramName: string) {
  return tagGate(async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = tenantContext(req);
      if (ctx instanceof AppError) return next(ctx);
      const siteId = toDbId(req.params[paramName]);
      if (siteId === null) return next(new AppError(400, 'Invalid site ID'));
      if (!(await permissionService.findSite(siteId, ctx.tenantId))) {
        return next(new AppError(404, 'Site not found'));
      }
      if (ctx.isPlatformAdmin) return next();
      const perm = await permissionService.getSitePermission(ctx.userId, siteId, ctx.tenantId, false);
      const allowed = level === 'write' ? perm === 'rw' : perm !== null;
      if (!allowed) return next(new AppError(403, 'Insufficient permissions'));
      next();
    } catch (err) {
      next(err);
    }
  }, { kind: level === 'write' ? 'siteWrite' : 'siteRead', param: paramName });
}

/**
 * Require read permission on a site of the current tenant
 * (id from req.params[paramName], default 'id').
 */
export function requireSiteRead(paramName = 'id') {
  return requireSiteLevel('read', paramName);
}

/**
 * Require write permission on a site of the current tenant
 * (id from req.params[paramName], default 'id').
 */
export function requireSiteWrite(paramName = 'id') {
  return requireSiteLevel('write', paramName);
}

// ── Tenant capabilities ───────────────────────────────────────
// Port of Obliance rbac.ts requireTenantCapability / requireAnyTenantCapability.
// WHAT the user may do in the current tenant: their tenant role
// (user_tenants.role, a permission set slug) must grant the capability —
// permissionService.userHasTenantCapability, cached 10 s. A set grants its
// capabilities plus the ones they imply (shared CAPABILITY_IMPLIES, e.g.
// probes.manage → probes.approve → probes.read): a gate on a narrower
// capability lets the broader holders through. Platform admins
// and tenant admins hold every capability. WHERE stays with the group / site
// gates above, which routes still chain when the action targets one group or
// site. Run after requireAuth + requireTenant (tenant router).
// Refusal: 403 { success: false, error: 'forbidden', capability }.

function forbidden(res: Response, capability: TenantCapability | readonly TenantCapability[]): void {
  res.status(403).json({ success: false, error: 'forbidden', capability });
}

function capabilityGate(capabilities: readonly TenantCapability[], mode: 'all' | 'any') {
  return tagGate(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = tenantContext(req);
      if (ctx instanceof AppError) return next(ctx);
      if (ctx.isPlatformAdmin) return next();
      const held = new Set(await permissionService.listUserTenantCapabilities(ctx.userId, ctx.tenantId));
      if (mode === 'any') {
        if (capabilities.some((c) => held.has(c))) return next();
        return forbidden(res, capabilities.length === 1 ? capabilities[0] : capabilities);
      }
      const missing = capabilities.find((c) => !held.has(c));
      if (missing === undefined) return next();
      forbidden(res, missing);
    } catch (err) {
      next(err);
    }
  }, { kind: 'capability', mode, caps: [...capabilities] });
}

/** Require one tenant capability in the current tenant. */
export function requireTenantCapability(capability: TenantCapability) {
  return capabilityGate([capability], 'all');
}

/** Require at least one of the tenant capabilities in the current tenant. */
export function requireAnyTenantCapability(capabilities: readonly TenantCapability[]) {
  if (capabilities.length === 0) throw new Error('requireAnyTenantCapability: no capability given');
  return capabilityGate(capabilities, 'any');
}

/** Require every one of the tenant capabilities in the current tenant. */
export function requireAllTenantCapabilities(capabilities: readonly TenantCapability[]) {
  if (capabilities.length === 0) throw new Error('requireAllTenantCapabilities: no capability given');
  return capabilityGate(capabilities, 'all');
}

/**
 * requireTenantCapability for a route acting, by id, on a resource that may
 * belong to another tenant than the session's (e.g. DELETE /live-alerts/:id):
 * the capability is checked in the resource's tenant, resolved by `tenantOf`
 * among the tenants the user may access. When `tenantOf` answers null (no
 * such resource for this user) the request goes on and the handler answers
 * 400 / 404 itself. Runs after requireAuth.
 */
export function requireCapabilityInResourceTenant(
  capability: TenantCapability,
  tenantOf: (req: Request, userId: number) => Promise<number | null>,
) {
  return tagGate(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = toDbId(req.session?.userId);
      if (userId === null) return next(new AppError(401, 'Authentication required'));
      if (req.session.role === 'admin') return next();
      const tenantId = await tenantOf(req, userId);
      if (tenantId === null) return next();
      if (await permissionService.userHasTenantCapability(userId, tenantId, capability)) return next();
      forbidden(res, capability);
    } catch (err) {
      next(err);
    }
  }, { kind: 'capabilityInResourceTenant', caps: [capability] });
}

/**
 * Require canCreate permission in the current tenant (creating groups):
 * full access, a team of the tenant with can_create, or groups.manage.
 * Chain requireRootGroupOwner after the body validation.
 */
export function requireCanCreate() {
  return tagGate(async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = tenantContext(req);
      if (ctx instanceof AppError) return next(ctx);
      if (ctx.isPlatformAdmin) return next();
      const canCreate = await permissionService.canCreate(ctx.userId, ctx.tenantId, false);
      if (!canCreate) return next(new AppError(403, 'Insufficient permissions'));
      next();
    } catch (err) {
      next(err);
    }
  }, { kind: 'canCreate' });
}

/**
 * Creating a top-level group (validated body without parentId): full access
 * or a can_create team of the tenant, which will own it
 * (permissionService.canCreateRootGroup). groups.manage alone only creates
 * sub-groups, below a group the user can write (checked by the controller).
 */
export function requireRootGroupOwner() {
  return tagGate(async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = tenantContext(req);
      if (ctx instanceof AppError) return next(ctx);
      const parentId = (req.body as { parentId?: number | null } | undefined)?.parentId;
      if (ctx.isPlatformAdmin || (parentId !== undefined && parentId !== null)) return next();
      if (!(await permissionService.canCreateRootGroup(ctx.userId, ctx.tenantId, false))) {
        return next(new AppError(403, 'A top-level group needs a team allowed to create groups: that team owns it'));
      }
      next();
    } catch (err) {
      next(err);
    }
  }, { kind: 'rootGroupOwner' });
}
