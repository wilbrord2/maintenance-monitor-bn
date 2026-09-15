import { type PaginationMeta } from '../http/response';

export interface PageRequest {
  readonly page: number;
  readonly limit: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly meta: PaginationMeta;
}

export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 20;

export function toOffset(request: PageRequest): number {
  return (request.page - 1) * request.limit;
}

export function buildPage<T>(items: readonly T[], totalItems: number, request: PageRequest): Page<T> {
  return {
    items,
    meta: {
      page: request.page,
      limit: request.limit,
      totalItems,
      totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / request.limit),
    },
  };
}

export function mapPage<T, R>(page: Page<T>, mapper: (item: T) => R): Page<R> {
  return { items: page.items.map(mapper), meta: page.meta };
}

/** Escapes LIKE/ILIKE wildcards so user search input is matched literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
