import { type EntityManager } from 'typeorm';
import { type AuditService } from '../audit/audit.service';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { LogScope } from '../common/enums/log-scope.enum';
import { LogStatus } from '../common/enums/log-status.enum';
import { MachineOperationalStatus } from '../common/enums/machine-operational-status.enum';
import { MachineState } from '../common/enums/machine-state.enum';
import { OperationalImpact } from '../common/enums/operational-impact.enum';
import { Role } from '../common/enums/role.enum';
import { type DomainEventBus } from '../common/events/domain-event-bus';
import { SYSTEM_REQUEST_META } from '../common/http/request-meta';
import { type MachinePart } from '../machine-parts/machine-part.entity';
import { type MachinePartsRepository } from '../machine-parts/machine-parts.repository';
import { type Machine } from '../machines/machine.entity';
import { MachineStatusResolver } from '../machines/machine-status.resolver';
import { MachineStatusSynchronizer } from '../machines/machine-status.synchronizer';
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
    systemStatus: MachineState.ACTIVE,
    operationalStatus: MachineOperationalStatus.OPERATING,
    description: null,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function part(overrides: Partial<MachinePart> = {}): MachinePart {
  return {
    id: 7,
    machineId: 10,
    name: 'Pump',
    partCode: 'A1',
    description: null,
    status: MachineState.ACTIVE,
    operationalImpact: OperationalImpact.NON_BLOCKING,
    isCritical: false,
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
    scope: LogScope.MACHINE,
    machinePartId: null,
    machinePart: null,
    userId: 3,
    faultDescription: 'Leak',
    causeDescription: null,
    entryStatus: MachineState.ACTIVE,
    remedyAction: null,
    resultingState: MachineState.DOWNTIME,
    operationalImpact: null,
    machineStatusBefore: MachineState.ACTIVE,
    machineStatusAfter: MachineState.DOWNTIME,
    operationalStatusBefore: MachineOperationalStatus.OPERATING,
    operationalStatusAfter: MachineOperationalStatus.NOT_OPERATING,
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

/**
 * The real resolver and synchronizer run against in-memory machine and part
 * rows, so these tests cover how a log changes the machine's derived status.
 */
function setup(current: Machine = machine(), machineParts: MachinePart[] = []) {
  const committed: string[] = [];
  const logs = {
    create: jest.fn((values: Partial<MachineLog>) => ({ ...values }) as MachineLog),
    save: jest.fn((value: Partial<MachineLog>) =>
      Promise.resolve(Object.assign(value, { id: value.id ?? 100 })),
    ),
    findById: jest.fn().mockResolvedValue(log()),
    findByIdForUpdate: jest.fn().mockResolvedValue(log()),
    findLatestIdForMachineSystem: jest.fn().mockResolvedValue(100),
    findLatestIdForPart: jest.fn().mockResolvedValue(100),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<MachineLogsRepository>;
  const machines = {
    findByIdForUpdate: jest.fn().mockResolvedValue(current),
    findByIdForUpdateIncludingDeleted: jest.fn().mockResolvedValue(current),
    updateSystemStatus: jest.fn(),
    updateDerivedStatus: jest.fn(),
  } as unknown as jest.Mocked<MachinesRepository>;
  const parts = {
    findById: jest.fn((id: number) => Promise.resolve(machineParts.find((p) => p.id === id) ?? null)),
    findByIdForUpdate: jest.fn((id: number) =>
      Promise.resolve(machineParts.find((p) => p.id === id) ?? null),
    ),
    updateCondition: jest.fn(),
    conditionsForMachine: jest.fn(() =>
      Promise.resolve(
        machineParts.map((p) => ({
          id: p.id,
          partCode: p.partCode,
          status: p.status,
          operationalImpact: p.operationalImpact,
          isActive: p.isActive,
        })),
      ),
    ),
  } as unknown as jest.Mocked<MachinePartsRepository>;
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
      // Events must never be observable before the transaction commits.
      expect(committed).toContain('commit');
    }),
  } as unknown as jest.Mocked<DomainEventBus>;
  const statusSync = new MachineStatusSynchronizer(
    new MachineStatusResolver(),
    machines,
    parts,
    audit,
    events,
  );

  const service = new MachineLogsService(
    logs,
    machines,
    parts,
    new MachineStateTransitionPolicy(),
    new MachineLogRules(),
    new DowntimeCalculator(),
    transactions,
    audit,
    events,
    statusSync,
    { now: () => NOW },
  );
  return { service, logs, machines, parts, audit, events };
}

