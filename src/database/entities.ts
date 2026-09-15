import { AuditLog } from '../audit/audit-log.entity';
import { PasswordResetToken } from '../auth/entities/password-reset-token.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { MachineLog } from '../machine-logs/machine-log.entity';
import { Machine } from '../machines/machine.entity';
import { User } from '../users/user.entity';

export const ENTITIES = [User, RefreshToken, PasswordResetToken, Machine, MachineLog, AuditLog];
