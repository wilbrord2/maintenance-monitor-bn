import { type EntityManager } from 'typeorm';
import { type AuditService } from '../audit/audit.service';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { LogStatus } from '../common/enums/log-status.enum';
import { MachineState } from '../common/enums/machine-state.enum';
import { Role } from '../common/enums/role.enum';
import { type DomainEventBus } from '../common/events/domain-event-bus';
import { SYSTEM_REQUEST_META } from '../common/http/request-meta';
import { type Machine } from '../machines/machine.entity';
import { type MachinesRepository } from '../machines/machines.repository';
import { type MachineLog } from './machine-log.entity';
import { type CreateMachineLogDto } from './machine-logs.dto';
import { type MachineLogsRepository } from './machine-logs.repository';
import { MachineLogsService } from './machine-logs.service';
import { DowntimeCalculator } from './policies/downtime-calculator';
import { MachineLogRules } from './policies/machine-log-rules.policy';
import { MachineStateTransitionPolicy } from './policies/machine-state-transition.policy';

const NOW = new Date('2026-09-01T12:00:00Z');
const technician: AuthenticatedUser = {
  id: 3,
  name: 'Tech',
  email: 'tech@example.test',
  phone: '0780000003',
  role: Role.TECHNICIAN,
  sessionId: 'sid',
  mustChangePassword: false,
};

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 10,
    name: 'Press 1',
    serialNumber: 'PRS-1',
    status: MachineState.ACTIVE,
    description: null,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function log(overrides: Partial<MachineLog> = {}): MachineLog {
  return {
    id: 100,
    machineId: 10,
    userId: 3,
    faultDescription: 'Leak',
    causeDescription: null,
    entryStatus: MachineState.ACTIVE,
    remedyAction: null,
    resultingState: MachineState.DOWNTIME,
    downtimeHours: 0,
    logStatus: LogStatus.OPEN,
    nextMaintenancePlan: null,
    startedAt: new Date(NOW.getTime() - 3_600_000),
    endedAt: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    machine: machine(),
    user: { id: 3, fullName: 'Tech', position: null } as MachineLog['user'],
    ...overrides,
  };
}

