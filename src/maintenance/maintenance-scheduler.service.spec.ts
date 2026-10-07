import { type AuditService } from '../audit/audit.service';
import { MaintenanceReminderKind } from '../common/enums/maintenance.enums';
import { type DomainEventBus } from '../common/events/domain-event-bus';
import { type AppLogger } from '../common/logger/logger';
import { type MailService } from '../notifications/mail/mail.service';
import { type UsersRepository } from '../users/users.repository';
import { type MaintenanceSchedule } from './maintenance-schedule.entity';
import { MaintenanceSchedulerService } from './maintenance-scheduler.service';
import { type MaintenanceRepository } from './maintenance.repository';

const NOW = new Date('2026-10-05T09:00:00Z');
const DAY = 86_400_000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY);

const schedule = (overrides: Partial<MaintenanceSchedule> = {}): MaintenanceSchedule =>
  ({
    id: 1,
    machineId: 10,
    machinePartId: null,
    machinePart: null,
    taskName: 'General maintenance',
    description: null,
    intervalDays: 20,
    lastMaintenanceAt: inDays(-20),
    nextMaintenanceAt: NOW,
    reminderDaysBefore: 3,
    isActive: true,
    machine: { id: 10, name: 'Press 1', serialNumber: 'PRS-1' },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }) as MaintenanceSchedule;

function setup(schedules: MaintenanceSchedule[], options: { recorded?: boolean } = {}) {
  const repository = {
    findActiveSchedulesDueBefore: jest.fn().mockResolvedValue(schedules),
    recordNotification: jest.fn().mockResolvedValue(options.recorded ?? true),
    markEventsMissed: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<MaintenanceRepository>;
  const users = {
    findNotificationRecipients: jest.fn().mockResolvedValue([
      { id: 1, email: 'admin@example.test', fullName: 'Admin', role: 'ADMIN' },
      { id: 2, email: 'tech@example.test', fullName: 'Tech', role: 'TECHNICIAN' },
    ]),
  } as unknown as jest.Mocked<UsersRepository>;
  const mail = {
    sendMaintenanceDigest: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MailService>;
  const audit = { record: jest.fn() } as unknown as jest.Mocked<AuditService>;
  const events = { publish: jest.fn() } as unknown as jest.Mocked<DomainEventBus>;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as jest.Mocked<AppLogger>;

  const service = new MaintenanceSchedulerService(
    repository,
    users,
    mail,
    audit,
    events,
    { now: () => NOW },
    logger,
  );
  return { service, repository, users, mail, audit, events, logger };
}

describe('MaintenanceSchedulerService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does nothing when no schedule is in range', async () => {
    const { service, users } = setup([]);
    await expect(service.run()).resolves.toEqual({ examined: 0, remindersSent: 0, eventsMissed: 0 });
    expect(users.findNotificationRecipients).not.toHaveBeenCalled();
  });

  it('reminds every active user once for a due schedule', async () => {
    const { service, repository, mail, events, audit } = setup([schedule()]);
    const result = await service.run();

    expect(result).toMatchObject({ examined: 1, remindersSent: 1 });
    expect(repository.recordNotification).toHaveBeenCalledWith({
      maintenanceScheduleId: 1,
      kind: MaintenanceReminderKind.DUE,
      cycleDueOn: '2026-10-05',
      recipients: 2,
    });
    expect(mail.sendMaintenanceDigest).toHaveBeenCalledTimes(2);
    expect(mail.sendMaintenanceDigest).toHaveBeenCalledWith({
      to: 'admin@example.test',
      fullName: 'Admin',
      items: [
        expect.objectContaining({
          machineName: 'Press 1',
          partName: null,
          taskName: 'General maintenance',
          state: 'DUE',
          dueOn: '2026-10-05',
          daysUntilDue: 0,
        }),
      ],
    });
    expect(events.publish).toHaveBeenCalledWith(
      'maintenance.reminder',
      expect.objectContaining({ state: 'DUE' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MAINTENANCE_REMINDER_SENT', actorId: null }),
    );
  });

  it('sends one digest per recipient for all part and machine tasks of a run', async () => {
    const { service, mail, events } = setup([
      schedule(),
      schedule({
        id: 2,
        machinePartId: 7,
        machinePart: { id: 7, name: 'Cutting head', partCode: 'P01' } as MaintenanceSchedule['machinePart'],
        taskName: 'Cutting head',
        intervalDays: 7,
        nextMaintenanceAt: inDays(-1),
      }),
    ]);
    await expect(service.run()).resolves.toMatchObject({ remindersSent: 2 });

    expect(events.publish).toHaveBeenCalledTimes(2);
    expect(events.publish).toHaveBeenCalledWith(
      'maintenance.reminder',
      expect.objectContaining({
        scheduleId: 2,
        machinePartId: 7,
        partName: 'Cutting head',
        state: 'OVERDUE',
      }),
    );
    expect(mail.sendMaintenanceDigest).toHaveBeenCalledTimes(2);
    expect(mail.sendMaintenanceDigest.mock.calls[0]![0].items).toHaveLength(2);
  });

  it('skips schedules outside their reminder window', async () => {
    const { service, repository, mail } = setup([
      schedule({ nextMaintenanceAt: inDays(10), reminderDaysBefore: 3 }),
    ]);
    await expect(service.run()).resolves.toMatchObject({ examined: 1, remindersSent: 0 });
    expect(repository.recordNotification).not.toHaveBeenCalled();
    expect(mail.sendMaintenanceDigest).not.toHaveBeenCalled();
  });

  it('sends nothing when the reminder was already recorded for this cycle', async () => {
    const { service, mail, events } = setup([schedule()], { recorded: false });
    await expect(service.run()).resolves.toMatchObject({ remindersSent: 0 });
    expect(mail.sendMaintenanceDigest).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('marks events from past cycles as MISSED for overdue schedules', async () => {
    const { service, repository, audit } = setup([schedule({ nextMaintenanceAt: inDays(-4) })]);
    repository.markEventsMissed.mockResolvedValue([81, 82]);
    const result = await service.run();

    expect(result).toMatchObject({ remindersSent: 1, eventsMissed: 2 });
    expect(repository.recordNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: MaintenanceReminderKind.OVERDUE }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MAINTENANCE_MISSED', entityId: 81 }),
    );
  });

  it('keeps going when a reminder email fails', async () => {
    const { service, mail, logger } = setup([schedule()]);
    mail.sendMaintenanceDigest.mockRejectedValueOnce(new Error('smtp down'));
    await expect(service.run()).resolves.toMatchObject({ remindersSent: 1 });
    expect(logger.warn).toHaveBeenCalled();
    expect(mail.sendMaintenanceDigest).toHaveBeenCalledTimes(2);
  });

  it('falls back to the machine id when the relation is missing', async () => {
    const { service, mail } = setup([schedule({ machine: undefined })]);
    await service.run();
    expect(mail.sendMaintenanceDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ machineName: 'Machine 10', serialNumber: '' })],
      }),
    );
  });

  it('runs immediately, then on an interval, until stopped', async () => {
    jest.useFakeTimers();
    const { service, repository, logger } = setup([]);
    repository.findActiveSchedulesDueBefore.mockRejectedValueOnce(new Error('db down'));

    service.start(1000);
    service.start(1000); // idempotent
    await jest.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2000);
    expect(repository.findActiveSchedulesDueBefore).toHaveBeenCalledTimes(3);

    service.stop();
    await jest.advanceTimersByTimeAsync(5000);
    expect(repository.findActiveSchedulesDueBefore).toHaveBeenCalledTimes(3);
  });
});
