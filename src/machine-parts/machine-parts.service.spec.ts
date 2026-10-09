import { type EntityManager } from 'typeorm';
import { type AuditService } from '../audit/audit.service';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { MachineOperationalStatus } from '../common/enums/machine-operational-status.enum';
import { MachineState } from '../common/enums/machine-state.enum';
import { OperationalImpact } from '../common/enums/operational-impact.enum';
import { Role } from '../common/enums/role.enum';
import { SYSTEM_REQUEST_META } from '../common/http/request-meta';
import { type MachineLogsRepository } from '../machine-logs/machine-logs.repository';
import { type Machine } from '../machines/machine.entity';
import { type MachineStatusSynchronizer } from '../machines/machine-status.synchronizer';
import { type MachinesRepository } from '../machines/machines.repository';
import { type MachinePart } from './machine-part.entity';
import { type MaintenanceRepository } from '../maintenance/maintenance.repository';
import { MachinePartsService } from './machine-parts.service';
import { type MachinePartsRepository } from './machine-parts.repository';

const NOW = new Date('2026-10-05T12:00:00Z');
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
    name: 'Hydraulic pump',
    partCode: 'A2',
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

function setup(options: { part?: MachinePart; machine?: Machine } = {}) {
  const currentPart = options.part ?? part();
  const currentMachine = options.machine ?? machine();
  const order: string[] = [];
  const committed: string[] = [];

  const parts = {
    findById: jest.fn().mockResolvedValue(currentPart),
    findByIdForUpdate: jest.fn(() => {
      order.push('lock:part');
      return Promise.resolve(currentPart);
    }),
    updateCondition: jest.fn(),
    partCodeExists: jest.fn().mockResolvedValue(false),
    create: jest.fn((values: Partial<MachinePart>) => values as MachinePart),
    save: jest.fn((value: Partial<MachinePart>) => Promise.resolve(Object.assign(value, { id: 7 }))),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<MachinePartsRepository>;

  const logs = {
    countOpenForPart: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<MachineLogsRepository>;

  const machines = {
    findById: jest.fn().mockResolvedValue(currentMachine),
    findByIdForUpdate: jest.fn(() => {
      order.push('lock:machine');
      return Promise.resolve(currentMachine);
    }),
    findByIdForUpdateIncludingDeleted: jest.fn(() => {
      order.push('lock:machine');
      return Promise.resolve(currentMachine);
    }),
  } as unknown as jest.Mocked<MachinesRepository>;

  const statusSync = {
    synchronize: jest.fn().mockResolvedValue(null),
    publish: jest.fn(() => {
      expect(committed).toContain('commit');
    }),
  } as unknown as jest.Mocked<MachineStatusSynchronizer>;

  const transactions = {
    run: jest.fn(async (work: (manager: EntityManager) => Promise<unknown>) => {
      const result = await work({} as EntityManager);
      committed.push('commit');
      return result;
    }),
  } as unknown as jest.Mocked<TransactionRunner>;

  const audit = { record: jest.fn() } as unknown as jest.Mocked<AuditService>;

  const maintenance = {
    deactivateSchedulesForPart: jest.fn().mockResolvedValue([31, 32]),
    findNextSchedulesForParts: jest.fn().mockResolvedValue(new Map()),
  } as unknown as jest.Mocked<MaintenanceRepository>;

  const service = new MachinePartsService(
    parts,
    logs,
    machines,
    statusSync,
    transactions,
    audit,
    { now: () => NOW },
    maintenance,
  );
  return { service, parts, logs, machines, statusSync, audit, maintenance, order, currentPart };
}

describe('MachinePartsService part administration', () => {
  it('refuses to delete a part with open logs', async () => {
    const { service, logs, parts } = setup();
    logs.countOpenForPart.mockResolvedValue(2);
    await expect(service.removePart(10, 7, technician, SYSTEM_REQUEST_META)).rejects.toMatchObject({
      code: 'MACHINE_PART_HAS_OPEN_LOGS',
    });
    expect(parts.softDelete).not.toHaveBeenCalled();
  });

  it('recalculates machine status and stops maintenance after a part is deleted', async () => {
    const { service, parts, statusSync, maintenance, audit } = setup();
    await service.removePart(10, 7, technician, SYSTEM_REQUEST_META);
    expect(parts.softDelete).toHaveBeenCalledWith(7, expect.anything());
    expect(maintenance.deactivateSchedulesForPart).toHaveBeenCalledWith(7, expect.anything());
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MAINTENANCE_SCHEDULE_UPDATED', entityId: 32 }),
      expect.anything(),
    );
    expect(statusSync.synchronize).toHaveBeenCalled();
  });

  it('recalculates machine status when criticality changes, keeping its schedules', async () => {
    const { service, statusSync, maintenance } = setup();
    await service.updatePart(10, 7, { isCritical: true }, technician, SYSTEM_REQUEST_META);
    expect(statusSync.synchronize).toHaveBeenCalled();
    expect(maintenance.deactivateSchedulesForPart).not.toHaveBeenCalled();
  });

  it('stops maintenance of a deactivated part', async () => {
    const { service, maintenance } = setup();
    await service.updatePart(10, 7, { isActive: false }, technician, SYSTEM_REQUEST_META);
    expect(maintenance.deactivateSchedulesForPart).toHaveBeenCalledWith(7, expect.anything());
  });

  it('rejects a part that belongs to another machine', async () => {
    const { service } = setup({ part: part({ machineId: 999 }) });
    await expect(service.getPart(10, 7)).rejects.toMatchObject({ code: 'MACHINE_PART_NOT_FOUND' });
  });
});
