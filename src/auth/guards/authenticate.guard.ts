import { type RequestHandler } from 'express';
import { AppError } from '../../common/errors/app-error';
import { type AuthService } from '../auth.service';

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (rest.length > 0 || scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

/** Resolves the Bearer access token to a live session and attaches the principal to the request. */
export function createAuthenticateGuard(auth: AuthService): RequestHandler {
  return (req, _res, next) => {
    const token = extractBearerToken(req.get('authorization'));
    if (!token) {
      next(AppError.unauthorized());
      return;
    }
    auth
      .authenticate(token)
      .then((user) => {
        req.auth = user;
        next();
      })
      .catch(next);
  };
}
