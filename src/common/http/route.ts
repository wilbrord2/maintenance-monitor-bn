import { type Request, type RequestHandler, type Response } from 'express';
import { type z } from 'zod';
import { type AuthenticatedUser } from '../../auth/auth.types';
import { type Role } from '../enums/role.enum';
import { type HttpResult } from './response';
import { type RequestMeta } from './request-meta';

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';
export type DocumentedErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 423 | 429 | 503;

type Schema = z.ZodType;
type Output<S> = S extends Schema ? z.output<S> : undefined;

export interface ResponseSpec {
  readonly status: 200 | 201;
  readonly description: string;
  /** Schema of the `data` field of the success envelope. */
  readonly data?: Schema;
  /** When true, `data` is an array of `data` items and `meta` carries pagination. */
  readonly paginated?: boolean;
}

interface RouteSpecBase<P, Q, B> {
  readonly method: HttpMethod;
  /** Express-style path relative to the API prefix, e.g. `/machines/:id`. */
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly description?: string;
  readonly params?: P;
  readonly query?: Q;
  readonly body?: B;
  readonly response: ResponseSpec;
  /** Business error statuses worth documenting beyond the automatic ones. */
  readonly errors?: readonly DocumentedErrorStatus[];
  /** Extra middleware (e.g. a stricter rate limiter) run before validation. */
  readonly middleware?: readonly RequestHandler[];
}

/** Validated request input handed to controllers (P/Q/B are parsed value types). */
export interface RequestInput<P = undefined, Q = undefined, B = undefined> {
  readonly params: P;
  readonly query: Q;
  readonly body: B;
  readonly meta: RequestMeta;
  readonly req: Request;
  readonly res: Response;
}

export interface AuthenticatedRequestInput<P = undefined, Q = undefined, B = undefined> extends RequestInput<
  P,
  Q,
  B
> {
  readonly user: AuthenticatedUser;
}

export type HandlerContext<P, Q, B> = RequestInput<Output<P>, Output<Q>, Output<B>>;
export type ProtectedHandlerContext<P, Q, B> = AuthenticatedRequestInput<Output<P>, Output<Q>, Output<B>>;

export type AccessPolicy =
  | { readonly kind: 'public' }
  | {
      readonly kind: 'protected';
      readonly roles: readonly Role[];
      /** Allows callers who still hold a temporary password (e.g. change-password, logout). */
      readonly allowPendingPasswordChange: boolean;
    };

/** Type-erased route consumed by the Express mounter and the OpenAPI generator. */
export interface RouteDefinition {
  readonly spec: RouteSpecBase<Schema | undefined, Schema | undefined, Schema | undefined>;
  readonly access: AccessPolicy;
  readonly invoke: (input: {
    params: unknown;
    query: unknown;
    body: unknown;
    meta: RequestMeta;
    req: Request;
    res: Response;
    user: AuthenticatedUser | undefined;
  }) => Promise<HttpResult>;
}

export function publicRoute<
  P extends Schema | undefined = undefined,
  Q extends Schema | undefined = undefined,
  B extends Schema | undefined = undefined,
>(
  spec: RouteSpecBase<P, Q, B> & { readonly handler: (ctx: HandlerContext<P, Q, B>) => Promise<HttpResult> },
): RouteDefinition {
  return {
    spec,
    access: { kind: 'public' },
    invoke: (input) =>
      spec.handler({
        params: input.params as Output<P>,
        query: input.query as Output<Q>,
        body: input.body as Output<B>,
        meta: input.meta,
        req: input.req,
        res: input.res,
      }),
  };
}

export function protectedRoute<
  P extends Schema | undefined = undefined,
  Q extends Schema | undefined = undefined,
  B extends Schema | undefined = undefined,
>(
  spec: RouteSpecBase<P, Q, B> & {
    readonly roles: readonly Role[];
    readonly allowPendingPasswordChange?: boolean;
    readonly handler: (ctx: ProtectedHandlerContext<P, Q, B>) => Promise<HttpResult>;
  },
): RouteDefinition {
  return {
    spec,
    access: {
      kind: 'protected',
      roles: spec.roles,
      allowPendingPasswordChange: spec.allowPendingPasswordChange ?? false,
    },
    invoke: (input) => {
      if (!input.user) {
        // The mounter always authenticates protected routes first; this guards misuse.
        throw new Error(`Protected route ${spec.method.toUpperCase()} ${spec.path} invoked without a user`);
      }
      return spec.handler({
        params: input.params as Output<P>,
        query: input.query as Output<Q>,
        body: input.body as Output<B>,
        meta: input.meta,
        req: input.req,
        res: input.res,
        user: input.user,
      });
    },
  };
}
