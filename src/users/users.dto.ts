import { z } from 'zod';
import { Role } from '../common/enums/role.enum';
import {
  booleanQuery,
  emailAddress,
  paginationQuery,
  phoneNumber,
  searchQuery,
  sortingQuery,
  text,
} from '../common/validation/primitives';
import { USER_SORT_FIELDS } from './users.repository';

const roleEnum = z.enum(Role);

export const createTechnicianSchema = z
  .object({
    fullName: text(2, 120).meta({ example: 'John Doe' }),
    email: emailAddress,
    phone: phoneNumber,
    position: text(1, 100).optional().meta({ example: 'Maintenance Technician' }),
  })
  .strict()
  .meta({ id: 'CreateTechnicianRequest' });
export type CreateTechnicianDto = z.output<typeof createTechnicianSchema>;

export const updateUserSchema = z
  .object({
    fullName: text(2, 120).optional(),
    email: emailAddress.optional(),
    phone: phoneNumber.optional(),
    position: text(1, 100).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided')
  .meta({ id: 'UpdateUserRequest' });
export type UpdateUserDto = z.output<typeof updateUserSchema>;

/** Fields a user may change on their own account. Email, role and position are administrator-managed. */
export const updateProfileSchema = z
  .object({
    fullName: text(2, 120).optional(),
    phone: phoneNumber.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided')
  .meta({ id: 'UpdateProfileRequest' });
export type UpdateProfileDto = z.output<typeof updateProfileSchema>;

export const listUsersQuerySchema = paginationQuery
  .extend(sortingQuery(USER_SORT_FIELDS, 'createdAt').shape)
  .extend({
    role: roleEnum.optional(),
    isActive: booleanQuery.optional(),
    search: searchQuery,
  })
  .strict();
export type ListUsersQuery = z.output<typeof listUsersQuerySchema>;

export const userResponseSchema = z
  .object({
    id: z.number().int(),
    fullName: z.string(),
    email: z.string(),
    phone: z.string(),
    position: z.string().nullable(),
    role: roleEnum,
    isActive: z.boolean(),
    mustChangePassword: z.boolean(),
    isLocked: z.boolean(),
    lastLoginAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'User' });

export const createTechnicianResponseSchema = z
  .object({ user: userResponseSchema, onboardingEmailSent: z.literal(true) })
  .meta({ id: 'CreateTechnicianResponse' });
