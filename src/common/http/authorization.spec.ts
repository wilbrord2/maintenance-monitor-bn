import { type AuthenticatedUser } from '../../auth/auth.types';
import { Role } from '../enums/role.enum';
import { type AppError } from '../errors/app-error';
import { assertAuthorized } from './authorization';

const technician: AuthenticatedUser = {
  id: 1,
  name: 'T',
  email: 't@example.test',
  phone: '0780000000',
  role: Role.TECHNICIAN,
  sessionId: 's',
  mustChangePassword: false,
};

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as AppError).code;
  }
}

describe('assertAuthorized', () => {
  const adminOnly = { kind: 'protected', roles: [Role.ADMIN], allowPendingPasswordChange: false } as const;
  const anyRole = {
    kind: 'protected',
    roles: [Role.ADMIN, Role.TECHNICIAN],
    allowPendingPasswordChange: false,
  } as const;

  it('allows public routes without a user', () => {
    expect(codeOf(() => assertAuthorized({ kind: 'public' }, undefined))).toBeNull();
  });

  it('requires a user on protected routes', () => {
    expect(codeOf(() => assertAuthorized(anyRole, undefined))).toBe('UNAUTHORIZED');
  });

  it('enforces roles', () => {
    expect(codeOf(() => assertAuthorized(adminOnly, technician))).toBe('FORBIDDEN');
    expect(codeOf(() => assertAuthorized(anyRole, technician))).toBeNull();
  });

  it('blocks users with a pending password change unless the route allows it', () => {
    const pending = { ...technician, mustChangePassword: true };
    expect(codeOf(() => assertAuthorized(anyRole, pending))).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(
      codeOf(() => assertAuthorized({ ...anyRole, allowPendingPasswordChange: true }, pending)),
    ).toBeNull();
  });
});
