import { type AppLogger } from '../logger/logger';
import { type DomainEventMap, type DomainEventName } from './domain-events';

export type DomainEventHandler<K extends DomainEventName> = (
  payload: DomainEventMap[K],
) => void | Promise<void>;

/**
 * In-process publish/subscribe for domain events. Publishers must only publish
 * after their transaction commits. Handler failures are isolated and logged so
 * they never affect the publisher or other subscribers.
 *
 * For multiple API replicas, subscribers can forward events to a shared broker
 * (e.g. Redis pub/sub or the Socket.IO Redis adapter) without changing publishers.
 */
export class DomainEventBus {
  private readonly handlers = new Map<DomainEventName, Set<DomainEventHandler<DomainEventName>>>();

  constructor(private readonly logger: AppLogger) {}

  subscribe<K extends DomainEventName>(event: K, handler: DomainEventHandler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const registered = handler as DomainEventHandler<DomainEventName>;
    set.add(registered);
    return () => {
      set.delete(registered);
    };
  }

  publish<K extends DomainEventName>(event: K, payload: DomainEventMap[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        const result = handler(payload);
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            this.logger.error({ err: error, event }, 'Domain event handler failed');
          });
        }
      } catch (error: unknown) {
        this.logger.error({ err: error, event }, 'Domain event handler failed');
      }
    }
  }
}
