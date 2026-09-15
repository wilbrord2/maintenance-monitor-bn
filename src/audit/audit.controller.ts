import { type HttpResult, ok } from '../common/http/response';
import { type AuthenticatedRequestInput } from '../common/http/route';
import { mapPage } from '../common/pagination/pagination';
import { toAuditLogResponse } from './audit-log.mapper';
import { type AuditQueryService } from './audit-query.service';
import { type ListAuditLogsQuery } from './audit.dto';

export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  async list({ query }: AuthenticatedRequestInput<undefined, ListAuditLogsQuery>): Promise<HttpResult> {
    const page = mapPage(await this.audit.list(query), toAuditLogResponse);
    return ok('Audit logs retrieved', page.items, page.meta);
  }

  async getById({ params }: AuthenticatedRequestInput<{ readonly id: number }>): Promise<HttpResult> {
    return ok('Audit log retrieved', toAuditLogResponse(await this.audit.getById(params.id)));
  }
}
