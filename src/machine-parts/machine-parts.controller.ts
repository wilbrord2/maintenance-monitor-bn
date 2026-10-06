import { created, ok, type HttpResult } from '../common/http/response';
import { type AuthenticatedRequestInput } from '../common/http/route';
import { mapPage } from '../common/pagination/pagination';
import { toMachinePartResponse } from './machine-part.mapper';
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
  constructor(private readonly parts: MachinePartsService) {}

  async create({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<MachineParams, undefined, CreateMachinePartDto>): Promise<HttpResult> {
    const part = await this.parts.createPart(params.machineId, body, user, meta);
    return created('Machine part created successfully', toMachinePartResponse(part));
  }

  async list({
    params,
    query,
  }: AuthenticatedRequestInput<MachineParams, ListMachinePartsQuery>): Promise<HttpResult> {
    const page = mapPage(await this.parts.listParts(params.machineId, query), toMachinePartResponse);
    return ok('Machine parts retrieved', page.items, page.meta);
  }

  async getById({ params }: AuthenticatedRequestInput<PartParams>): Promise<HttpResult> {
    const part = await this.parts.getPart(params.machineId, params.partId);
    return ok('Machine part retrieved', toMachinePartResponse(part));
  }

  async update({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<PartParams, undefined, UpdateMachinePartDto>): Promise<HttpResult> {
    const part = await this.parts.updatePart(params.machineId, params.partId, body, user, meta);
    return ok('Machine part updated successfully', toMachinePartResponse(part));
  }

  async remove({ params, user, meta }: AuthenticatedRequestInput<PartParams>): Promise<HttpResult> {
    await this.parts.removePart(params.machineId, params.partId, user, meta);
    return ok('Machine part deleted');
  }
}
