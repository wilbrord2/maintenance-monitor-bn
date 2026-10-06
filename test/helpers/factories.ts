import request from 'supertest';
import { LogScope } from '../../src/common/enums/log-scope.enum';
import { type MachineOperationalStatus } from '../../src/common/enums/machine-operational-status.enum';
import { MachineState } from '../../src/common/enums/machine-state.enum';
import { OperationalImpact } from '../../src/common/enums/operational-impact.enum';
import { Role } from '../../src/common/enums/role.enum';
import { MachineLog } from '../../src/machine-logs/machine-log.entity';
import { MachinePart } from '../../src/machine-parts/machine-part.entity';
import { Machine } from '../../src/machines/machine.entity';
import { MaintenanceSchedule } from '../../src/maintenance/maintenance-schedule.entity';
import { User } from '../../src/users/user.entity';
import { type TestContext } from './test-app';

export const TEST_PASSWORD = 'Correct-Horse-9-Battery';

let sequence = 0;
function next(): number {
  sequence += 1;
  return sequence;
}

export interface CreateUserOptions {
  readonly role?: Role;
  readonly email?: string;
  readonly phone?: string;
  readonly fullName?: string;
  readonly password?: string;
  readonly isActive?: boolean;
  readonly mustChangePassword?: boolean;
  readonly passwordExpiresAt?: Date | null;
}

/** Inserts a user directly (bypassing the API) with an Argon2id-hashed password. */
export async function createUser(ctx: TestContext, options: CreateUserOptions = {}): Promise<User> {
  const n = next();
  const repository = ctx.container.dataSource.getRepository(User);
  return repository.save(
    repository.create({
      fullName: options.fullName ?? `Test User ${n}`,
      email: options.email ?? `user${n}.${Date.now()}@example.test`,
      phone: options.phone ?? `07${String(10_000_000 + n).padStart(8, '0')}`,
      passwordHash: await ctx.container.services.hasher.hash(options.password ?? TEST_PASSWORD),
      position: 'Technician',
      role: options.role ?? Role.TECHNICIAN,
      isActive: options.isActive ?? true,
      mustChangePassword: options.mustChangePassword ?? false,
      passwordExpiresAt: options.passwordExpiresAt ?? null,
    }),
  );
}

export interface Session {
  readonly user: User;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly auth: { Authorization: string };
}

/** Returns the supertest chain (not a Promise) so callers can use `.expect(...)`. */
export function login(ctx: TestContext, email: string, password = TEST_PASSWORD) {
  return request(ctx.app).post('/api/v1/auth/login').send({ email, password });
}

export async function createSession(ctx: TestContext, options: CreateUserOptions = {}): Promise<Session> {
  const user = await createUser(ctx, options);
  const res = await login(ctx, user.email, options.password ?? TEST_PASSWORD);
  if (res.status !== 200)
    throw new Error(`Login failed in test setup: ${res.status} ${JSON.stringify(res.body)}`);
  const accessToken: string = res.body.data.tokens.accessToken;
  const refreshToken: string = res.body.data.tokens.refreshToken;
  return { user, accessToken, refreshToken, auth: { Authorization: `Bearer ${accessToken}` } };
}

export const adminSession = (ctx: TestContext) => createSession(ctx, { role: Role.ADMIN });
export const technicianSession = (ctx: TestContext) => createSession(ctx, { role: Role.TECHNICIAN });

/** Extracts the temporary password from an onboarding email captured by the in-memory transport. */
export function temporaryPasswordFrom(text: string): string {
  const match = /Temporary password: (\S+)/.exec(text);
  if (!match?.[1]) throw new Error('No temporary password found in email');
  return match[1];
}

export function resetTokenFrom(text: string): string {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(text);
  if (!match?.[1]) throw new Error('No reset token found in email');
  return match[1];
}

/** Waits for fire-and-forget work (e.g. email dispatch) scheduled during a request. */
export const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

