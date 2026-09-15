import { type NextFunction, type Request, type RequestHandler, type Response, Router } from 'express';
import { type z } from 'zod';
import { AppError, type ErrorDetail } from '../errors/app-error';
import { assertAuthorized } from './authorization';
import { requestMetaFrom } from './request-meta';
import { toSuccessBody } from './response';
import { type RouteDefinition } from './route';

type Location = 'params' | 'query' | 'body';

function issueToDetails(location: Location, issue: z.core.$ZodIssue): ErrorDetail[] {
  const prefix = location === 'body' ? '' : `${location}.`;
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({
      field: `${prefix}${[...issue.path, key].join('.')}`,
      message: 'is not allowed',
    }));
  }
  const path = issue.path.map(String).join('.');
  return [{ field: `${prefix}${path}` || location, message: issue.message }];
}

function parseSection(
  schema: z.ZodType | undefined,
  value: unknown,
  location: Location,
  details: ErrorDetail[],
) {
  if (!schema) return undefined;
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  for (const issue of result.error.issues) details.push(...issueToDetails(location, issue));
  return undefined;
}

export interface MountOptions {
  readonly authenticate: RequestHandler;
}

/**
 * Orders routes so that, segment by segment, static segments are matched before
 * parameters (e.g. `/machines/state-transitions` before `/machines/:id`),
 * independent of the order modules register them. Routes are compared
 * lexicographically by segment kind, then by segment count, which is a total
 * order; the sort is stable for identical shapes.
 */
export function orderRoutesForMatching(routes: readonly RouteDefinition[]): RouteDefinition[] {
  const shape = (path: string) => path.split('/').map((segment) => (segment.startsWith(':') ? 1 : 0));
  return [...routes].sort((a, b) => {
    const left = shape(a.spec.path);
    const right = shape(b.spec.path);
    for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return left.length - right.length;
  });
}

/** Builds an Express router from declarative route definitions. */
export function mountRoutes(routes: readonly RouteDefinition[], options: MountOptions): Router {
  const router = Router();

  for (const route of orderRoutesForMatching(routes)) {
    const { spec, access } = route;
    const chain: RequestHandler[] = [];

    if (access.kind === 'protected') chain.push(options.authenticate);
    chain.push(...(spec.middleware ?? []));

    chain.push(async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertAuthorized(access, req.auth);

        const details: ErrorDetail[] = [];
        const params = parseSection(spec.params, req.params, 'params', details);
        const query = parseSection(spec.query, req.query, 'query', details);
        const body = parseSection(spec.body, req.body, 'body', details);
        if (details.length > 0) throw AppError.validation(details);

        const result = await route.invoke({
          params,
          query,
          body,
          meta: requestMetaFrom(req),
          req,
          res,
          user: req.auth,
        });
        res.status(result.status).json(toSuccessBody(result));
      } catch (error: unknown) {
        next(error);
      }
    });

    router[spec.method](spec.path, ...chain);
  }

  return router;
}
