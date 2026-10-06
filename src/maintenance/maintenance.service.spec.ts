import { type EntityManager } from 'typeorm';
import { type AuditService } from '../audit/audit.service';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type TransactionRunner } from '../common/database/transaction-runner';
import { LogStatus } from '../common/enums/log-status.enum';
import { MachineOperationalStatus } from '../common/enums/machine-operational-status.enum';
import { MachineState } from '../common/enums/machine-state.enum';
import { MaintenanceEventStatus } from '../common/enums/maintenance.enums';
import { Role } from '../common/enums/role.enum';
import { type DomainEventBus } from '../common/events/domain-event-bus';
import { SYSTEM_REQUEST_META } from '../common/http/request-meta';
import { type AppLogger } from '../common/logger/logger';
import { type MachineLog } from '../machine-logs/machine-log.entity';
import { type MachineLogsService } from '../machine-logs/machine-logs.service';
import { type Machine } from '../machines/machine.entity';
import { type MachinesRepository } from '../machines/machines.repository';
import { type MaintenanceEvent } from './maintenance-event.entity';
import { type MaintenanceSchedule } from './maintenance-schedule.entity';
import { type MaintenanceRepository } from './maintenance.repository';
import { MaintenanceService } from './maintenance.service';

const NOW = new Date('2026-10-05T12:00:00Z');
const technician: AuthenticatedUser = {
  id: 4,
  name: 'Tech',
  email: 'tech@example.test',
  phone: '0780000004',
  role: Role.TECHNICIAN,
  sessionId: 'sid',
  mustChangePassword: false,
};
const day = (date: Date) => date.toISOString().slice(0, 10);

const machine = (overrides: Partial<Machine> = {}): Machine => ({
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
});

