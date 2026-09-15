import 'reflect-metadata';
import { type RequestHandler } from 'express';
import { DataSource } from 'typeorm';
import { AnalyticsController } from './analytics/analytics.controller';
import { AnalyticsRepository } from './analytics/analytics.repository';
import { analyticsRoutes } from './analytics/analytics.routes';
import { AnalyticsService } from './analytics/analytics.service';
import { AuditQueryService } from './audit/audit-query.service';
import { AuditController } from './audit/audit.controller';
import { AuditRepository } from './audit/audit.repository';
import { auditRoutes } from './audit/audit.routes';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { authRoutes } from './auth/auth.routes';
import { AuthService } from './auth/auth.service';
import { createAuthenticateGuard } from './auth/guards/authenticate.guard';
import { Argon2PasswordHasher, type PasswordHasher } from './auth/password-hasher';
import { PasswordService } from './auth/password.service';
import { PasswordResetTokenRepository } from './auth/repositories/password-reset-token.repository';
import { RefreshTokenRepository } from './auth/repositories/refresh-token.repository';
import { SessionService } from './auth/session.service';
import { TokenCleanupService } from './auth/token-cleanup.service';
import { TokenService } from './auth/token.service';
import { TransactionRunner } from './common/database/transaction-runner';
import { DomainEventBus } from './common/events/domain-event-bus';
import { type RouteDefinition } from './common/http/route';
import { createLogger, type AppLogger } from './common/logger/logger';
import { createRateLimiters, type RateLimiters } from './common/middleware/rate-limit.middleware';
import { type Clock, systemClock } from './common/utils/clock';
import { readAppVersion } from './config/app-version';
import { type AppConfig } from './config/config';
import { buildDataSourceOptions } from './database/data-source.options';
import { HealthController } from './health/health.controller';
import { healthRoutes } from './health/health.routes';
import { HealthService } from './health/health.service';
import { MachineLogsController } from './machine-logs/machine-logs.controller';
import { MachineLogsRepository } from './machine-logs/machine-logs.repository';
import { machineLogsRoutes } from './machine-logs/machine-logs.routes';
import { MachineLogsService } from './machine-logs/machine-logs.service';
import { DowntimeCalculator } from './machine-logs/policies/downtime-calculator';
import { DEFAULT_MACHINE_LOG_RULES, MachineLogRules } from './machine-logs/policies/machine-log-rules.policy';
import { MachineStateTransitionPolicy } from './machine-logs/policies/machine-state-transition.policy';
import { MachinesController } from './machines/machines.controller';
import { MachinesRepository } from './machines/machines.repository';
import { machinesRoutes } from './machines/machines.routes';
import { MachinesService } from './machines/machines.service';
import { MailService } from './notifications/mail/mail.service';
import { type MailTransport } from './notifications/mail/mail.transport';
import { SmtpMailTransport } from './notifications/mail/smtp-mail.transport';
import { StatusBoardGateway } from './notifications/realtime/status-board.gateway';
import { UsersController } from './users/users.controller';
import { UsersRepository } from './users/users.repository';
import { usersRoutes } from './users/users.routes';
import { UsersService } from './users/users.service';

/** Replaceable infrastructure, used by tests to inject doubles. */
export interface ContainerOverrides {
  readonly logger?: AppLogger;
  readonly mailTransport?: MailTransport;
  readonly dataSource?: DataSource;
  readonly clock?: Clock;
  readonly auditService?: (repository: AuditRepository) => AuditService;
}

export interface Container {
  readonly config: AppConfig;
  readonly version: string;
  readonly logger: AppLogger;
  readonly clock: Clock;
  readonly dataSource: DataSource;
  readonly mailTransport: MailTransport;
  readonly rateLimiters: RateLimiters;
  readonly events: DomainEventBus;
  readonly statusBoard: StatusBoardGateway;
  readonly tokenCleanup: TokenCleanupService;
  readonly authenticate: RequestHandler;
  readonly routes: readonly RouteDefinition[];
  readonly services: {
    readonly auth: AuthService;
    readonly sessions: SessionService;
    readonly passwords: PasswordService;
    readonly users: UsersService;
    readonly machines: MachinesService;
    readonly machineLogs: MachineLogsService;
    readonly analytics: AnalyticsService;
    readonly audit: AuditService;
    readonly hasher: PasswordHasher;
  };
  close(): Promise<void>;
}

