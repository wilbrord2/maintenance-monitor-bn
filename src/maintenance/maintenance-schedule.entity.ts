import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Machine } from '../machines/machine.entity';

/**
 * Recurring preventive-maintenance plan for a machine (one per machine).
 *
 * `next_maintenance_at` is stored (so the scheduler can query it cheaply) and
 * always equals `last_maintenance_at + interval_days`, or the administrator's
 * explicit starting point when the machine has never been maintained.
 * The derived UPCOMING/DUE/OVERDUE state is computed on read, never stored.
 */
@Entity({ name: 'maintenance_schedules' })
@Unique('UQ_maintenance_schedules_machine_id', ['machineId'])
@Check('CHK_maintenance_schedules_interval_days', `"interval_days" >= 1 AND "interval_days" <= 3650`)
@Check(
  'CHK_maintenance_schedules_reminder_days',
  `"reminder_days_before" >= 0 AND "reminder_days_before" <= "interval_days"`,
)
export class MaintenanceSchedule {
  @PrimaryGeneratedColumn('increment', {
    name: 'id',
    primaryKeyConstraintName: 'PK_maintenance_schedules',
  })
  id: number;

  @Column({ name: 'machine_id', type: 'integer' })
  machineId: number;

  @ManyToOne(() => Machine, { nullable: false, onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'machine_id', foreignKeyConstraintName: 'FK_maintenance_schedules_machine_id' })
  machine?: Machine;

  @Column({ name: 'interval_days', type: 'integer' })
  intervalDays: number;

  /** Completion time of the most recent maintenance; null when never maintained. */
  @Column({ name: 'last_maintenance_at', type: 'timestamptz', nullable: true })
  lastMaintenanceAt: Date | null;

  @Index('IDX_maintenance_schedules_next_maintenance_at')
  @Column({ name: 'next_maintenance_at', type: 'timestamptz' })
  nextMaintenanceAt: Date;

  /** How many days before the due date reminders start. */
  @Column({ name: 'reminder_days_before', type: 'integer', default: 3 })
  reminderDaysBefore: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