const createDto = (overrides: Partial<CreateMachineLogDto> = {}): CreateMachineLogDto => ({
  machineId: 10,
  faultDescription: 'Hydraulic leak',
  resultingState: MachineState.DOWNTIME,
  logStatus: LogStatus.OPEN,
  ...overrides,
});

const auditActions = (audit: jest.Mocked<AuditService>) =>
  audit.record.mock.calls.map(([entry]) => entry.action);

describe('MachineLogsService.create (whole machine)', () => {
  it('writes the log, sets the system status, re-derives the machine status and publishes after commit', async () => {
    const current = machine();
    const { service, logs, machines, audit, events } = setup(current);
    await service.create(createDto(), technician, SYSTEM_REQUEST_META);

    expect(logs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: LogScope.MACHINE,
        machinePartId: null,
        userId: 3,
        entryStatus: 'ACTIVE',
        resultingState: 'DOWNTIME',
        machineStatusBefore: 'ACTIVE',
        machineStatusAfter: 'DOWNTIME',
        operationalStatusBefore: 'OPERATING',
        operationalStatusAfter: 'NOT_OPERATING',
        startedAt: NOW,
        endedAt: null,
      }),
      expect.anything(),
    );
    expect(machines.updateSystemStatus).toHaveBeenCalledWith(10, MachineState.DOWNTIME, expect.anything());
    expect(machines.updateDerivedStatus).toHaveBeenCalledWith(
      10,
      { status: MachineState.DOWNTIME, operationalStatus: MachineOperationalStatus.NOT_OPERATING },
      expect.anything(),
    );
    expect(auditActions(audit)).toEqual([
      'MACHINE_LOG_CREATED',
      'MACHINE_SYSTEM_STATUS_CHANGED',
      'MACHINE_STATUS_CHANGED',
      'MACHINE_OPERATIONAL_STATUS_CHANGED',
    ]);
    expect(events.publish).toHaveBeenCalledWith(
      'machine.status.updated',
      expect.objectContaining({
        machineId: 10,
        previousStatus: 'ACTIVE',
        newStatus: 'DOWNTIME',
        logId: 100,
        trigger: { type: 'MACHINE_LOG', logId: 100, scope: LogScope.MACHINE },
        updatedBy: { id: 3, name: 'Tech' },
        timestamp: NOW.toISOString(),
      }),
    );
  });

  it('rejects a stale entry status without writing anything', async () => {
    const { service, logs, machines, events } = setup(
      machine({ status: MachineState.UNDER_MAINTENANCE, systemStatus: MachineState.UNDER_MAINTENANCE }),
    );
    await expect(
      service.create(createDto({ entryStatus: MachineState.ACTIVE }), technician, SYSTEM_REQUEST_META),
    ).rejects.toMatchObject({ statusCode: 409, code: 'MACHINE_STATE_CONFLICT' });
    expect(logs.save).not.toHaveBeenCalled();
    expect(machines.updateSystemStatus).not.toHaveBeenCalled();
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
      { code: 'MACHINE_INACTIVE' },
    );
  });

  it('does not update status or publish for same-state entries', async () => {
    const { service, machines, events, audit } = setup();
    await service.create(
      createDto({ resultingState: MachineState.ACTIVE, logStatus: LogStatus.CLOSED }),
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(machines.updateSystemStatus).not.toHaveBeenCalled();
    expect(machines.updateDerivedStatus).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
    expect(auditActions(audit)).toEqual(['MACHINE_LOG_CREATED']);
  });

  it('defaults endedAt to now for closed logs and calculates downtime', async () => {
    const { service, logs } = setup(
      machine({ status: MachineState.DOWNTIME, systemStatus: MachineState.DOWNTIME }),
    );
    await service.create(
      createDto({
        resultingState: MachineState.ACTIVE,
        logStatus: LogStatus.CLOSED,
        startedAt: new Date(NOW.getTime() - 90 * 60_000),
      }),
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(logs.save).toHaveBeenCalledWith(
      expect.objectContaining({ entryStatus: 'DOWNTIME', endedAt: NOW, downtimeHours: 1.5 }),
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

  it('records the synced machine status when a part is already defective', async () => {
    // Part A1 is under maintenance (non-blocking): the machine is not ACTIVE.
    const current = machine({
      status: MachineState.UNDER_MAINTENANCE,
      operationalStatus: MachineOperationalStatus.OPERATING_WITH_DEFECTS,
    });
    const a1 = part({ status: MachineState.UNDER_MAINTENANCE });
    const { service, logs } = setup(current, [a1]);

    await service.create(
      createDto({ resultingState: MachineState.DOWNTIME }),
      technician,
      SYSTEM_REQUEST_META,
    );

    expect(logs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: LogScope.MACHINE,
        entryStatus: 'ACTIVE',
        machineStatusBefore: 'UNDER_MAINTENANCE',
        operationalStatusBefore: 'OPERATING_WITH_DEFECTS',
        machineStatusAfter: 'DOWNTIME',
        operationalStatusAfter: 'NOT_OPERATING',
      }),
      expect.anything(),
    );
  });
});

describe('MachineLogsService.create (part)', () => {
  it('applies the part condition and derives the machine status from it', async () => {
    const current = machine();
    const a1 = part();
    const { service, logs, machines, parts, audit, events } = setup(current, [a1]);

    await service.create(
      createDto({ machinePartId: 7, resultingState: MachineState.UNDER_MAINTENANCE }),
      technician,
      SYSTEM_REQUEST_META,
    );

    expect(logs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: LogScope.PART,
        machinePartId: 7,
        entryStatus: 'ACTIVE',
        resultingState: 'UNDER_MAINTENANCE',
        operationalImpact: OperationalImpact.NON_BLOCKING,
        machineStatusBefore: 'ACTIVE',
        machineStatusAfter: 'UNDER_MAINTENANCE',
        operationalStatusAfter: 'OPERATING_WITH_DEFECTS',
      }),
      expect.anything(),
    );
    expect(parts.updateCondition).toHaveBeenCalledWith(
      7,
      { status: MachineState.UNDER_MAINTENANCE, operationalImpact: OperationalImpact.NON_BLOCKING },
      expect.anything(),
    );
    // The machine's own system status is untouched; only the derived status follows the part.
    expect(machines.updateSystemStatus).not.toHaveBeenCalled();
    expect(current).toMatchObject({
      systemStatus: MachineState.ACTIVE,
      status: MachineState.UNDER_MAINTENANCE,
      operationalStatus: MachineOperationalStatus.OPERATING_WITH_DEFECTS,
    });
    expect(auditActions(audit)).toEqual([
      'MACHINE_LOG_CREATED',
      'MACHINE_PART_STATUS_CHANGED',
      'MACHINE_STATUS_CHANGED',
      'MACHINE_OPERATIONAL_STATUS_CHANGED',
    ]);
    expect(events.publish.mock.calls.map(([name]) => name)).toEqual([
      'machine.part.updated',
      'machine.status.updated',
      'machine.operational-status.updated',
    ]);
  });

  it('a blocking part condition stops the machine', async () => {
    const current = machine();
    const { service } = setup(current, [part({ isCritical: true })]);
    await service.create(
      createDto({ machinePartId: 7, resultingState: MachineState.DOWNTIME }),
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(current).toMatchObject({
      status: MachineState.DOWNTIME,
      operationalStatus: MachineOperationalStatus.NOT_OPERATING,
    });
  });

  it('defaults the impact from criticality, lets the technician override it, and forces NON_BLOCKING for ACTIVE', async () => {
    const critical = setup(machine(), [part({ isCritical: true })]);
    await critical.service.create(createDto({ machinePartId: 7 }), technician, SYSTEM_REQUEST_META);
    expect(critical.logs.save).toHaveBeenCalledWith(
      expect.objectContaining({ operationalImpact: OperationalImpact.BLOCKING }),
      expect.anything(),
    );

    const overridden = setup(machine(), [part({ isCritical: true })]);
    await overridden.service.create(
      createDto({ machinePartId: 7, operationalImpact: OperationalImpact.NON_BLOCKING }),
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(overridden.logs.save).toHaveBeenCalledWith(
      expect.objectContaining({ operationalImpact: OperationalImpact.NON_BLOCKING }),
      expect.anything(),
    );

    const repaired = setup(machine(), [
      part({
        status: MachineState.DOWNTIME,
        operationalImpact: OperationalImpact.BLOCKING,
        isCritical: true,
      }),
    ]);
    await repaired.service.create(
      createDto({
        machinePartId: 7,
        resultingState: MachineState.ACTIVE,
        operationalImpact: OperationalImpact.BLOCKING,
        logStatus: LogStatus.CLOSED,
      }),
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(repaired.parts.updateCondition).toHaveBeenCalledWith(
      7,
      { status: MachineState.ACTIVE, operationalImpact: OperationalImpact.NON_BLOCKING },
      expect.anything(),
    );
  });

  it('locks the machine before the part', async () => {
    const { service, machines, parts } = setup(machine(), [part()]);
    await service.create(createDto({ machinePartId: 7 }), technician, SYSTEM_REQUEST_META);
    expect(machines.findByIdForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      parts.findByIdForUpdate.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('checks the entry status against the part, not the machine', async () => {
    const { service, logs } = setup(machine(), [part({ status: MachineState.DOWNTIME })]);
    await expect(
      service.create(
        createDto({
          machinePartId: 7,
          entryStatus: MachineState.ACTIVE,
          resultingState: MachineState.ACTIVE,
        }),
        technician,
        SYSTEM_REQUEST_META,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'MACHINE_PART_STATE_CONFLICT' });
    expect(logs.save).not.toHaveBeenCalled();
  });

  it('rejects parts of another machine and deactivated parts', async () => {
    const other = setup(machine(), [part({ machineId: 99 })]);
    await expect(
      other.service.create(createDto({ machinePartId: 7 }), technician, SYSTEM_REQUEST_META),
    ).rejects.toMatchObject({ code: 'MACHINE_PART_NOT_FOUND' });

    const inactive = setup(machine(), [part({ isActive: false })]);
    await expect(
      inactive.service.create(createDto({ machinePartId: 7 }), technician, SYSTEM_REQUEST_META),
    ).rejects.toMatchObject({ code: 'MACHINE_PART_INACTIVE' });
  });
});

describe('MachineLogsService.update', () => {
  it('rejects a stale version', async () => {
    const { service, logs } = setup(machine({ systemStatus: MachineState.DOWNTIME }));
    logs.findByIdForUpdate.mockResolvedValue(log({ version: 3 }));
    await expect(
      service.update(100, { version: 2, remedyAction: 'x' }, technician, SYSTEM_REQUEST_META),
    ).rejects.toMatchObject({ statusCode: 409, code: 'STALE_VERSION' });
  });

  it('changes the system status when the latest log changes its resulting state', async () => {
    const current = machine({
      status: MachineState.DOWNTIME,
      systemStatus: MachineState.DOWNTIME,
      operationalStatus: MachineOperationalStatus.NOT_OPERATING,
    });
    const { service, machines, logs } = setup(current);
    await service.update(
      100,
      { version: 1, resultingState: MachineState.UNDER_MAINTENANCE },
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(machines.updateSystemStatus).toHaveBeenCalledWith(
      10,
      MachineState.UNDER_MAINTENANCE,
      expect.anything(),
    );
    expect(current.status).toBe(MachineState.UNDER_MAINTENANCE);
    expect(logs.save).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, machineStatusAfter: MachineState.UNDER_MAINTENANCE }),
      expect.anything(),
    );
  });

  it('refuses to change the resulting state of a historical log', async () => {
    const { service, logs, machines } = setup(machine());
    logs.findLatestIdForMachineSystem.mockResolvedValue(101);
    await expect(
      service.update(
        100,
        { version: 1, resultingState: MachineState.UNDER_TEST },
        technician,
        SYSTEM_REQUEST_META,
      ),
    ).rejects.toMatchObject({ code: 'RESULTING_STATE_IMMUTABLE' });
    expect(machines.updateSystemStatus).not.toHaveBeenCalled();
  });

  it('allows closing a historical log whose resulting state was DOWNTIME', async () => {
    const { service, logs } = setup(machine());
    logs.findLatestIdForMachineSystem.mockResolvedValue(101);
    await service.update(100, { version: 1, logStatus: LogStatus.CLOSED }, technician, SYSTEM_REQUEST_META);
    expect(logs.save).toHaveBeenCalledWith(
      expect.objectContaining({ logStatus: LogStatus.CLOSED, endedAt: NOW, downtimeHours: 1 }),
      expect.anything(),
    );
  });

  it('is a no-op (no version bump, no audit) when nothing changes', async () => {
    const { service, logs, audit } = setup(machine({ systemStatus: MachineState.DOWNTIME }));
    await service.update(100, { version: 1, faultDescription: 'Leak' }, technician, SYSTEM_REQUEST_META);
    expect(logs.save).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects operationalImpact on a whole-machine log', async () => {
    const { service } = setup(machine({ systemStatus: MachineState.DOWNTIME }));
    await expect(
      service.update(
        100,
        { version: 1, operationalImpact: OperationalImpact.BLOCKING },
        technician,
        SYSTEM_REQUEST_META,
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
  });

  it("returning the latest part log to ACTIVE restores the machine's status", async () => {
    const current = machine({
      status: MachineState.UNDER_MAINTENANCE,
      operationalStatus: MachineOperationalStatus.OPERATING_WITH_DEFECTS,
    });
    const a1 = part({ status: MachineState.UNDER_MAINTENANCE });
    const { service, logs } = setup(current, [a1]);
    const partLog = log({
      scope: LogScope.PART,
      machinePartId: 7,
      resultingState: MachineState.UNDER_MAINTENANCE,
      operationalImpact: OperationalImpact.NON_BLOCKING,
    });
    logs.findById.mockResolvedValue(partLog);
    logs.findByIdForUpdate.mockResolvedValue(partLog);

    await service.update(
      100,
      { version: 1, resultingState: MachineState.ACTIVE, logStatus: LogStatus.CLOSED },
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(a1.status).toBe(MachineState.ACTIVE);
    expect(current).toMatchObject({
      status: MachineState.ACTIVE,
      operationalStatus: MachineOperationalStatus.OPERATING,
    });
  });
});

describe('MachineLogsService.remove', () => {
  it('reverts the system status to the entry status when deleting the latest log', async () => {
    const current = machine({
      status: MachineState.DOWNTIME,
      systemStatus: MachineState.DOWNTIME,
      operationalStatus: MachineOperationalStatus.NOT_OPERATING,
    });
    const { service, machines, events } = setup(current);
    await service.remove(100, technician, SYSTEM_REQUEST_META);
    expect(machines.updateSystemStatus).toHaveBeenCalledWith(10, MachineState.ACTIVE, expect.anything());
    expect(events.publish).toHaveBeenCalledWith(
      'machine.status.updated',
      expect.objectContaining({
        previousStatus: 'DOWNTIME',
        newStatus: 'ACTIVE',
        trigger: { type: 'MACHINE_LOG', logId: 100, scope: LogScope.MACHINE },
      }),
    );
  });

  it('leaves the status alone when deleting a historical log', async () => {
    const { service, machines, logs } = setup(machine({ systemStatus: MachineState.UNDER_TEST }));
    logs.findLatestIdForMachineSystem.mockResolvedValue(150);
    await service.remove(100, technician, SYSTEM_REQUEST_META);
    expect(logs.softDelete).toHaveBeenCalledWith(100, expect.anything());
    expect(machines.updateSystemStatus).not.toHaveBeenCalled();
  });

  it('deleting the latest part log reverts the part and re-derives the machine', async () => {
    const current = machine({
      status: MachineState.DOWNTIME,
      operationalStatus: MachineOperationalStatus.NOT_OPERATING,
    });
    const a1 = part({ status: MachineState.DOWNTIME, operationalImpact: OperationalImpact.BLOCKING });
    const { service, logs, parts } = setup(current, [a1]);
    const partLog = log({
      scope: LogScope.PART,
      machinePartId: 7,
      operationalImpact: OperationalImpact.BLOCKING,
    });
    logs.findById.mockResolvedValue(partLog);
    logs.findByIdForUpdate.mockResolvedValue(partLog);
    logs.findLatestIdForPart.mockResolvedValueOnce(100).mockResolvedValueOnce(null);

    await service.remove(100, technician, SYSTEM_REQUEST_META);
    expect(parts.updateCondition).toHaveBeenCalledWith(
      7,
      { status: MachineState.ACTIVE, operationalImpact: OperationalImpact.NON_BLOCKING },
      expect.anything(),
    );
    expect(current).toMatchObject({
      status: MachineState.ACTIVE,
      operationalStatus: MachineOperationalStatus.OPERATING,
    });
  });
});
