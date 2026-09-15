import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/user.entity';

@Entity({ name: 'password_reset_tokens' })
@Unique('UQ_password_reset_tokens_token_hash', ['tokenHash'])
export class PasswordResetToken {
  @PrimaryGeneratedColumn('increment', { name: 'id', primaryKeyConstraintName: 'PK_password_reset_tokens' })
  id: number;

  @Index('IDX_password_reset_tokens_user_id')
  @Column({ name: 'user_id', type: 'integer' })
  userId: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_password_reset_tokens_user_id' })
  user?: User;

  /** SHA-256 (hex) of the emailed token. The raw token is never stored. */
  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true })
  ipAddress: string | null;
}
