import { z } from 'zod';
import { isoDate, paginationQuery, positiveId, sortOrder } from '../common/validation/primitives';
import { AuditAction, AuditEntity } from './audit.constants';

export const auditActionSchema = z.enum(AuditAction).meta({ id: 'AuditAction' });
export const auditEntitySchema = z.enum(AuditEntity).meta({ id: 'AuditEntity' });

export const auditIdParams = z.object({
  id: z.coerce
    .number({ error: 'must be a positive integer' })
    .int('must be a positive integer')
    .positive('must be a positive integer')
    .max(Number.MAX_SAFE_INTEGER, 'is out of range')
    .meta({ description: 'Audit entry id' }),
});

export const listAuditLogsQuerySchema = paginationQuery
  .extend({
    sortOrder,
    userId: positiveId.optional().meta({ description: 'Acting user' }),
    action: auditActionSchema.optional(),
    entity: auditEntitySchema.optional(),
    entityId: z.string().trim().min(1).max(64).optional(),
    from: isoDate.optional().meta({ description: 'Inclusive start date (UTC) on createdAt' }),
    to: isoDate.optional().meta({ description: 'Inclusive end date (UTC) on createdAt' }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from && value.to && value.from > value.to) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'must be on or after from' });
    }
  });
export type ListAuditLogsQuery = z.output<typeof listAuditLogsQuerySchema>;

export const auditLogResponseSchema = z
  .object({
    id: z.number().int(),
    user: z.object({ id: z.number().int(), fullName: z.string(), email: z.string() }).nullable(),
    action: auditActionSchema,
    entity: auditEntitySchema,
    entityId: z.string().nullable(),
    oldValues: z.record(z.string(), z.unknown()).nullable(),
    newValues: z.record(z.string(), z.unknown()).nullable(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    requestId: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AuditLog' });
