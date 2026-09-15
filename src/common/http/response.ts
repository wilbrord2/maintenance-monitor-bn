export interface PaginationMeta {
  readonly page: number;
  readonly limit: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

export interface HttpResult {
  /** 503 is used only by health checks, which report their details in `data`. */
  readonly status: 200 | 201 | 503;
  readonly message: string;
  readonly data: unknown;
  readonly meta?: PaginationMeta;
}

export interface SuccessResponseBody {
  readonly success: boolean;
  readonly message: string;
  readonly data: unknown;
  readonly meta?: PaginationMeta;
}

export interface ErrorResponseBody {
  readonly success: false;
  readonly message: string;
  readonly code: string;
  readonly timestamp: string;
  readonly path: string;
  readonly requestId?: string;
  readonly details?: readonly { readonly field: string; readonly message: string }[];
}

export function ok(message: string, data: unknown = null, meta?: PaginationMeta): HttpResult {
  return meta ? { status: 200, message, data, meta } : { status: 200, message, data };
}

export function created(message: string, data: unknown): HttpResult {
  return { status: 201, message, data };
}

export function toSuccessBody(result: HttpResult): SuccessResponseBody {
  const success = result.status < 400;
  return result.meta
    ? { success, message: result.message, data: result.data, meta: result.meta }
    : { success, message: result.message, data: result.data };
}
