import { type Request } from 'express';

/** Client metadata recorded on sessions and audit entries. */
export interface RequestMeta {
  readonly requestId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export const SYSTEM_REQUEST_META: RequestMeta = { requestId: null, ipAddress: null, userAgent: null };

export function requestMetaFrom(req: Request): RequestMeta {
  const userAgent = req.get('user-agent');
  return {
    requestId: req.requestId,
    ipAddress: req.ip ?? null,
    userAgent: userAgent ? userAgent.slice(0, 512) : null,
  };
}
