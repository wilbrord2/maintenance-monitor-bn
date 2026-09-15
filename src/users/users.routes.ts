import { Role, ROLES } from '../common/enums/role.enum';
import { protectedRoute, type RouteDefinition } from '../common/http/route';
import { idParams } from '../common/validation/primitives';
import { type UsersController } from './users.controller';
import {
  createTechnicianResponseSchema,
  createTechnicianSchema,
  listUsersQuerySchema,
  updateProfileSchema,
  updateUserSchema,
  userResponseSchema,
} from './users.dto';

const TAGS = ['Users'];
const ADMIN = [Role.ADMIN] as const;

export function usersRoutes(controller: UsersController): RouteDefinition[] {
  return [
    // Own-account routes are registered before "/users/:id" so "me" is never parsed as an id.
    protectedRoute({
      method: 'get',
      path: '/users/me',
      tags: TAGS,
      summary: 'Get the current user profile',
      roles: ROLES,
      allowPendingPasswordChange: true,
      response: { status: 200, description: 'Current user', data: userResponseSchema },
      handler: (ctx) => controller.me(ctx),
    }),
    protectedRoute({
      method: 'patch',
      path: '/users/me',
      tags: TAGS,
      summary: 'Update own profile (name, phone)',
      description: 'Email, role and position are managed by administrators.',
      roles: ROLES,
      body: updateProfileSchema,
      response: { status: 200, description: 'Updated profile', data: userResponseSchema },
      errors: [409],
      handler: (ctx) => controller.updateMe(ctx),
    }),
    protectedRoute({
      method: 'post',
      path: '/users',
      tags: TAGS,
      summary: 'Create a technician',
      description:
        'Generates a temporary password, emails it to the technician and requires a password change at first login. ' +
        'The password is never returned. If the email cannot be delivered, nothing is created (503).',
      roles: ADMIN,
      body: createTechnicianSchema,
      response: { status: 201, description: 'Technician created', data: createTechnicianResponseSchema },
      errors: [409, 503],
      handler: (ctx) => controller.createTechnician(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/users',
      tags: TAGS,
      summary: 'List users',
      roles: ADMIN,
      query: listUsersQuerySchema,
      response: { status: 200, description: 'Paginated users', data: userResponseSchema, paginated: true },
      handler: (ctx) => controller.list(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/users/:id',
      tags: TAGS,
      summary: 'Get a user',
      roles: ADMIN,
      params: idParams,
      response: { status: 200, description: 'User', data: userResponseSchema },
      handler: (ctx) => controller.getById(ctx),
    }),
    protectedRoute({
      method: 'patch',
      path: '/users/:id',
      tags: TAGS,
      summary: 'Update a user',
      roles: ADMIN,
      params: idParams,
      body: updateUserSchema,
      response: { status: 200, description: 'Updated user', data: userResponseSchema },
      errors: [409],
      handler: (ctx) => controller.update(ctx),
    }),
    protectedRoute({
      method: 'post',
      path: '/users/:id/deactivate',
      tags: TAGS,
      summary: 'Deactivate a user and revoke their sessions',
      roles: ADMIN,
      params: idParams,
      response: { status: 200, description: 'Deactivated user', data: userResponseSchema },
      handler: (ctx) => controller.deactivate(ctx),
    }),
    protectedRoute({
      method: 'post',
      path: '/users/:id/activate',
      tags: TAGS,
      summary: 'Reactivate a user',
      roles: ADMIN,
      params: idParams,
      response: { status: 200, description: 'Activated user', data: userResponseSchema },
      handler: (ctx) => controller.activate(ctx),
    }),
    protectedRoute({
      method: 'post',
      path: '/users/:id/reissue-temporary-password',
      tags: TAGS,
      summary: 'Issue a new temporary password to a technician',
      description:
        'Revokes existing sessions and emails a new temporary credential. Nothing changes if email fails.',
      roles: ADMIN,
      params: idParams,
      response: { status: 200, description: 'Credential reissued', data: userResponseSchema },
      errors: [422, 503],
      handler: (ctx) => controller.reissueTemporaryPassword(ctx),
    }),
    protectedRoute({
      method: 'delete',
      path: '/users/:id',
      tags: TAGS,
      summary: 'Delete (soft) a user',
      description: 'The account is deactivated and hidden; machine logs keep their author.',
      roles: ADMIN,
      params: idParams,
      response: { status: 200, description: 'User deleted' },
      handler: (ctx) => controller.remove(ctx),
    }),
  ];
}
