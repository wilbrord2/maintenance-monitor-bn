import { type DataSource, type EntityManager, In, LessThanOrEqual } from 'typeorm';
import { MaintenanceEventStatus, type MaintenanceReminderKind } from '../common/enums/maintenance.enums';
import { buildPage, toOffset, type Page, type PageRequest } from '../common/pagination/pagination';
import { MaintenanceEvent } from './maintenance-event.entity';
import { MaintenanceNotification } from './maintenance-notification.entity';
import { MaintenanceSchedule } from './maintenance-schedule.entity';

export const MAINTENANCE_EVENT_SORT_FIELDS = [
  'scheduledFor',
  'startedAt',
  'completedAt',
  'createdAt',
] as const;
export type MaintenanceEventSortField = (typeof MAINTENANCE_EVENT_SORT_FIELDS)[number];

export interface MaintenanceEventFilters {
  readonly machineId?: number;
  readonly maintenanceScheduleId?: number;
  readonly status?: MaintenanceEventStatus;
  readonly performedById?: number;
  readonly from?: Date;
  readonly to?: Date;
}

/** Non-terminal events: the work is still expected. */
const OPEN_EVENT_STATUSES = [MaintenanceEventStatus.SCHEDULED, MaintenanceEventStatus.IN_PROGRESS];

export class MaintenanceRepository {
  constructor(private readonly dataSource: DataSource) {}

