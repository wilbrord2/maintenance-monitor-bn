import { type AuditLog, type AuditValues } from './audit-log.entity';
import { type AuditAction, type AuditEntity } from './audit.constants';

export interface AuditLogResponse {
  readonly id: number;
  readonly user: { readonly id: number; readonly fullName: string; readonly email: string } | null;
  readonly action: AuditAction;
  readonly entity: AuditEntity;
  readonly entityId: string | null;
  readonly oldValues: AuditValues | null;
  readonly newValues: AuditValues | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly createdAt: string;
}

export function toAuditLogResponse(entry: AuditLog): AuditLogResponse {
  return {
    id: Number(entry.id),
    user: entry.user ? { id: entry.user.id, fullName: entry.user.fullName, email: entry.user.email } : null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    oldValues: entry.oldValues,
    newValues: entry.newValues,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    requestId: entry.requestId,
    createdAt: entry.createdAt.toISOString(),
  };
}
