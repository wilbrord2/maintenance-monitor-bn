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
import { MaintenanceEventStatus } from '../common/enums/maintenance.enums';
import { MachineLog } from '../machine-logs/machine-log.entity';
import { Machine } from '../machines/machine.entity';
import { User } from '../users/user.entity';
import { MaintenanceSchedule } from './maintenance-schedule.entity';

/**
 * One execution of preventive maintenance. Created from a schedule (or ad hoc)
 * and completed by a technician; the completion time drives the next cycle.
 */
@Entity({ name: 'maintenance_events' })
@Check('CHK_maintenance_events_in_progress_started', `"status" <> 'IN_PROGRESS' OR "started_at" IS NOT NULL`)
@Check('CHK_maintenance_events_completed_at', `("status" = 'COMPLETED') = ("completed_at" IS NOT NULL)`)
@Check(
  'CHK_maintenance_events_completed_after_started',
  `"completed_at" IS NULL OR "started_at" IS NULL OR "completed_at" >= "started_at"`,
)
export class MaintenanceEvent {
  @PrimaryGeneratedColumn('increment', { name: 'id', primaryKeyConstraintName: 'PK_maintenance_events' })
  id: number;

  /** Null for one-off maintenance that is not part of a recurring plan. */
  @Index('IDX_maintenance_events_schedule_id')
  @Column({ name: 'maintenance_schedule_id', type: 'integer', nullable: true })
  maintenanceScheduleId: number | null;

  @ManyToOne(() => MaintenanceSchedule, { nullable: true, onDelete: 'SET NULL', onUpdate: 'NO ACTION' })
  @JoinColumn({
    name: 'maintenance_schedule_id',
    foreignKeyConstraintName: 'FK_maintenance_events_schedule_id',
  })
  maintenanceSchedule?: MaintenanceSchedule | null;

  @Index('IDX_maintenance_events_machine_id')
  @Column({ name: 'machine_id', type: 'integer' })
  machineId: number;

  @ManyToOne(() => Machine, { nullable: false, onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'machine_id', foreignKeyConstraintName: 'FK_maintenance_events_machine_id' })
  machine?: Machine;

  /** Technician who performed the maintenance; kept when the user is removed. */
  @Column({ name: 'performed_by_id', type: 'integer', nullable: true })
  performedById: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'performed_by_id', foreignKeyConstraintName: 'FK_maintenance_events_performed_by_id' })
  performedBy?: User | null;

  /** Machine log opened when the maintenance started, linking it to the machine workflow. */
  @Column({ name: 'machine_log_id', type: 'integer', nullable: true })
  machineLogId: number | null;

  @ManyToOne(() => MachineLog, { nullable: true, onDelete: 'SET NULL', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'machine_log_id', foreignKeyConstraintName: 'FK_maintenance_events_machine_log_id' })
  machineLog?: MachineLog | null;

  @Index('IDX_maintenance_events_scheduled_for')
  @Column({ name: 'scheduled_for', type: 'timestamptz' })
  scheduledFor: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Index('IDX_maintenance_events_status')
  @Column({
    name: 'status',
    type: 'enum',
    enum: MaintenanceEventStatus,
    enumName: 'maintenance_event_status',
    default: MaintenanceEventStatus.SCHEDULED,
  })
  status: MaintenanceEventStatus;

  @Column({ name: 'notes', type: 'varchar', length: 2000, nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
