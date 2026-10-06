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
import { LogScope } from '../common/enums/log-scope.enum';
import { LogStatus } from '../common/enums/log-status.enum';
import { MachineOperationalStatus } from '../common/enums/machine-operational-status.enum';
import { MachineState } from '../common/enums/machine-state.enum';
import { OperationalImpact } from '../common/enums/operational-impact.enum';
import { MachinePart } from '../machine-parts/machine-part.entity';
import { Machine } from '../machines/machine.entity';
import { User } from '../users/user.entity';

/**
 * One history for a machine: events concerning the whole machine system
 * (`scope = MACHINE`) and events concerning one of its parts (`scope = PART`).
 * `entryStatus`/`resultingState` describe the log's subject (machine system or
 * part); the `machineStatus*`/`operationalStatus*` snapshots record the
 * machine's synced status before and after the event.
 */
@Entity({ name: 'machine_logs' })
@Index('IDX_machine_logs_machine_id_created_at', ['machineId', 'createdAt'])
@Index('IDX_machine_logs_machine_part_id_created_at', ['machinePartId', 'createdAt'])
@Check(
  'CHK_machine_logs_scope_part',
  `("scope" = 'MACHINE' AND "machine_part_id" IS NULL AND "operational_impact" IS NULL) OR ("scope" = 'PART' AND "machine_part_id" IS NOT NULL AND "operational_impact" IS NOT NULL)`,
)
@Check(
  'CHK_machine_logs_active_part_is_non_blocking',
  `"operational_impact" IS NULL OR "resulting_state" <> 'ACTIVE' OR "operational_impact" = 'NON_BLOCKING'`,
)
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

  @Index('IDX_machine_logs_scope')
  @Column({ name: 'scope', type: 'enum', enum: LogScope, enumName: 'log_scope', default: LogScope.MACHINE })
  scope: LogScope;

  /** The part this log concerns; null for whole-machine logs. */
  @Column({ name: 'machine_part_id', type: 'integer', nullable: true })
  machinePartId: number | null;

  @ManyToOne(() => MachinePart, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'machine_part_id', foreignKeyConstraintName: 'FK_machine_logs_machine_part_id' })
  machinePart?: MachinePart | null;

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

  /**
   * State of the log's subject (the machine system, or the part) when the event
   * was recorded; also the optimistic "expected state". Immutable.
   */
  @Column({ name: 'entry_status', type: 'enum', enum: MachineState, enumName: 'machine_state' })
  entryStatus: MachineState;

  @Column({ name: 'remedy_action', type: 'varchar', length: 2000, nullable: true })
  remedyAction: string | null;

  @Index('IDX_machine_logs_resulting_state')
  @Column({ name: 'resulting_state', type: 'enum', enum: MachineState, enumName: 'machine_state' })
  resultingState: MachineState;

  /** PART logs only: whether the part's resulting condition stops the machine. */
  @Column({
    name: 'operational_impact',
    type: 'enum',
    enum: OperationalImpact,
    enumName: 'operational_impact',
    nullable: true,
  })
  operationalImpact: OperationalImpact | null;

  /** The machine's effective status just before this event (already synced with its parts). */
  @Column({ name: 'machine_status_before', type: 'enum', enum: MachineState, enumName: 'machine_state' })
  machineStatusBefore: MachineState;

  /** The machine's effective status after this event was applied. */
  @Column({ name: 'machine_status_after', type: 'enum', enum: MachineState, enumName: 'machine_state' })
  machineStatusAfter: MachineState;

  @Column({
    name: 'operational_status_before',
    type: 'enum',
    enum: MachineOperationalStatus,
    enumName: 'machine_operational_status',
  })
  operationalStatusBefore: MachineOperationalStatus;

  @Column({
    name: 'operational_status_after',
    type: 'enum',
    enum: MachineOperationalStatus,
    enumName: 'machine_operational_status',
  })
  operationalStatusAfter: MachineOperationalStatus;

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
