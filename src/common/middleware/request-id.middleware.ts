import { randomUUID } from 'node:crypto';
import { type NextFunction, type Request, type Response } from 'express';
import { requestContextStorage } from '../logger/request-context';

export const REQUEST_ID_HEADER = 'X-Request-Id';
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Assigns a correlation id to each request. A client-supplied X-Request-Id is
 * reused only when it is well-formed, so it cannot inject content into logs.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(REQUEST_ID_HEADER);
  const requestId = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  requestContextStorage.run({ requestId }, next);
}
