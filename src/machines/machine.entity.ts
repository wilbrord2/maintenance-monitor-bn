import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { MachineOperationalStatus } from '../common/enums/machine-operational-status.enum';
import { MachineState } from '../common/enums/machine-state.enum';

@Entity({ name: 'machines' })
@Unique('UQ_machines_serial_number', ['serialNumber'])
@Check('CHK_machines_serial_number_uppercase', `"serial_number" = upper("serial_number")`)
export class Machine {
  @PrimaryGeneratedColumn('increment', { name: 'id', primaryKeyConstraintName: 'PK_machines' })
  id: number;

  @Column({ name: 'name', type: 'varchar', length: 120 })
  name: string;

  @Column({ name: 'serial_number', type: 'varchar', length: 64 })
  serialNumber: string;

  /**
   * Effective machine status: the most severe of `systemStatus` and the status
   * of every active part. Derived by MachineStatusResolver and written only by
   * MachineStatusSynchronizer; no API accepts it directly.
   */
  @Index('IDX_machines_status')
  @Column({
    name: 'status',
    type: 'enum',
    enum: MachineState,
    enumName: 'machine_state',
    default: MachineState.ACTIVE,
  })
  status: MachineState;

  /**
   * State of the machine as a whole system, independent of its parts. Equals
   * the resulting state of the latest MACHINE-scope log (see MachineLogsService).
   * For a machine without parts it is the same as `status`.
   */
  @Column({
    name: 'system_status',
    type: 'enum',
    enum: MachineState,
    enumName: 'machine_state',
    default: MachineState.ACTIVE,
  })
  systemStatus: MachineState;

  /**
   * Whether the machine as a whole can operate. Derived from its parts and
   * `systemStatus` by MachineStatusResolver; no API sets it.
   */
  @Index('IDX_machines_operational_status')
  @Column({
    name: 'operational_status',
    type: 'enum',
    enum: MachineOperationalStatus,
    enumName: 'machine_operational_status',
    default: MachineOperationalStatus.OPERATING,
  })
  operationalStatus: MachineOperationalStatus;

  @Column({ name: 'description', type: 'varchar', length: 2000, nullable: true })
  description: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
