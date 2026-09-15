import { type AuthenticatedUser } from '../../auth/auth.types';

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlation id for this request (from a valid X-Request-Id header or generated). */
    requestId: string;
    /** Set by the authentication middleware on protected routes. */
    auth?: AuthenticatedUser;
  }
}
