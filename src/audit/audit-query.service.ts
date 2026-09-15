import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { type Page } from '../common/pagination/pagination';
import { endOfUtcDayExclusive, startOfUtcDay } from '../common/utils/date-range';
import { type AuditLog } from './audit-log.entity';
import { type ListAuditLogsQuery } from './audit.dto';
import { type AuditRepository } from './audit.repository';

/** Read side of the audit trail (ADMIN only). The trail itself is append-only. */
export class AuditQueryService {
  constructor(private readonly repository: AuditRepository) {}

  list(query: ListAuditLogsQuery): Promise<Page<AuditLog>> {
    return this.repository.findPage(
      {
        ...(query.userId !== undefined ? { userId: query.userId } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.entity ? { entity: query.entity } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.from ? { from: startOfUtcDay(query.from) } : {}),
        ...(query.to ? { to: endOfUtcDayExclusive(query.to) } : {}),
      },
      query.sortOrder,
      { page: query.page, limit: query.limit },
    );
  }

  async getById(id: number): Promise<AuditLog> {
    const entry = await this.repository.findById(String(id));
    if (!entry) throw AppError.notFound('Audit log entry not found', ErrorCode.NOT_FOUND);
    return entry;
  }
}
