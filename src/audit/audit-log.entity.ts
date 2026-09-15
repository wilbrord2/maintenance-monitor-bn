import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { type AuditAction, type AuditEntity } from './audit.constants';

export type AuditValues = Record<string, unknown>;

@Entity({ name: 'audit_logs' })
@Index('IDX_audit_logs_entity_entity_id', ['entity', 'entityId'])
export class AuditLog {
  @PrimaryGeneratedColumn('increment', {
    name: 'id',
    type: 'bigint',
    primaryKeyConstraintName: 'PK_audit_logs',
  })
  /** BIGINT: the pg driver returns it as a string to avoid precision loss. */
  id: string;

  @Index('IDX_audit_logs_user_id')
  @Column({ name: 'user_id', type: 'integer', nullable: true })
  userId: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_audit_logs_user_id' })
  user?: User | null;

  @Index('IDX_audit_logs_action')
  @Column({ name: 'action', type: 'varchar', length: 64 })
  action: AuditAction;

  @Column({ name: 'entity', type: 'varchar', length: 64 })
  entity: AuditEntity;

  @Column({ name: 'entity_id', type: 'varchar', length: 64, nullable: true })
  entityId: string | null;

  @Column({ name: 'old_values', type: 'jsonb', nullable: true })
  oldValues: AuditValues | null;

  @Column({ name: 'new_values', type: 'jsonb', nullable: true })
  newValues: AuditValues | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 512, nullable: true })
  userAgent: string | null;

  @Column({ name: 'request_id', type: 'varchar', length: 64, nullable: true })
  requestId: string | null;

  @Index('IDX_audit_logs_created_at')
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
