import { created, ok, type HttpResult } from '../common/http/response';
import { type AuthenticatedRequestInput } from '../common/http/route';
import { type Clock } from '../common/utils/clock';
import { type MachinePart } from './machine-part.entity';
import {
  type MachinePartResponse,
  toMachinePartResponse,
  toPartMaintenanceSummary,
} from './machine-part.mapper';
import {
  type CreateMachinePartDto,
  type ListMachinePartsQuery,
  type UpdateMachinePartDto,
} from './machine-parts.dto';
import { type MachinePartsService } from './machine-parts.service';

interface MachineParams {
  readonly machineId: number;
}

interface PartParams extends MachineParams {
  readonly partId: number;
}

export class MachinePartsController {
  constructor(
    private readonly parts: MachinePartsService,
    private readonly clock: Clock,
  ) {}

  async create({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<MachineParams, undefined, CreateMachinePartDto>): Promise<HttpResult> {
    const part = await this.parts.createPart(params.machineId, body, user, meta);
    return created('Machine part created successfully', (await this.respond([part]))[0]);
  }

  async list({
    params,
    query,
  }: AuthenticatedRequestInput<MachineParams, ListMachinePartsQuery>): Promise<HttpResult> {
    const page = await this.parts.listParts(params.machineId, query);
    return ok('Machine parts retrieved', await this.respond(page.items), page.meta);
  }

  async getById({ params }: AuthenticatedRequestInput<PartParams>): Promise<HttpResult> {
    const part = await this.parts.getPart(params.machineId, params.partId);
    return ok('Machine part retrieved', (await this.respond([part]))[0]);
  }

  async update({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<PartParams, undefined, UpdateMachinePartDto>): Promise<HttpResult> {
    const part = await this.parts.updatePart(params.machineId, params.partId, body, user, meta);
    return ok('Machine part updated successfully', (await this.respond([part]))[0]);
  }

  async remove({ params, user, meta }: AuthenticatedRequestInput<PartParams>): Promise<HttpResult> {
    await this.parts.removePart(params.machineId, params.partId, user, meta);
    return ok('Machine part deleted');
  }

  /** Part responses carry each part's next maintenance. */
  private async respond(parts: readonly MachinePart[]): Promise<MachinePartResponse[]> {
    const now = this.clock.now();
    const schedules = await this.parts.nextMaintenanceFor(parts);
    return parts.map((part) =>
      toMachinePartResponse(part, toPartMaintenanceSummary(schedules.get(part.id), now)),
    );
  }
}
