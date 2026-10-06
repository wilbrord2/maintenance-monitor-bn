import { created, ok, type HttpResult } from '../common/http/response';
import { type AuthenticatedRequestInput } from '../common/http/route';
import { mapPage } from '../common/pagination/pagination';
import { type Clock } from '../common/utils/clock';
import {
  type CancelMaintenanceEventDto,
  type CompleteMaintenanceEventDto,
  type CreateMaintenanceEventDto,
  type CreateMaintenanceScheduleDto,
  type ListMaintenanceEventsQuery,
  type MaintenanceDashboardQuery,
  type StartMaintenanceEventDto,
  type UpdateMaintenanceEventDto,
  type UpdateMaintenanceScheduleDto,
} from './maintenance.dto';
import { toMaintenanceEventResponse, toMaintenanceScheduleResponse } from './maintenance.mapper';
import { type MaintenanceService } from './maintenance.service';

interface MachineParams {
  readonly machineId: number;
}

interface IdParams {
  readonly id: number;
}

export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly clock: Clock,
  ) {}

  async createSchedule({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<MachineParams, undefined, CreateMaintenanceScheduleDto>): Promise<HttpResult> {
    const schedule = await this.maintenance.createSchedule(params.machineId, body, user, meta);
    return created(
      'Maintenance schedule created successfully',
      toMaintenanceScheduleResponse(schedule, this.clock.now()),
    );
  }

  async getSchedule({ params }: AuthenticatedRequestInput<MachineParams>): Promise<HttpResult> {
    const schedule = await this.maintenance.getSchedule(params.machineId);
    return ok('Maintenance schedule retrieved', toMaintenanceScheduleResponse(schedule, this.clock.now()));
  }

  async updateSchedule({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<MachineParams, undefined, UpdateMaintenanceScheduleDto>): Promise<HttpResult> {
    const schedule = await this.maintenance.updateSchedule(params.machineId, body, user, meta);
    return ok(
      'Maintenance schedule updated successfully',
      toMaintenanceScheduleResponse(schedule, this.clock.now()),
    );
  }

  async upcoming({
    query,
  }: AuthenticatedRequestInput<undefined, MaintenanceDashboardQuery>): Promise<HttpResult> {
    return this.dashboard('upcoming', query, 'Upcoming maintenance retrieved');
  }

  async due({ query }: AuthenticatedRequestInput<undefined, MaintenanceDashboardQuery>): Promise<HttpResult> {
    return this.dashboard('due', query, 'Maintenance due today retrieved');
  }

  async overdue({
    query,
  }: AuthenticatedRequestInput<undefined, MaintenanceDashboardQuery>): Promise<HttpResult> {
    return this.dashboard('overdue', query, 'Overdue maintenance retrieved');
  }

  async createEvent({
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<undefined, undefined, CreateMaintenanceEventDto>): Promise<HttpResult> {
    const event = await this.maintenance.createEvent(body, user, meta);
    return created('Maintenance event created successfully', toMaintenanceEventResponse(event));
  }

  async listEvents({
    query,
  }: AuthenticatedRequestInput<undefined, ListMaintenanceEventsQuery>): Promise<HttpResult> {
    const page = mapPage(await this.maintenance.listEvents(query), toMaintenanceEventResponse);
    return ok('Maintenance events retrieved', page.items, page.meta);
  }

  async getEvent({ params }: AuthenticatedRequestInput<IdParams>): Promise<HttpResult> {
    return ok(
      'Maintenance event retrieved',
      toMaintenanceEventResponse(await this.maintenance.getEvent(params.id)),
    );
  }

  async updateEvent({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<IdParams, undefined, UpdateMaintenanceEventDto>): Promise<HttpResult> {
    const event = await this.maintenance.updateEvent(params.id, body, user, meta);
    return ok('Maintenance event updated successfully', toMaintenanceEventResponse(event));
  }

  async startEvent({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<IdParams, undefined, StartMaintenanceEventDto>): Promise<HttpResult> {
    const event = await this.maintenance.startEvent(params.id, body, user, meta);
    return ok('Maintenance started', toMaintenanceEventResponse(event));
  }

  async completeEvent({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<IdParams, undefined, CompleteMaintenanceEventDto>): Promise<HttpResult> {
    const event = await this.maintenance.completeEvent(params.id, body, user, meta);
    return ok('Maintenance completed', toMaintenanceEventResponse(event));
  }

  async cancelEvent({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<IdParams, undefined, CancelMaintenanceEventDto>): Promise<HttpResult> {
    const event = await this.maintenance.cancelEvent(params.id, body, user, meta);
    return ok('Maintenance event cancelled', toMaintenanceEventResponse(event));
  }

  private async dashboard(
    state: 'upcoming' | 'due' | 'overdue',
    query: MaintenanceDashboardQuery,
    message: string,
  ): Promise<HttpResult> {
    const now = this.clock.now();
    const page = mapPage(await this.maintenance.schedulesByState(state, query), (schedule) =>
      toMaintenanceScheduleResponse(schedule, now),
    );
    return ok(message, page.items, page.meta);
  }
}
