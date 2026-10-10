import { z } from 'zod';

const dbIdSchema = z.number().int().positive().max(2_147_483_647);

// monitor_groups.name is varchar(128).
export const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2000).nullable().optional(),
  parentId: dbIdSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(2_147_483_647).optional(),
  isGeneral: z.boolean().optional(),
  groupNotifications: z.boolean().optional(),
  kind: z.enum(['monitor', 'agent']).optional(),
});

export const updateGroupSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(2000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(2_147_483_647).optional(),
  isGeneral: z.boolean().optional(),
  groupNotifications: z.boolean().optional(),
});

export const moveGroupSchema = z.object({
  newParentId: dbIdSchema.nullable(),
});

export const reorderGroupsSchema = z.object({
  items: z.array(z.object({
    id: dbIdSchema,
    sortOrder: z.number().int().min(0).max(2_147_483_647),
  })).min(1).max(5000),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type MoveGroupInput = z.infer<typeof moveGroupSchema>;
export type ReorderGroupsInput = z.infer<typeof reorderGroupsSchema>;