function setup(current: Machine = machine()) {
  const committed: string[] = [];
  const logs = {
    create: jest.fn((values: Partial<MachineLog>) => values as MachineLog),
    save: jest.fn((value: Partial<MachineLog>) =>
      Promise.resolve(Object.assign(value, { id: value.id ?? 100 })),
    ),
    findById: jest.fn().mockResolvedValue(log()),
    findByIdForUpdate: jest.fn().mockResolvedValue(log()),
    findLatestIdForMachine: jest.fn().mockResolvedValue(100),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<MachineLogsRepository>;
  const machines = {
    findByIdForUpdate: jest.fn().mockResolvedValue(current),
    findByIdForUpdateIncludingDeleted: jest.fn().mockResolvedValue(current),
    updateStatus: jest.fn(),
  } as unknown as jest.Mocked<MachinesRepository>;
  const transactions = {
    run: jest.fn(async (work: (manager: EntityManager) => Promise<unknown>) => {
      const result = await work({} as EntityManager);
      committed.push('commit');
      return result;
    }),
  } as unknown as jest.Mocked<TransactionRunner>;
  const audit = { record: jest.fn() } as unknown as jest.Mocked<AuditService>;
  const events = {
    publish: jest.fn(() => {
      // The event must never be observable before the transaction commits.
      expect(committed).toContain('commit');
    }),
  } as unknown as jest.Mocked<DomainEventBus>;

  const service = new MachineLogsService(
    logs,
    machines,
    new MachineStateTransitionPolicy(),
    new MachineLogRules(),
    new DowntimeCalculator(),
    transactions,
    audit,
    events,
    { now: () => NOW },
  );
  return { service, logs, machines, audit, events };
}

const createDto = (overrides: Partial<CreateMachineLogDto> = {}): CreateMachineLogDto => ({
  machineId: 10,
  faultDescription: 'Hydraulic leak',
  entryStatus: MachineState.ACTIVE,
  resultingState: MachineState.DOWNTIME,
  logStatus: LogStatus.OPEN,
  ...overrides,
});

describe('MachineLogsService.create', () => {
  it('writes the log, syncs machine status, audits both and publishes after commit', async () => {
    const { service, logs, machines, audit, events } = setup();
    await service.create(createDto(), technician, SYSTEM_REQUEST_META);

    expect(logs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 3,
        entryStatus: 'ACTIVE',
        resultingState: 'DOWNTIME',
        startedAt: NOW,
        endedAt: null,
      }),
      expect.anything(),
    );
    expect(machines.updateStatus).toHaveBeenCalledWith(10, MachineState.DOWNTIME, expect.anything());
    expect(audit.record.mock.calls.map(([entry]) => entry.action)).toEqual([
      'MACHINE_LOG_CREATED',
      'MACHINE_STATUS_CHANGED',
    ]);
    expect(events.publish).toHaveBeenCalledWith(
      'machine.status.updated',
      expect.objectContaining({
        machineId: 10,
        previousStatus: 'ACTIVE',
        newStatus: 'DOWNTIME',
        updatedBy: { id: 3, name: 'Tech' },
        timestamp: NOW.toISOString(),
      }),
    );
  });

  it('rejects a stale entry status without writing anything', async () => {
    const { service, logs, machines, events } = setup(machine({ status: MachineState.UNDER_MAINTENANCE }));
    await expect(service.create(createDto(), technician, SYSTEM_REQUEST_META)).rejects.toMatchObject({
      statusCode: 409,
      code: 'MACHINE_STATE_CONFLICT',
    });
    expect(logs.save).not.toHaveBeenCalled();
    expect(machines.updateStatus).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('rejects logs for missing or deactivated machines', async () => {
    const missing = setup();
    missing.machines.findByIdForUpdate.mockResolvedValue(null);
    await expect(missing.service.create(createDto(), technician, SYSTEM_REQUEST_META)).rejects.toMatchObject({
      code: 'MACHINE_NOT_FOUND',
    });

    const inactive = setup(machine({ isActive: false }));
    await expect(inactive.service.create(createDto(), technician, SYSTEM_REQUEST_META)).rejects.toMatchObject(
      {
        code: 'MACHINE_INACTIVE',
      },
    );
  });

  it('does not update status or publish for same-state entries', async () => {
    const { service, machines, events, audit } = setup();
    await service.create(
      createDto({ resultingState: MachineState.ACTIVE, logStatus: LogStatus.CLOSED }),
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(machines.updateStatus).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('defaults endedAt to now for closed logs and calculates downtime', async () => {
    const { service, logs } = setup(machine({ status: MachineState.DOWNTIME }));
    await service.create(
      createDto({
        entryStatus: MachineState.DOWNTIME,
        resultingState: MachineState.ACTIVE,
        logStatus: LogStatus.CLOSED,
        startedAt: new Date(NOW.getTime() - 90 * 60_000),
      }),
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(logs.save).toHaveBeenCalledWith(
      expect.objectContaining({ endedAt: NOW, downtimeHours: 1.5 }),
      expect.anything(),
    );
  });

  it('propagates failures from inside the transaction and publishes nothing', async () => {
    const { service, audit, events } = setup();
    audit.record.mockRejectedValueOnce(new Error('audit insert failed'));
    await expect(service.create(createDto(), technician, SYSTEM_REQUEST_META)).rejects.toThrow(
      'audit insert failed',
    );
    expect(events.publish).not.toHaveBeenCalled();
  });
});

describe('MachineLogsService.update', () => {
  it('rejects a stale version', async () => {
    const { service, logs } = setup(machine({ status: MachineState.DOWNTIME }));
    logs.findByIdForUpdate.mockResolvedValue(log({ version: 3 }));
    await expect(
      service.update(100, { version: 2, remedyAction: 'x' }, technician, SYSTEM_REQUEST_META),
    ).rejects.toMatchObject({ statusCode: 409, code: 'STALE_VERSION' });
  });

  it('changes machine status when the latest log changes its resulting state', async () => {
    const { service, machines, logs } = setup(machine({ status: MachineState.DOWNTIME }));
    await service.update(
      100,
      { version: 1, resultingState: MachineState.UNDER_MAINTENANCE },
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(machines.updateStatus).toHaveBeenCalledWith(10, MachineState.UNDER_MAINTENANCE, expect.anything());
    expect(logs.save).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }), expect.anything());
  });

  it('refuses to change the resulting state of a historical log', async () => {
    const { service, logs, machines } = setup(machine({ status: MachineState.ACTIVE }));
    logs.findLatestIdForMachine.mockResolvedValue(101);
    await expect(
      service.update(
        100,
        { version: 1, resultingState: MachineState.UNDER_TEST },
        technician,
        SYSTEM_REQUEST_META,
      ),
    ).rejects.toMatchObject({ code: 'RESULTING_STATE_IMMUTABLE' });
    expect(machines.updateStatus).not.toHaveBeenCalled();
  });

  it('allows closing a historical log whose resulting state was DOWNTIME', async () => {
    const { service, logs } = setup(machine({ status: MachineState.ACTIVE }));
    logs.findLatestIdForMachine.mockResolvedValue(101);
    await service.update(100, { version: 1, logStatus: LogStatus.CLOSED }, technician, SYSTEM_REQUEST_META);
    expect(logs.save).toHaveBeenCalledWith(
      expect.objectContaining({ logStatus: LogStatus.CLOSED, endedAt: NOW, downtimeHours: 1 }),
      expect.anything(),
    );
  });

  it('is a no-op (no version bump, no audit) when nothing changes', async () => {
    const { service, logs, audit } = setup(machine({ status: MachineState.DOWNTIME }));
    await service.update(100, { version: 1, faultDescription: 'Leak' }, technician, SYSTEM_REQUEST_META);
    expect(logs.save).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('MachineLogsService.remove', () => {
  it('reverts the machine to the entry status when deleting the latest log', async () => {
    const { service, machines, events } = setup(machine({ status: MachineState.DOWNTIME }));
    await service.remove(100, technician, SYSTEM_REQUEST_META);
    expect(machines.updateStatus).toHaveBeenCalledWith(10, MachineState.ACTIVE, expect.anything());
    expect(events.publish).toHaveBeenCalledWith(
      'machine.status.updated',
      expect.objectContaining({
        previousStatus: 'DOWNTIME',
        newStatus: 'ACTIVE',
        source: 'MACHINE_LOG_DELETED',
      }),
    );
  });

  it('leaves the status alone when deleting a historical log', async () => {
    const { service, machines, logs } = setup(machine({ status: MachineState.UNDER_TEST }));
    logs.findLatestIdForMachine.mockResolvedValue(150);
    await service.remove(100, technician, SYSTEM_REQUEST_META);
    expect(logs.softDelete).toHaveBeenCalledWith(100, expect.anything());
    expect(machines.updateStatus).not.toHaveBeenCalled();
  });
});
