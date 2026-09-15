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
   * Current operational state. Only ever changed by machine-log operations
   * (see MachineLogsService); no API accepts it directly.
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
