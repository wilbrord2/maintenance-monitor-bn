import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../common/database/transformers';
import { LogStatus } from '../common/enums/log-status.enum';
import { MachineState } from '../common/enums/machine-state.enum';
import { Machine } from '../machines/machine.entity';
import { User } from '../users/user.entity';

@Entity({ name: 'machine_logs' })
@Index('IDX_machine_logs_machine_id_created_at', ['machineId', 'createdAt'])
@Check('CHK_machine_logs_downtime_non_negative', `"downtime_hours" >= 0`)
@Check('CHK_machine_logs_ended_after_started', `"ended_at" IS NULL OR "ended_at" >= "started_at"`)
@Check(
  'CHK_machine_logs_status_end_time',
  `("log_status" = 'OPEN' AND "ended_at" IS NULL) OR ("log_status" = 'CLOSED' AND "ended_at" IS NOT NULL)`,
)
export class MachineLog {
  @PrimaryGeneratedColumn('increment', { name: 'id', primaryKeyConstraintName: 'PK_machine_logs' })
  id: number;

  @Column({ name: 'machine_id', type: 'integer' })
  machineId: number;

  @ManyToOne(() => Machine, { nullable: false, onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'machine_id', foreignKeyConstraintName: 'FK_machine_logs_machine_id' })
  machine?: Machine;

  @Index('IDX_machine_logs_user_id')
  @Column({ name: 'user_id', type: 'integer' })
  userId: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_machine_logs_user_id' })
  user?: User;

  @Column({ name: 'fault_description', type: 'varchar', length: 2000 })
  faultDescription: string;

  @Column({ name: 'cause_description', type: 'varchar', length: 2000, nullable: true })
  causeDescription: string | null;

  /** Machine state when the event was recorded; also the optimistic "expected state". Immutable. */
  @Column({ name: 'entry_status', type: 'enum', enum: MachineState, enumName: 'machine_state' })
  entryStatus: MachineState;

  @Column({ name: 'remedy_action', type: 'varchar', length: 2000, nullable: true })
  remedyAction: string | null;

  @Index('IDX_machine_logs_resulting_state')
  @Column({ name: 'resulting_state', type: 'enum', enum: MachineState, enumName: 'machine_state' })
  resultingState: MachineState;

  @Column({
    name: 'downtime_hours',
    type: 'numeric',
    precision: 10,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  downtimeHours: number;

  @Index('IDX_machine_logs_log_status')
  @Column({
    name: 'log_status',
    type: 'enum',
    enum: LogStatus,
    enumName: 'log_status',
    default: LogStatus.OPEN,
  })
  logStatus: LogStatus;

  @Column({ name: 'next_maintenance_plan', type: 'varchar', length: 1000, nullable: true })
  nextMaintenancePlan: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'now()' })
  startedAt: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  /** Incremented on every update; clients send it back to detect concurrent edits. */
  @Column({ name: 'version', type: 'integer', default: 1 })
  version: number;

  @Index('IDX_machine_logs_created_at')
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
