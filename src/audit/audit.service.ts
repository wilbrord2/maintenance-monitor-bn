import { type EntityManager } from 'typeorm';
import { type RequestMeta } from '../common/http/request-meta';
import { type AuditValues } from './audit-log.entity';
import { type AuditAction, type AuditEntity } from './audit.constants';
import { type AuditRepository } from './audit.repository';
import { sanitizeAuditValues } from './audit-sanitizer';

export interface AuditEntry {
  readonly action: AuditAction;
  readonly entity: AuditEntity;
  readonly entityId?: string | number | null;
  /** The user performing the action; null for anonymous events such as failed logins. */
  readonly actorId: number | null;
  readonly oldValues?: AuditValues | null;
  readonly newValues?: AuditValues | null;
  readonly meta: RequestMeta;
}

/**
 * Writes audit entries. Pass the transaction's EntityManager so the entry is
 * committed (or rolled back) atomically with the change it describes.
 */
export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  async record(entry: AuditEntry, manager?: EntityManager): Promise<void> {
    await this.repository.insert(
      {
        userId: entry.actorId,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
        oldValues: sanitizeAuditValues(entry.oldValues),
        newValues: sanitizeAuditValues(entry.newValues),
        ipAddress: entry.meta.ipAddress,
        userAgent: entry.meta.userAgent,
        requestId: entry.meta.requestId,
      },
      manager,
    );
  }
}
