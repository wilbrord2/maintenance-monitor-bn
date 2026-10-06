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
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { MachineState } from '../common/enums/machine-state.enum';
import { OperationalImpact } from '../common/enums/operational-impact.enum';
import { Machine } from '../machines/machine.entity';

/**
 * A component of a machine with its own status. The machine's operational
 * status is derived from its parts (see MachineStatusResolver).
 *
 * `status` uses the shared `machine_state` enum (ACTIVE, UNDER_MAINTENANCE,
 * DOWNTIME, UNDER_TEST). `operational_impact` records whether the *current*
 * condition stops the machine; `is_critical` is the part's configured default
 * for that impact.
 */
@Entity({ name: 'machine_parts' })
@Unique('UQ_machine_parts_machine_id_part_code', ['machineId', 'partCode'])
@Check('CHK_machine_parts_part_code_uppercase', `"part_code" = upper("part_code")`)
@Check(
  'CHK_machine_parts_active_is_non_blocking',
  `"status" <> 'ACTIVE' OR "operational_impact" = 'NON_BLOCKING'`,
)
export class MachinePart {
  @PrimaryGeneratedColumn('increment', { name: 'id', primaryKeyConstraintName: 'PK_machine_parts' })
  id: number;

  @Index('IDX_machine_parts_machine_id')
  @Column({ name: 'machine_id', type: 'integer' })
  machineId: number;

  @ManyToOne(() => Machine, { nullable: false, onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'machine_id', foreignKeyConstraintName: 'FK_machine_parts_machine_id' })
  machine?: Machine;

  @Column({ name: 'name', type: 'varchar', length: 120 })
  name: string;

  /** Unique within its machine (e.g. "A1"). */
  @Column({ name: 'part_code', type: 'varchar', length: 64 })
  partCode: string;

  @Column({ name: 'description', type: 'varchar', length: 2000, nullable: true })
  description: string | null;

  /** Changed only through part-log operations (see MachinePartsService). */
  @Index('IDX_machine_parts_status')
  @Column({
    name: 'status',
    type: 'enum',
    enum: MachineState,
    enumName: 'machine_state',
    default: MachineState.ACTIVE,
  })
  status: MachineState;

  /** Impact of the current condition. Always NON_BLOCKING while the part is ACTIVE. */
  @Column({
    name: 'operational_impact',
    type: 'enum',
    enum: OperationalImpact,
    enumName: 'operational_impact',
    default: OperationalImpact.NON_BLOCKING,
  })
  operationalImpact: OperationalImpact;

  /** Whether failure of this part normally stops the machine; the default impact for new conditions. */
  @Column({ name: 'is_critical', type: 'boolean', default: false })
  isCritical: boolean;

  /** Deactivated parts are ignored by status resolution (e.g. removed from the machine). */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