  private schedules(manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).getRepository(MaintenanceSchedule);
  }

  private events(manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).getRepository(MaintenanceEvent);
  }

  private notifications(manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).getRepository(MaintenanceNotification);
  }

  // ------------------------------------------------------------------ schedules

  createSchedule(values: Partial<MaintenanceSchedule>): MaintenanceSchedule {
    return this.schedules().create(values);
  }

  saveSchedule(schedule: MaintenanceSchedule, manager?: EntityManager): Promise<MaintenanceSchedule> {
    return this.schedules(manager).save(schedule);
  }

  findScheduleByMachine(machineId: number, manager?: EntityManager): Promise<MaintenanceSchedule | null> {
    return this.schedules(manager).findOne({ where: { machineId } });
  }

  /** Locks the schedule row; used when rolling the cycle forward. */
  findScheduleByIdForUpdate(id: number, manager: EntityManager): Promise<MaintenanceSchedule | null> {
    return this.schedules(manager)
      .createQueryBuilder('schedule')
      .setLock('pessimistic_write')
      .where('schedule.id = :id', { id })
      .getOne();
  }

  /** Active schedules due on or before `until`, oldest due date first (for the reminder job). */
  findActiveSchedulesDueBefore(until: Date): Promise<MaintenanceSchedule[]> {
    return this.schedules().find({
      where: { isActive: true, nextMaintenanceAt: LessThanOrEqual(until) },
      relations: { machine: true },
      order: { nextMaintenanceAt: 'ASC' },
    });
  }

  async findSchedulesPage(
    filters: { state?: 'due' | 'overdue' | 'upcoming'; now: Date; isActive?: boolean },
    page: PageRequest,
  ): Promise<Page<MaintenanceSchedule>> {
    const query = this.schedules()
      .createQueryBuilder('schedule')
      .innerJoinAndSelect('schedule.machine', 'machine');
    if (filters.isActive !== undefined) {
      query.andWhere('schedule.isActive = :isActive', { isActive: filters.isActive });
    }
    // Calendar-day comparisons in UTC keep "due today" aligned with the derived state.
    if (filters.state === 'overdue') {
      query.andWhere(`date_trunc('day', schedule.nextMaintenanceAt) < date_trunc('day', :now::timestamptz)`);
    } else if (filters.state === 'due') {
      query.andWhere(`date_trunc('day', schedule.nextMaintenanceAt) = date_trunc('day', :now::timestamptz)`);
    } else if (filters.state === 'upcoming') {
      query.andWhere(`date_trunc('day', schedule.nextMaintenanceAt) > date_trunc('day', :now::timestamptz)`);
      query.andWhere(
        `schedule.nextMaintenanceAt <= :now::timestamptz + make_interval(days => schedule.reminderDaysBefore)`,
      );
    }
    query.setParameter('now', filters.now);

    const [items, total] = await query
      .orderBy('schedule.nextMaintenanceAt', 'ASC')
      .addOrderBy('schedule.id', 'ASC')
      .skip(toOffset(page))
      .take(page.limit)
      .getManyAndCount();
    return buildPage(items, total, page);
  }

  // --------------------------------------------------------------------- events

  createEvent(values: Partial<MaintenanceEvent>): MaintenanceEvent {
    return this.events().create(values);
  }

  saveEvent(event: MaintenanceEvent, manager?: EntityManager): Promise<MaintenanceEvent> {
    return this.events(manager).save(event);
  }

  findEventById(id: number, manager?: EntityManager): Promise<MaintenanceEvent | null> {
    return this.events(manager)
      .createQueryBuilder('event')
      .withDeleted()
      .leftJoinAndSelect('event.machine', 'machine')
      .leftJoinAndSelect('event.performedBy', 'performedBy')
      .leftJoinAndSelect('event.maintenanceSchedule', 'schedule')
      .where('event.id = :id', { id })
      .getOne();
  }

  findEventByIdForUpdate(id: number, manager: EntityManager): Promise<MaintenanceEvent | null> {
    return this.events(manager)
      .createQueryBuilder('event')
      .setLock('pessimistic_write')
      .where('event.id = :id', { id })
      .getOne();
  }

  /** The schedule's event that is still open (SCHEDULED or IN_PROGRESS), if any. */
  findOpenEventForSchedule(
    maintenanceScheduleId: number,
    manager?: EntityManager,
  ): Promise<MaintenanceEvent | null> {
    return this.events(manager).findOne({
      where: { maintenanceScheduleId, status: In(OPEN_EVENT_STATUSES) },
      order: { scheduledFor: 'ASC' },
    });
  }

  async findEventsPage(
    filters: MaintenanceEventFilters,
    sort: { sortBy: MaintenanceEventSortField; sortOrder: 'asc' | 'desc' },
    page: PageRequest,
  ): Promise<Page<MaintenanceEvent>> {
    const query = this.events()
      .createQueryBuilder('event')
      .withDeleted()
      .leftJoinAndSelect('event.machine', 'machine')
      .leftJoinAndSelect('event.performedBy', 'performedBy');
    if (filters.machineId !== undefined) {
      query.andWhere('event.machineId = :machineId', { machineId: filters.machineId });
    }
    if (filters.maintenanceScheduleId !== undefined) {
      query.andWhere('event.maintenanceScheduleId = :scheduleId', {
        scheduleId: filters.maintenanceScheduleId,
      });
    }
    if (filters.status) query.andWhere('event.status = :status', { status: filters.status });
    if (filters.performedById !== undefined) {
      query.andWhere('event.performedById = :performedById', { performedById: filters.performedById });
    }
    if (filters.from) query.andWhere('event.scheduledFor >= :from', { from: filters.from });
    if (filters.to) query.andWhere('event.scheduledFor < :to', { to: filters.to });

    const direction = sort.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const [items, total] = await query
      .orderBy(`event.${sort.sortBy}`, direction, direction === 'ASC' ? 'NULLS FIRST' : 'NULLS LAST')
      .addOrderBy('event.id', direction)
      .skip(toOffset(page))
      .take(page.limit)
      .getManyAndCount();
    return buildPage(items, total, page);
  }

  /** Marks still-open events whose cycle has passed as MISSED. Returns the ids affected. */
  async markEventsMissed(scheduleId: number, before: Date, manager?: EntityManager): Promise<number[]> {
    const result = await this.events(manager)
      .createQueryBuilder()
      .update(MaintenanceEvent)
      .set({ status: MaintenanceEventStatus.MISSED })
      .where('maintenance_schedule_id = :scheduleId', { scheduleId })
      .andWhere('status = :scheduled', { scheduled: MaintenanceEventStatus.SCHEDULED })
      .andWhere('scheduled_for < :before', { before })
      .andWhere('completed_at IS NULL')
      .returning('"id"')
      .execute();
    return (result.raw as { id: number }[]).map((row) => row.id);
  }

  // -------------------------------------------------------------- notifications

  /**
   * Records that a reminder was sent. Returns false when one already existed
   * for this schedule, kind and cycle, which makes the reminder job idempotent.
   */
  async recordNotification(
    notification: {
      maintenanceScheduleId: number;
      kind: MaintenanceReminderKind;
      cycleDueOn: string;
      recipients: number;
    },
    manager?: EntityManager,
  ): Promise<boolean> {
    const result = await this.notifications(manager)
      .createQueryBuilder()
      .insert()
      .into(MaintenanceNotification)
      .values(notification)
      .orIgnore()
      .execute();
    return (result.identifiers.filter(Boolean) as unknown[]).length > 0;
  }
}
