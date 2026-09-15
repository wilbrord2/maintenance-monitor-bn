import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Role } from '../common/enums/role.enum';

@Entity({ name: 'users' })
@Unique('UQ_users_email', ['email'])
@Unique('UQ_users_phone', ['phone'])
@Check('CHK_users_email_lowercase', `"email" = lower("email")`)
@Check('CHK_users_failed_login_attempts', `"failed_login_attempts" >= 0`)
export class User {
  @PrimaryGeneratedColumn('increment', { name: 'id', primaryKeyConstraintName: 'PK_users' })
  id: number;

  @Column({ name: 'full_name', type: 'varchar', length: 120 })
  fullName: string;

  @Column({ name: 'email', type: 'varchar', length: 254 })
  email: string;

  @Column({ name: 'phone', type: 'varchar', length: 20 })
  phone: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash: string;

  @Column({ name: 'position', type: 'varchar', length: 100, nullable: true })
  position: string | null;

  @Column({ name: 'role', type: 'enum', enum: Role, enumName: 'user_role', default: Role.TECHNICIAN })
  role: Role;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'must_change_password', type: 'boolean', default: false })
  mustChangePassword: boolean;

  /** Expiry of a temporary (onboarding) credential. NULL for a user-chosen password. */
  @Column({ name: 'password_expires_at', type: 'timestamptz', nullable: true })
  passwordExpiresAt: Date | null;

  @Column({ name: 'password_changed_at', type: 'timestamptz', nullable: true })
  passwordChangedAt: Date | null;

  @Column({ name: 'failed_login_attempts', type: 'integer', default: 0 })
  failedLoginAttempts: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
