import { type HttpResult, created, ok } from '../common/http/response';
import { type AuthenticatedRequestInput } from '../common/http/route';
import { mapPage } from '../common/pagination/pagination';
import { toUserResponse } from './user.mapper';
import {
  type CreateTechnicianDto,
  type ListUsersQuery,
  type UpdateProfileDto,
  type UpdateUserDto,
} from './users.dto';
import { type UsersService } from './users.service';

interface IdParams {
  readonly id: number;
}

export class UsersController {
  constructor(private readonly users: UsersService) {}

  async createTechnician({
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<undefined, undefined, CreateTechnicianDto>): Promise<HttpResult> {
    const technician = await this.users.createTechnician(body, user, meta);
    return created('Technician created. Temporary credentials were sent by email.', {
      user: toUserResponse(technician),
      onboardingEmailSent: true,
    });
  }

  async list({ query }: AuthenticatedRequestInput<undefined, ListUsersQuery>): Promise<HttpResult> {
    const page = mapPage(await this.users.list(query), (item) => toUserResponse(item));
    return ok('Users retrieved', page.items, page.meta);
  }

  async getById({ params }: AuthenticatedRequestInput<IdParams>): Promise<HttpResult> {
    return ok('User retrieved', toUserResponse(await this.users.getById(params.id)));
  }

  async update({
    params,
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<IdParams, undefined, UpdateUserDto>): Promise<HttpResult> {
    return ok('User updated', toUserResponse(await this.users.update(params.id, body, user, meta)));
  }

  async deactivate({ params, user, meta }: AuthenticatedRequestInput<IdParams>): Promise<HttpResult> {
    return ok('User deactivated', toUserResponse(await this.users.setActive(params.id, false, user, meta)));
  }

  async activate({ params, user, meta }: AuthenticatedRequestInput<IdParams>): Promise<HttpResult> {
    return ok('User activated', toUserResponse(await this.users.setActive(params.id, true, user, meta)));
  }

  async remove({ params, user, meta }: AuthenticatedRequestInput<IdParams>): Promise<HttpResult> {
    await this.users.remove(params.id, user, meta);
    return ok('User deleted');
  }

  async reissueTemporaryPassword({
    params,
    user,
    meta,
  }: AuthenticatedRequestInput<IdParams>): Promise<HttpResult> {
    const technician = await this.users.reissueTemporaryPassword(params.id, user, meta);
    return ok('A new temporary password was sent by email', toUserResponse(technician));
  }

  async me({ user }: AuthenticatedRequestInput): Promise<HttpResult> {
    return ok('Profile retrieved', toUserResponse(await this.users.getById(user.id)));
  }

  async updateMe({
    body,
    user,
    meta,
  }: AuthenticatedRequestInput<undefined, undefined, UpdateProfileDto>): Promise<HttpResult> {
    return ok('Profile updated', toUserResponse(await this.users.updateProfile(user, body, meta)));
  }
}