const schedule = (overrides: Partial<MaintenanceSchedule> = {}): MaintenanceSchedule => ({
  id: 1,
  machineId: 10,
  intervalDays: 20,
  lastMaintenanceAt: new Date('2026-09-15T08:00:00Z'),
  nextMaintenanceAt: new Date('2026-10-05T08:00:00Z'),
  reminderDaysBefore: 3,
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const event = (overrides: Partial<MaintenanceEvent> = {}): MaintenanceEvent => ({
  id: 50,
  maintenanceScheduleId: 1,
  machineId: 10,
  performedById: null,
  machineLogId: null,
  scheduledFor: new Date('2026-10-05T08:00:00Z'),
  startedAt: null,
  completedAt: null,
  status: MaintenanceEventStatus.SCHEDULED,
  notes: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

function setup(
  options: { schedule?: MaintenanceSchedule | null; event?: MaintenanceEvent; now?: Date } = {},
) {
  const now = options.now ?? NOW;
  const currentSchedule = options.schedule === undefined ? schedule() : options.schedule;
  const currentEvent = options.event ?? event();
  const saved: { schedules: MaintenanceSchedule[]; events: MaintenanceEvent[] } = {
    schedules: [],
    events: [],
  };

  const repository = {
    // `create*` stands in for the TypeORM factories: it only fills the id a real insert would assign.
    createSchedule: jest.fn(
      (values: Partial<MaintenanceSchedule>) => ({ id: 1, ...values }) as MaintenanceSchedule,
    ),
    saveSchedule: jest.fn((value: MaintenanceSchedule) => {
      saved.schedules.push(value);
      return Promise.resolve(value);
    }),
    findScheduleByMachine: jest.fn().mockResolvedValue(currentSchedule),
    findScheduleByIdForUpdate: jest.fn().mockResolvedValue(currentSchedule),
    findSchedulesPage: jest.fn().mockResolvedValue({ items: [], meta: {} }),
    createEvent: jest.fn((values: Partial<MaintenanceEvent>) => ({ id: 50, ...values }) as MaintenanceEvent),
    saveEvent: jest.fn((value: MaintenanceEvent) => {
      saved.events.push(value);
      return Promise.resolve(value);
    }),
    findEventById: jest.fn().mockResolvedValue(currentEvent),
    findEventByIdForUpdate: jest.fn().mockResolvedValue(currentEvent),
    findOpenEventForSchedule: jest.fn().mockResolvedValue(null),
    findEventsPage: jest.fn().mockResolvedValue({ items: [], meta: {} }),
  } as unknown as jest.Mocked<MaintenanceRepository>;

  const machines = {
    findById: jest.fn().mockResolvedValue(machine()),
  } as unknown as jest.Mocked<MachinesRepository>;

  const machineLogs = {
    create: jest.fn().mockResolvedValue({ id: 900, version: 1, logStatus: LogStatus.OPEN }),
    getById: jest.fn().mockResolvedValue({ id: 900, version: 1, logStatus: LogStatus.OPEN }),
    update: jest.fn().mockResolvedValue({ id: 900 }),
  } as unknown as jest.Mocked<MachineLogsService>;

  const transactions = {
    run: jest.fn((work: (manager: EntityManager) => Promise<unknown>) => work({} as EntityManager)),
  } as unknown as jest.Mocked<TransactionRunner>;
  const audit = { record: jest.fn() } as unknown as jest.Mocked<AuditService>;
  const events = { publish: jest.fn() } as unknown as jest.Mocked<DomainEventBus>;
  const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as unknown as jest.Mocked<AppLogger>;

  const service = new MaintenanceService(
    repository,
    machines,
    machineLogs,
    transactions,
    audit,
    events,
    { now: () => now },
    logger,
  );
  return { service, repository, machines, machineLogs, audit, events, logger, saved };
}

describe('MaintenanceService schedules', () => {
  it('computes the first due date from history', async () => {
    const { service, repository, saved } = setup({ schedule: null });
    await service.createSchedule(
      10,
      {
        intervalDays: 20,
        reminderDaysBefore: 3,
        lastMaintenanceAt: new Date('2026-09-25T09:00:00Z'),
      },
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(repository.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 10, intervalDays: 20 }),
    );
    expect(day(saved.schedules[0]!.nextMaintenanceAt)).toBe('2026-10-15');
  });

  it('refuses a second schedule and schedules for deactivated machines', async () => {
    const existing = setup();
    await expect(
      existing.service.createSchedule(
        10,
        { intervalDays: 10, reminderDaysBefore: 1 },
        technician,
        SYSTEM_REQUEST_META,
      ),
    ).rejects.toMatchObject({ code: 'MAINTENANCE_SCHEDULE_EXISTS' });

    const inactive = setup({ schedule: null });
    inactive.machines.findById.mockResolvedValue(machine({ isActive: false }));
    await expect(
      inactive.service.createSchedule(
        10,
        { intervalDays: 10, reminderDaysBefore: 1 },
        technician,
        SYSTEM_REQUEST_META,
      ),
    ).rejects.toMatchObject({ code: 'MACHINE_INACTIVE' });
  });

  it('recomputes the due date from the new interval, or takes an explicit one', async () => {
    const recomputed = setup();
    await recomputed.service.updateSchedule(10, { intervalDays: 30 }, technician, SYSTEM_REQUEST_META);
    expect(day(recomputed.saved.schedules[0]!.nextMaintenanceAt)).toBe('2026-10-15'); // 15 Sep + 30

    const explicit = setup();
    await explicit.service.updateSchedule(
      10,
      { nextMaintenanceAt: new Date('2026-11-01T00:00:00Z'), intervalDays: 30 },
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(day(explicit.saved.schedules[0]!.nextMaintenanceAt)).toBe('2026-11-01');
  });

  it('rejects a reminder window longer than the interval', async () => {
    const { service } = setup();
    await expect(
      service.updateSchedule(10, { intervalDays: 2 }, technician, SYSTEM_REQUEST_META),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('skips the write when nothing changes', async () => {
    const { service, audit, saved } = setup();
    await service.updateSchedule(10, { intervalDays: 20 }, technician, SYSTEM_REQUEST_META);
    expect(saved.schedules).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('reports a missing schedule', async () => {
    const { service } = setup({ schedule: null });
    await expect(service.getSchedule(10)).rejects.toMatchObject({
      code: 'MAINTENANCE_SCHEDULE_NOT_FOUND',
    });
  });
});

describe('MaintenanceService events', () => {
  it('links a new event to the machine schedule and defaults its date to the due date', async () => {
    const { service, repository } = setup();
    await service.createEvent({ machineId: 10 }, technician, SYSTEM_REQUEST_META);
    expect(repository.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        maintenanceScheduleId: 1,
        scheduledFor: new Date('2026-10-05T08:00:00Z'),
        status: MaintenanceEventStatus.SCHEDULED,
      }),
    );
  });

  it('creates an unlinked ad-hoc event when the machine has no schedule', async () => {
    const { service, repository } = setup({ schedule: null });
    await service.createEvent({ machineId: 10 }, technician, SYSTEM_REQUEST_META);
    expect(repository.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ maintenanceScheduleId: null, scheduledFor: NOW }),
    );
  });

  it('refuses a second open event for the same schedule', async () => {
    const { service, repository } = setup();
    repository.findOpenEventForSchedule.mockResolvedValue(event({ id: 77 }));
    await expect(
      service.createEvent({ machineId: 10 }, technician, SYSTEM_REQUEST_META),
    ).rejects.toMatchObject({ code: 'MAINTENANCE_EVENT_ALREADY_OPEN' });
  });

  it('opens a machine log when starting, and skips it when asked', async () => {
    const withLog = setup();
    await withLog.service.startEvent(
      50,
      { putMachineUnderMaintenance: true },
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(withLog.machineLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 10, resultingState: MachineState.UNDER_MAINTENANCE }),
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(withLog.saved.events[0]).toMatchObject({
      status: MaintenanceEventStatus.IN_PROGRESS,
      machineLogId: 900,
      performedById: technician.id,
      startedAt: NOW,
    });

    const without = setup();
    await without.service.startEvent(
      50,
      { putMachineUnderMaintenance: false },
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(without.machineLogs.create).not.toHaveBeenCalled();
    expect(without.saved.events[0]).toMatchObject({ machineLogId: null });
  });

  it('refuses to start an event that is not SCHEDULED', async () => {
    const { service } = setup({
      event: event({ status: MaintenanceEventStatus.IN_PROGRESS, startedAt: NOW }),
    });
    await expect(
      service.startEvent(50, { putMachineUnderMaintenance: true }, technician, SYSTEM_REQUEST_META),
    ).rejects.toMatchObject({ code: 'MAINTENANCE_EVENT_STATE_CONFLICT' });
  });

  it('rolls the cycle forward from the completion time and closes the machine log', async () => {
    const {
      service,
      machineLogs,
      events: bus,
      saved,
    } = setup({
      // Scheduled 15 Oct, actually completed 18 Oct, 20-day interval.
      now: new Date('2026-10-18T15:00:00Z'),
      schedule: schedule({ nextMaintenanceAt: new Date('2026-10-15T08:00:00Z') }),
      event: event({
        status: MaintenanceEventStatus.IN_PROGRESS,
        scheduledFor: new Date('2026-10-15T08:00:00Z'),
        startedAt: new Date('2026-10-18T07:00:00Z'),
        machineLogId: 900,
      }),
    });
    const completedAt = new Date('2026-10-18T14:30:00Z');

    await service.completeEvent(50, { completedAt, releaseMachine: true }, technician, SYSTEM_REQUEST_META);

    expect(saved.events[0]).toMatchObject({ status: MaintenanceEventStatus.COMPLETED, completedAt });
    // Completed 18 Oct with a 20-day interval → next 7 Nov.
    expect(day(saved.schedules[0]!.nextMaintenanceAt)).toBe('2026-11-07');
    expect(saved.schedules[0]!.lastMaintenanceAt).toEqual(completedAt);
    expect(machineLogs.update).toHaveBeenCalledWith(
      900,
      expect.objectContaining({
        resultingState: MachineState.ACTIVE,
        logStatus: LogStatus.CLOSED,
        version: 1,
      }),
      technician,
      SYSTEM_REQUEST_META,
    );
    expect(bus.publish).toHaveBeenCalledWith(
      'maintenance.completed',
      expect.objectContaining({ eventId: 50 }),
    );
  });

  it('completes an ad-hoc event without touching any schedule', async () => {
    const { service, saved } = setup({
      schedule: null,
      event: event({ maintenanceScheduleId: null, status: MaintenanceEventStatus.SCHEDULED }),
    });
    await service.completeEvent(50, { releaseMachine: false }, technician, SYSTEM_REQUEST_META);
    expect(saved.schedules).toHaveLength(0);
    expect(saved.events[0]).toMatchObject({ completedAt: NOW, startedAt: NOW });
  });

  it('rejects completion times in the future or before the start', async () => {
    const future = setup();
    await expect(
      future.service.completeEvent(
        50,
        { completedAt: new Date(NOW.getTime() + 3_600_000), releaseMachine: false },
        technician,
        SYSTEM_REQUEST_META,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LOG_TIMES' });

    const early = setup({
      event: event({
        status: MaintenanceEventStatus.IN_PROGRESS,
        startedAt: new Date('2026-10-05T10:00:00Z'),
      }),
    });
    await expect(
      early.service.completeEvent(
        50,
        { completedAt: new Date('2026-10-05T09:00:00Z'), releaseMachine: false },
        technician,
        SYSTEM_REQUEST_META,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LOG_TIMES' });
  });

  it('still completes when the machine log cannot be closed', async () => {
    const { service, machineLogs, logger, saved } = setup({
      event: event({ status: MaintenanceEventStatus.IN_PROGRESS, startedAt: NOW, machineLogId: 900 }),
    });
    machineLogs.update.mockRejectedValue(new Error('machine state conflict'));
    await service.completeEvent(50, { releaseMachine: true }, technician, SYSTEM_REQUEST_META);
    expect(saved.events[0]).toMatchObject({ status: MaintenanceEventStatus.COMPLETED });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('leaves an already closed machine log alone', async () => {
    const { service, machineLogs } = setup({
      event: event({ status: MaintenanceEventStatus.IN_PROGRESS, startedAt: NOW, machineLogId: 900 }),
    });
    machineLogs.getById.mockResolvedValue({ id: 900, version: 3, logStatus: LogStatus.CLOSED } as MachineLog);
    await service.completeEvent(50, { releaseMachine: true }, technician, SYSTEM_REQUEST_META);
    expect(machineLogs.update).not.toHaveBeenCalled();
  });

  it('cancels and updates only open events', async () => {
    const open = setup();
    await open.service.cancelEvent(50, { reason: 'No longer needed' }, technician, SYSTEM_REQUEST_META);
    expect(open.saved.events[0]).toMatchObject({
      status: MaintenanceEventStatus.CANCELLED,
      notes: 'No longer needed',
    });

    const done = setup({ event: event({ status: MaintenanceEventStatus.COMPLETED, completedAt: NOW }) });
    await expect(done.service.cancelEvent(50, {}, technician, SYSTEM_REQUEST_META)).rejects.toMatchObject({
      code: 'MAINTENANCE_EVENT_STATE_CONFLICT',
    });
    await expect(
      done.service.updateEvent(50, { notes: 'x' }, technician, SYSTEM_REQUEST_META),
    ).rejects.toMatchObject({ code: 'MAINTENANCE_EVENT_STATE_CONFLICT' });
  });

  it('reports a missing event', async () => {
    const { service, repository } = setup();
    repository.findEventById.mockResolvedValue(null);
    await expect(service.getEvent(50)).rejects.toMatchObject({ code: 'MAINTENANCE_EVENT_NOT_FOUND' });
  });
});
