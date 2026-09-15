import { MachineState } from '../enums/machine-state.enum';
import { type AppLogger } from '../logger/logger';
import { DomainEventBus } from './domain-event-bus';
import { MACHINE_STATUS_UPDATED, type MachineStatusUpdatedEvent } from './domain-events';

const event: MachineStatusUpdatedEvent = {
  machineId: 1,
  machineName: 'Laser 1',
  serialNumber: 'L-1',
  previousStatus: MachineState.ACTIVE,
  newStatus: MachineState.DOWNTIME,
  updatedBy: { id: 2, name: 'Tech' },
  logId: 3,
  source: 'MACHINE_LOG_CREATED',
  timestamp: '2026-09-01T00:00:00.000Z',
};

function setup() {
  const logger = { error: jest.fn() } as unknown as jest.Mocked<AppLogger>;
  return { bus: new DomainEventBus(logger), logger };
}

describe('DomainEventBus', () => {
  it('delivers events to every subscriber', () => {
    const { bus } = setup();
    const first = jest.fn();
    const second = jest.fn();
    bus.subscribe(MACHINE_STATUS_UPDATED, first);
    bus.subscribe(MACHINE_STATUS_UPDATED, second);
    bus.publish(MACHINE_STATUS_UPDATED, event);
    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
  });

  it('isolates synchronous and asynchronous handler failures', async () => {
    const { bus, logger } = setup();
    const healthy = jest.fn();
    bus.subscribe(MACHINE_STATUS_UPDATED, () => {
      throw new Error('sync failure');
    });
    bus.subscribe(MACHINE_STATUS_UPDATED, () => Promise.reject(new Error('async failure')));
    bus.subscribe(MACHINE_STATUS_UPDATED, healthy);

    expect(() => bus.publish(MACHINE_STATUS_UPDATED, event)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(healthy).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('stops delivering after unsubscribe', () => {
    const { bus } = setup();
    const handler = jest.fn();
    const unsubscribe = bus.subscribe(MACHINE_STATUS_UPDATED, handler);
    unsubscribe();
    bus.publish(MACHINE_STATUS_UPDATED, event);
    expect(handler).not.toHaveBeenCalled();
  });
});
