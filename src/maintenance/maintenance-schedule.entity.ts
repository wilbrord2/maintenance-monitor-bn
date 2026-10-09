import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MachinePart } from '../machine-parts/machine-part.entity';
import { Machine } from '../machines/machine.entity';

/**
 * Recurring preventive-maintenance task. A machine has many: one per part
 * inspection (`machine_part_id` set, e.g. "Cutting head" weekly) and any number
 * of machine-wide tasks (`machine_part_id` null, e.g. "External cleaning" daily).
 * Task names are unique per part, and per machine among machine-wide tasks.
 *
 * `next_maintenance_at` is stored (so the scheduler can query it cheaply) and
 * always equals `last_maintenance_at + interval_days`, or the administrator's
 * explicit starting point when the machine has never been maintained.
 * The derived UPCOMING/DUE/OVERDUE state is computed on read, never stored.
 */
@Entity({ name: 'maintenance_schedules' })
@Index('UQ_maintenance_schedules_part_task', ['machinePartId', 'taskName'], {
  unique: true,
  where: '"machine_part_id" IS NOT NULL',
})
@Index('UQ_maintenance_schedules_machine_task', ['machineId', 'taskName'], {
  unique: true,
  where: '"machine_part_id" IS NULL',
})
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

  /** The part this task inspects; null for a machine-wide task. */
  @Index('IDX_maintenance_schedules_machine_part_id')
  @Column({ name: 'machine_part_id', type: 'integer', nullable: true })
  machinePartId: number | null;

  @ManyToOne(() => MachinePart, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({
    name: 'machine_part_id',
    foreignKeyConstraintName: 'FK_maintenance_schedules_machine_part_id',
  })
  machinePart?: MachinePart | null;

  @Column({ name: 'task_name', type: 'varchar', length: 160 })
  taskName: string;

  /** What to inspect or do. */
  @Column({ name: 'description', type: 'varchar', length: 2000, nullable: true })
  description: string | null;

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
