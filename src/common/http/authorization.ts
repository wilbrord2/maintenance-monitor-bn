import { type AuthenticatedUser } from '../../auth/auth.types';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';
import { type AccessPolicy } from './route';

/**
 * Centralized authorization decision for a route. Throws when the caller may
 * not proceed; authentication itself has already succeeded at this point.
 */
export function assertAuthorized(access: AccessPolicy, user: AuthenticatedUser | undefined): void {
  if (access.kind === 'public') return;
  if (!user) throw AppError.unauthorized();

  if (user.mustChangePassword && !access.allowPendingPasswordChange) {
    throw AppError.forbidden(
      'You must change your temporary password before using this resource',
      ErrorCode.PASSWORD_CHANGE_REQUIRED,
    );
  }
  if (!access.roles.includes(user.role)) {
    throw AppError.forbidden();
  }
}
