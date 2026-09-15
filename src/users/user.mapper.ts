import { type Role } from '../common/enums/role.enum';
import { type User } from './user.entity';

export interface UserResponse {
  readonly id: number;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string;
  readonly position: string | null;
  readonly role: Role;
  readonly isActive: boolean;
  readonly mustChangePassword: boolean;
  readonly isLocked: boolean;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Public representation of a user. Credentials and lockout counters never leave the service. */
export function toUserResponse(user: User, now: Date = new Date()): UserResponse {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    position: user.position,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    isLocked: user.lockedUntil !== null && user.lockedUntil > now,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/** Non-sensitive snapshot used for audit old/new values. */
export function toUserAuditSnapshot(user: User): Record<string, unknown> {
  return {
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    position: user.position,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
  };
}

/** Compact reference to a user embedded in other resources (e.g. log author). */
export interface UserSummary {
  readonly id: number;
  readonly fullName: string;
  readonly position: string | null;
}

export function toUserSummary(user: Pick<User, 'id' | 'fullName' | 'position'>): UserSummary {
  return { id: user.id, fullName: user.fullName, position: user.position };
}
