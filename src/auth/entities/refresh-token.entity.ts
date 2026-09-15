import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/user.entity';

export enum SessionRevocationReason {
  LOGOUT = 'LOGOUT',
  ROTATED = 'ROTATED',
  REUSE_DETECTED = 'REUSE_DETECTED',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  PASSWORD_RESET = 'PASSWORD_RESET',
  USER_DEACTIVATED = 'USER_DEACTIVATED',
}

/**
 * A refresh token issued to a session. Tokens issued by rotation share the
 * `family_id` of the original login, which also identifies the session in
 * access tokens (`sid`) so that revoking a family invalidates both.
 */
@Entity({ name: 'refresh_tokens' })
@Unique('UQ_refresh_tokens_token_hash', ['tokenHash'])
export class RefreshToken {
  @PrimaryColumn({ name: 'id', type: 'uuid', primaryKeyConstraintName: 'PK_refresh_tokens' })
  id: string;

  @Index('IDX_refresh_tokens_user_id')
  @Column({ name: 'user_id', type: 'integer' })
  userId: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_refresh_tokens_user_id' })
  user?: User;

  @Index('IDX_refresh_tokens_family_id')
  @Column({ name: 'family_id', type: 'uuid' })
  familyId: string;

  /** SHA-256 (hex) of the signed refresh token. The raw token is never stored. */
  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  @Index('IDX_refresh_tokens_expires_at')
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'revoked_reason', type: 'varchar', length: 32, nullable: true })
  revokedReason: SessionRevocationReason | null;

  @Column({ name: 'replaced_by_id', type: 'uuid', nullable: true })
  replacedById: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 512, nullable: true })
  userAgent: string | null;
}