/** Composition root: wires every dependency explicitly through constructors. */
export async function createContainer(
  config: AppConfig,
  overrides: ContainerOverrides = {},
): Promise<Container> {
  const version = readAppVersion();
  const logger =
    overrides.logger ?? createLogger({ level: config.logLevel, pretty: config.env === 'development' });
  const clock = overrides.clock ?? systemClock;

  const dataSource = overrides.dataSource ?? new DataSource(buildDataSourceOptions(config));
  if (!dataSource.isInitialized) await dataSource.initialize();

  const mailTransport = overrides.mailTransport ?? new SmtpMailTransport(config.mail);
  const rateLimiters = createRateLimiters(config);
  const transactions = new TransactionRunner(dataSource);
  const events = new DomainEventBus(logger);

  // --- Infrastructure services
  const mail = new MailService(mailTransport, logger);
  const auditRepository = new AuditRepository(dataSource);
  const audit = overrides.auditService?.(auditRepository) ?? new AuditService(auditRepository);
  const hasher = new Argon2PasswordHasher(config.argon2);

  // --- Repositories
  const usersRepository = new UsersRepository(dataSource);
  const refreshTokenRepository = new RefreshTokenRepository(dataSource);
  const resetTokenRepository = new PasswordResetTokenRepository(dataSource);
  const machinesRepository = new MachinesRepository(dataSource);
  const machineLogsRepository = new MachineLogsRepository(dataSource);

  // --- Auth & users
  const tokens = new TokenService(config.jwt, clock);
  const sessions = new SessionService(
    refreshTokenRepository,
    usersRepository,
    tokens,
    transactions,
    audit,
    clock,
  );
  const auth = new AuthService(usersRepository, hasher, sessions, audit, config.auth, clock);
  const passwords = new PasswordService(
    usersRepository,
    resetTokenRepository,
    hasher,
    sessions,
    transactions,
    audit,
    mail,
    config.auth,
    clock,
    logger,
  );
  const users = new UsersService(
    usersRepository,
    hasher,
    sessions,
    transactions,
    audit,
    mail,
    config.auth,
    clock,
  );
  const tokenCleanup = new TokenCleanupService(refreshTokenRepository, resetTokenRepository, clock, logger);

  // --- Machines & machine logs
  const machines = new MachinesService(machinesRepository, transactions, audit);
  const machineLogs = new MachineLogsService(
    machineLogsRepository,
    machinesRepository,
    new MachineStateTransitionPolicy(),
    new MachineLogRules(DEFAULT_MACHINE_LOG_RULES),
    new DowntimeCalculator(),
    transactions,
    audit,
    events,
    clock,
  );

  // --- Analytics
  const analytics = new AnalyticsService(new AnalyticsRepository(dataSource), clock);

  // --- Real-time
  const statusBoard = new StatusBoardGateway(sessions, events, config, logger);

  const authenticate = createAuthenticateGuard(auth);

  const routes: RouteDefinition[] = [
    ...healthRoutes(new HealthController(new HealthService(dataSource, mailTransport, version))),
    ...authRoutes(new AuthController(auth, passwords, config.auth), rateLimiters),
    ...usersRoutes(new UsersController(users)),
    ...machinesRoutes(new MachinesController(machines)),
    ...machineLogsRoutes(new MachineLogsController(machineLogs, DEFAULT_MACHINE_LOG_RULES)),
    ...analyticsRoutes(new AnalyticsController(analytics)),
    ...auditRoutes(new AuditController(new AuditQueryService(auditRepository))),
  ];

  return {
    config,
    version,
    logger,
    clock,
    dataSource,
    mailTransport,
    rateLimiters,
    events,
    statusBoard,
    tokenCleanup,
    authenticate,
    routes,
    services: { auth, sessions, passwords, users, machines, machineLogs, analytics, audit, hasher },
    async close() {
      tokenCleanup.stop();
      await statusBoard.close();
      mailTransport.close();
      if (dataSource.isInitialized) await dataSource.destroy();
    },
  };
}
