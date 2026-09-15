import { QueryFailedError, type EntityManager } from 'typeorm';
import { type AuditService } from '../audit/audit.service';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { MachineState } from '../common/enums/machine-state.enum';
import { Role } from '../common/enums/role.enum';
import { SYSTEM_REQUEST_META } from '../common/http/request-meta';
import { type Machine } from './machine.entity';
import { type MachinesRepository } from './machines.repository';
import { MachinesService } from './machines.service';

const admin: AuthenticatedUser = {
  id: 1,
  name: 'Admin',
  email: 'admin@example.test',
  phone: '0780000001',
  role: Role.ADMIN,
  sessionId: 'sid',
  mustChangePassword: false,
};

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 5,
    name: 'Laser 1',
    serialNumber: 'LSR-1',
    status: MachineState.DOWNTIME,
    description: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function setup() {
  const repository = {
    serialNumberExists: jest.fn().mockResolvedValue(false),
    create: jest.fn((values: Partial<Machine>) => values as Machine),
    save: jest.fn((value: Partial<Machine>) => Promise.resolve(Object.assign(value, { id: value.id ?? 5 }))),
    findByIdForUpdate: jest.fn(),
    countOpenLogs: jest.fn().mockResolvedValue(0),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<MachinesRepository>;
  const transactions = {
    run: jest.fn((work: (manager: EntityManager) => Promise<unknown>) => work({} as EntityManager)),
  } as unknown as jest.Mocked<TransactionRunner>;
  const audit = { record: jest.fn() } as unknown as jest.Mocked<AuditService>;
  return { service: new MachinesService(repository, transactions, audit), repository, audit };
}

describe('MachinesService', () => {
  it('always creates machines with status ACTIVE', async () => {
    const { service, repository } = setup();
    await service.create({ name: 'Laser 1', serialNumber: 'LSR-1' }, admin, SYSTEM_REQUEST_META);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: MachineState.ACTIVE, isActive: true }),
    );
  });

  it('maps a unique-constraint race to MACHINE_SERIAL_EXISTS', async () => {
    const { service, repository } = setup();
    const driverError = Object.assign(new Error('duplicate'), {
      code: '23505',
      constraint: 'UQ_machines_serial_number',
    });
    repository.save.mockRejectedValue(new QueryFailedError('INSERT', [], driverError));
    await expect(
      service.create({ name: 'L', serialNumber: 'LSR-1' }, admin, SYSTEM_REQUEST_META),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'MACHINE_SERIAL_EXISTS',
    });
  });

  it('never alters status when updating details', async () => {
    const { service, repository } = setup();
    const existing = machine();
    repository.findByIdForUpdate.mockResolvedValue(existing);
    const updated = await service.update(5, { name: 'Laser One' }, admin, SYSTEM_REQUEST_META);
    expect(updated.status).toBe(MachineState.DOWNTIME);
    expect(updated.name).toBe('Laser One');
  });

  it('skips the write and audit when nothing changes', async () => {
    const { service, repository, audit } = setup();
    repository.findByIdForUpdate.mockResolvedValue(machine());
    await service.update(5, { name: 'Laser 1' }, admin, SYSTEM_REQUEST_META);
    expect(repository.save).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses to delete a machine with open logs', async () => {
    const { service, repository } = setup();
    repository.findByIdForUpdate.mockResolvedValue(machine());
    repository.countOpenLogs.mockResolvedValue(2);
    await expect(service.remove(5, admin, SYSTEM_REQUEST_META)).rejects.toMatchObject({
      code: 'MACHINE_HAS_OPEN_LOGS',
    });
    expect(repository.softDelete).not.toHaveBeenCalled();
  });

  it('reports unknown machines', async () => {
    const { service, repository } = setup();
    repository.findByIdForUpdate.mockResolvedValue(null);
    await expect(service.setActive(99, false, admin, SYSTEM_REQUEST_META)).rejects.toMatchObject({
      statusCode: 404,
      code: 'MACHINE_NOT_FOUND',
    });
  });
});
