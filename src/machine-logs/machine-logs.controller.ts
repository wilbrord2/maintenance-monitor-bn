import { type HttpResult, created, ok } from '../common/http/response';
import { type AuthenticatedRequestInput } from '../common/http/route';
import { mapPage } from '../common/pagination/pagination';
import { toMachineLogResponse } from './machine-log.mapper';
import {
  type CreateMachineLogDto,
  type ListMachineLogsQuery,
  type MachineHistoryQuery,
  type UpdateMachineLogDto,
} from './machine-logs.dto';
import { type MachineLogsService } from './machine-logs.service';
import { type MachineLogRulesConfig } from './policies/machine-log-rules.policy';

interface IdParams {
  readonly id: number;
}

export class MachineLogsController {
  constructor(
    private readonly logs: MachineLogsService,
    private readonly rulesConfig: MachineLogRulesConfig,
  ) {}

  async create({
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<undefined, undefined, CreateMachineLogDto>): Promise<HttpResult> {
    const log = await this.logs.create(body, user, meta);
    return created('Machine log created successfully', toMachineLogResponse(log));
  }

  async list({ query }: AuthenticatedRequestInput<undefined, ListMachineLogsQuery>): Promise<HttpResult> {
    const page = mapPage(await this.logs.list(query), toMachineLogResponse);
    return ok('Machine logs retrieved', page.items, page.meta);
  }

  async getById({ params }: AuthenticatedRequestInput<IdParams>): Promise<HttpResult> {
    return ok('Machine log retrieved', toMachineLogResponse(await this.logs.getById(params.id)));
  }

  async update({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<IdParams, undefined, UpdateMachineLogDto>): Promise<HttpResult> {
    const log = await this.logs.update(params.id, body, user, meta);
    return ok('Machine log updated successfully', toMachineLogResponse(log));
  }

  async remove({ params, user, meta }: AuthenticatedRequestInput<IdParams>): Promise<HttpResult> {
    await this.logs.remove(params.id, user, meta);
    return ok('Machine log deleted');
  }

  async history({
    params,
    query,
  }: AuthenticatedRequestInput<IdParams, MachineHistoryQuery>): Promise<HttpResult> {
    const page = mapPage(await this.logs.history(params.id, query), toMachineLogResponse);
    return ok('Machine history retrieved', page.items, page.meta);
  }

  stateTransitions(): Promise<HttpResult> {
    return Promise.resolve(
      ok('Machine state transition rules', {
        ...this.logs.describeRules(),
        statesRequiringOpenLog: this.rulesConfig.statesRequiringOpenLog,
      }),
    );
  }
}
