import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextStore {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export const requestContextStorage = {
  run<T>(store: RequestContextStore, callback: () => T): T {
    return storage.run(store, callback);
  },
  getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
  },
};