export async function createMachine(
  ctx: TestContext,
  overrides: Partial<Pick<Machine, 'name' | 'serialNumber' | 'status' | 'isActive'>> = {},
): Promise<Machine> {
  const n = next();
  const repository = ctx.container.dataSource.getRepository(Machine);
  return repository.save(
    repository.create({
      name: overrides.name ?? `Machine ${n}`,
      serialNumber: overrides.serialNumber ?? `SN-${n}-${Date.now()}`,
      status: overrides.status ?? MachineState.ACTIVE,
      // A machine without parts: its system status is its status.
      systemStatus: overrides.status ?? MachineState.ACTIVE,
      isActive: overrides.isActive ?? true,
    }),
  );
}

export async function machineStatus(ctx: TestContext, machineId: number): Promise<MachineState> {
  const machine = await ctx.container.dataSource
    .getRepository(Machine)
    .findOneOrFail({ where: { id: machineId }, withDeleted: true });
  return machine.status;
}

export async function machineSystemStatus(ctx: TestContext, machineId: number): Promise<MachineState> {
  const machine = await ctx.container.dataSource
    .getRepository(Machine)
    .findOneOrFail({ where: { id: machineId }, withDeleted: true });
  return machine.systemStatus;
}

/**
 * Asserts the central invariant: a machine's system status equals the resulting
 * state of its most recent (non-deleted) whole-machine log. Returns that log, if any.
 */
export async function expectStatusMatchesLatestLog(
  ctx: TestContext,
  machineId: number,
): Promise<MachineLog | null> {
  const latest = await ctx.container.dataSource
    .getRepository(MachineLog)
    .findOne({ where: { machineId, scope: LogScope.MACHINE }, order: { id: 'DESC' } });
  if (latest) expect(await machineSystemStatus(ctx, machineId)).toBe(latest.resultingState);
  return latest;
}

export interface CreatePartOptions {
  readonly partCode?: string;
  readonly name?: string;
  readonly isCritical?: boolean;
  readonly status?: MachineState;
  readonly operationalImpact?: OperationalImpact;
  readonly isActive?: boolean;
}

/** Inserts a part directly, bypassing the API (used to arrange status scenarios). */
export async function createPart(
  ctx: TestContext,
  machineId: number,
  options: CreatePartOptions = {},
): Promise<MachinePart> {
  const n = next();
  const repository = ctx.container.dataSource.getRepository(MachinePart);
  const status = options.status ?? MachineState.ACTIVE;
  return repository.save(
    repository.create({
      machineId,
      partCode: options.partCode ?? `P${n}`,
      name: options.name ?? `Part ${n}`,
      isCritical: options.isCritical ?? false,
      status,
      operationalImpact:
        status === MachineState.ACTIVE
          ? OperationalImpact.NON_BLOCKING
          : (options.operationalImpact ?? OperationalImpact.NON_BLOCKING),
      isActive: options.isActive ?? true,
    }),
  );
}

export async function machineOperationalStatus(
  ctx: TestContext,
  machineId: number,
): Promise<MachineOperationalStatus> {
  const machine = await ctx.container.dataSource
    .getRepository(Machine)
    .findOneOrFail({ where: { id: machineId }, withDeleted: true });
  return machine.operationalStatus;
}

/** Inserts a maintenance schedule directly, so dates can be placed in the past. */
export async function createSchedule(
  ctx: TestContext,
  machineId: number,
  options: {
    intervalDays: number;
    nextMaintenanceAt: Date;
    lastMaintenanceAt?: Date | null;
    reminderDaysBefore?: number;
    isActive?: boolean;
  },
): Promise<MaintenanceSchedule> {
  const repository = ctx.container.dataSource.getRepository(MaintenanceSchedule);
  return repository.save(
    repository.create({
      machineId,
      intervalDays: options.intervalDays,
      nextMaintenanceAt: options.nextMaintenanceAt,
      lastMaintenanceAt: options.lastMaintenanceAt ?? null,
      reminderDaysBefore: options.reminderDaysBefore ?? 3,
      isActive: options.isActive ?? true,
    }),
  );
}
