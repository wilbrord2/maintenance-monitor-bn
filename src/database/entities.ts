import { AuditLog } from '../audit/audit-log.entity';
import { PasswordResetToken } from '../auth/entities/password-reset-token.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { MachineLog } from '../machine-logs/machine-log.entity';
import { MachinePart } from '../machine-parts/machine-part.entity';
import { Machine } from '../machines/machine.entity';
import { MaintenanceEvent } from '../maintenance/maintenance-event.entity';
import { MaintenanceNotification } from '../maintenance/maintenance-notification.entity';
import { MaintenanceSchedule } from '../maintenance/maintenance-schedule.entity';
import { User } from '../users/user.entity';

export const ENTITIES = [
  User,
  RefreshToken,
  PasswordResetToken,
  Machine,
  MachineLog,
  MachinePart,
  MaintenanceSchedule,
  MaintenanceEvent,
  MaintenanceNotification,
  AuditLog,
];
