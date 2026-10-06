import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { MaintenanceReminderKind } from '../common/enums/maintenance.enums';
import { MaintenanceSchedule } from './maintenance-schedule.entity';

/**
 * Record of a reminder already sent. The unique constraint on
 * (schedule, kind, cycle) makes the reminder job idempotent: re-running it
 * never notifies twice for the same maintenance cycle.
 */
@Entity({ name: 'maintenance_notifications' })
@Unique('UQ_maintenance_notifications_schedule_kind_cycle', ['maintenanceScheduleId', 'kind', 'cycleDueOn'])
export class MaintenanceNotification {
  @PrimaryGeneratedColumn('increment', {
    name: 'id',
    primaryKeyConstraintName: 'PK_maintenance_notifications',
  })
  id: number;

  @Column({ name: 'maintenance_schedule_id', type: 'integer' })
  maintenanceScheduleId: number;

  @ManyToOne(() => MaintenanceSchedule, { nullable: false, onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
  @JoinColumn({
    name: 'maintenance_schedule_id',
    foreignKeyConstraintName: 'FK_maintenance_notifications_schedule_id',
  })
  maintenanceSchedule?: MaintenanceSchedule;

  @Column({
    name: 'kind',
    type: 'enum',
    enum: MaintenanceReminderKind,
    enumName: 'maintenance_reminder_kind',
  })
  kind: MaintenanceReminderKind;

  /** The due date (UTC calendar day) this reminder refers to; identifies the cycle. */
  @Column({ name: 'cycle_due_on', type: 'date' })
  cycleDueOn: string;

  @Column({ name: 'recipients', type: 'integer', default: 0 })
  recipients: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
