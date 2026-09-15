import { type HttpResult, created, ok } from '../common/http/response';
import { type AuthenticatedRequestInput } from '../common/http/route';
import { toMachineResponse } from './machine.mapper';
import { type CreateMachineDto, type ListMachinesQuery, type UpdateMachineDto } from './machines.dto';
import { type MachinesService } from './machines.service';

interface IdParams {
  readonly id: number;
}

export class MachinesController {
  constructor(private readonly machines: MachinesService) {}

  async create({
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<undefined, undefined, CreateMachineDto>): Promise<HttpResult> {
    const machine = await this.machines.create(body, user, meta);
    return created('Machine created successfully', toMachineResponse(machine));
  }

  async list({ query }: AuthenticatedRequestInput<undefined, ListMachinesQuery>): Promise<HttpResult> {
    const page = await this.machines.list(query);
    return ok(
      'Machines retrieved',
      page.items.map(({ machine, activity }) => toMachineResponse(machine, activity)),
      page.meta,
    );
  }

  async getById({ params }: AuthenticatedRequestInput<IdParams>): Promise<HttpResult> {
    const { machine, activity } = await this.machines.getById(params.id);
    return ok('Machine retrieved', toMachineResponse(machine, activity));
  }

  async update({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<IdParams, undefined, UpdateMachineDto>): Promise<HttpResult> {
    return ok(
      'Machine updated successfully',
      toMachineResponse(await this.machines.update(params.id, body, user, meta)),
    );
  }

  async deactivate({ params, user, meta }: AuthenticatedRequestInput<IdParams>): Promise<HttpResult> {
    return ok(
      'Machine deactivated',
      toMachineResponse(await this.machines.setActive(params.id, false, user, meta)),
    );
  }

  async activate({ params, user, meta }: AuthenticatedRequestInput<IdParams>): Promise<HttpResult> {
    return ok(
      'Machine activated',
      toMachineResponse(await this.machines.setActive(params.id, true, user, meta)),
    );
  }

  async remove({ params, user, meta }: AuthenticatedRequestInput<IdParams>): Promise<HttpResult> {
    await this.machines.remove(params.id, user, meta);
    return ok('Machine deleted');
  }
}
