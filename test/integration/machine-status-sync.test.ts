import request from 'supertest';
import { type EntityManager } from 'typeorm';
import { AuditLog } from '../../src/audit/audit-log.entity';
import { type AuditAction } from '../../src/audit/audit.constants';
import { type AuditEntry, AuditService } from '../../src/audit/audit.service';
import { LogStatus } from '../../src/common/enums/log-status.enum';
import { MachineState } from '../../src/common/enums/machine-state.enum';
import { MACHINE_STATUS_UPDATED } from '../../src/common/events/domain-events';
import { MachineLog } from '../../src/machine-logs/machine-log.entity';
import {
  createMachine,
  expectStatusMatchesLatestLog,
  machineStatus,
  technicianSession,
  type Session,
} from '../helpers/factories';
import { createTestContext, resetDatabase, type TestContext } from '../helpers/test-app';

/** Audit service that fails for one action — used to inject a failure mid-transaction. */
class FailingAuditService extends AuditService {
  failOn: AuditAction | null = null;

  override async record(entry: AuditEntry, manager?: EntityManager): Promise<void> {
    await super.record(entry, manager);
    if (entry.action === this.failOn) throw new Error(`Injected failure after ${entry.action}`);
  }
}

describe('Critical: machine log + machine status are atomic and concurrency-safe', () => {
  let ctx: TestContext;
  let failingAudit: FailingAuditService;
  let tech: Session;

  beforeAll(async () => {
    ctx = await createTestContext({
      overrides: {
        auditService: (repository) => {
          failingAudit = new FailingAuditService(repository);
          return failingAudit;
        },
      },
    });
  });

  afterAll(async () => {
    await ctx.container.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.container);
    failingAudit.failOn = null;
    tech = await technicianSession(ctx);
  });

  const createLog = (body: Record<string, unknown>, session: Session = tech) =>
    request(ctx.app).post('/api/v1/machine-logs').set(session.auth).send(body);

  describe('transactional atomicity', () => {
    it.each(['MACHINE_LOG_CREATED', 'MACHINE_STATUS_CHANGED'] as const)(
      'rolls back the log AND the status change when the transaction fails at %s',
      async (failOn) => {
        const machine = await createMachine(ctx);
        const events: unknown[] = [];
        const unsubscribe = ctx.container.events.subscribe(MACHINE_STATUS_UPDATED, (event) => {
          events.push(event);
        });
        failingAudit.failOn = failOn;

        try {
          const res = await createLog({
            machineId: machine.id,
            faultDescription: 'Spindle seized',
            entryStatus: 'ACTIVE',
            resultingState: 'DOWNTIME',
          }).expect(500);

          expect(res.body).toMatchObject({
            success: false,
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
          });
          expect(JSON.stringify(res.body)).not.toContain('Injected failure');
        } finally {
          unsubscribe();
        }

        expect(await ctx.container.dataSource.getRepository(MachineLog).count()).toBe(0);
        expect(await machineStatus(ctx, machine.id)).toBe(MachineState.ACTIVE);
        const machineAudits = await ctx.container.dataSource
          .getRepository(AuditLog)
          .createQueryBuilder('audit')
          .where("audit.action LIKE 'MACHINE_%'")
          .getCount();
        expect(machineAudits).toBe(0);
        expect(events).toHaveLength(0);
      },
    );

    it('rolls back a log update and its status change together', async () => {
      const machine = await createMachine(ctx);
      const created = await createLog({
        machineId: machine.id,
        faultDescription: 'Pump failure',
        entryStatus: 'ACTIVE',
        resultingState: 'DOWNTIME',
      }).expect(201);

      failingAudit.failOn = 'MACHINE_STATUS_CHANGED';
      await request(ctx.app)
        .patch(`/api/v1/machine-logs/${created.body.data.id}`)
        .set(tech.auth)
        .send({ version: 1, resultingState: 'UNDER_MAINTENANCE', remedyAction: 'Started repair' })
        .expect(500);

      const log = await ctx.container.dataSource
        .getRepository(MachineLog)
        .findOneByOrFail({ id: created.body.data.id });
      expect(log).toMatchObject({ resultingState: 'DOWNTIME', remedyAction: null, version: 1 });
      expect(await machineStatus(ctx, machine.id)).toBe(MachineState.DOWNTIME);
    });

    it('enforces database constraints even if application validation were bypassed', async () => {
      const machine = await createMachine(ctx);
      const repository = ctx.container.dataSource.getRepository(MachineLog);
      const base = {
        machineId: machine.id,
        userId: tech.user.id,
        faultDescription: 'direct insert',
        entryStatus: MachineState.ACTIVE,
        resultingState: MachineState.ACTIVE,
      };
      await expect(repository.insert({ ...base, downtimeHours: -1 })).rejects.toThrow(
        /CHK_machine_logs_downtime_non_negative/,
      );
      await expect(
        repository.insert({
          ...base,
          startedAt: new Date('2026-01-02'),
          endedAt: new Date('2026-01-01'),
          logStatus: LogStatus.CLOSED,
        }),
      ).rejects.toThrow(/CHK_machine_logs_ended_after_started/);
      await expect(repository.insert({ ...base, machineId: 987654 })).rejects.toThrow(
        /FK_machine_logs_machine_id/,
      );
      await expect(repository.insert({ ...base, userId: 987654 })).rejects.toThrow(/FK_machine_logs_user_id/);
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of many simultaneous status changes win; the rest get 409 conflicts', async () => {
      const machine = await createMachine(ctx);
      const others = await Promise.all([
        technicianSession(ctx),
        technicianSession(ctx),
        technicianSession(ctx),
      ]);
      const sessions = [tech, ...others];
      const targets = ['DOWNTIME', 'UNDER_MAINTENANCE', 'UNDER_TEST'] as const;

      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          createLog(
            {
              machineId: machine.id,
              faultDescription: `Concurrent report ${i}`,
              entryStatus: 'ACTIVE',
              resultingState: targets[i % targets.length],
            },
            sessions[i % sessions.length],
          ),
        ),
      );

      const succeeded = results.filter((r) => r.status === 201);
      const conflicted = results.filter((r) => r.status === 409);
      expect(succeeded).toHaveLength(1);
      expect(conflicted).toHaveLength(11);
      expect(conflicted.every((r) => r.body.code === 'MACHINE_STATE_CONFLICT')).toBe(true);

      expect(await ctx.container.dataSource.getRepository(MachineLog).count()).toBe(1);
      const latest = await expectStatusMatchesLatestLog(ctx, machine.id);
      expect(latest?.resultingState).toBe(succeeded[0]!.body.data.resultingState);
    });

    it('serialises a realistic chain of concurrent transitions without losing the invariant', async () => {
      const machine = await createMachine(ctx);
      const sequence: [string, string][] = [
        ['ACTIVE', 'DOWNTIME'],
        ['DOWNTIME', 'UNDER_MAINTENANCE'],
        ['UNDER_MAINTENANCE', 'UNDER_TEST'],
        ['UNDER_TEST', 'ACTIVE'],
      ];
      // Fire every step at once, once per step, so each round races all transitions.
      for (const _round of sequence) {
        await Promise.all(
          sequence.map(([entryStatus, resultingState]) =>
            createLog({
              machineId: machine.id,
              faultDescription: `${entryStatus}->${resultingState}`,
              entryStatus,
              resultingState,
            }),
          ),
        );
        await expectStatusMatchesLatestLog(ctx, machine.id);
      }
      const logs = await ctx.container.dataSource
        .getRepository(MachineLog)
        .find({ where: { machineId: machine.id }, order: { id: 'ASC' } });
      for (let i = 1; i < logs.length; i += 1) {
        expect(logs[i]!.entryStatus).toBe(logs[i - 1]!.resultingState);
      }
    });

    it('rejects all but one concurrent edit of the same log version', async () => {
      const machine = await createMachine(ctx);
      const created = await createLog({
        machineId: machine.id,
        faultDescription: 'Leak',
        entryStatus: 'ACTIVE',
        resultingState: 'DOWNTIME',
      }).expect(201);

      const results = await Promise.all(
        ['UNDER_MAINTENANCE', 'UNDER_TEST', 'ACTIVE'].map((resultingState) =>
          request(ctx.app)
            .patch(`/api/v1/machine-logs/${created.body.data.id}`)
            .set(tech.auth)
            .send({ version: 1, resultingState }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'STALE_VERSION')).toBe(
        true,
      );
      await expectStatusMatchesLatestLog(ctx, machine.id);
    });

    it('a log created concurrently with an update of the previous log keeps the invariant', async () => {
      const machine = await createMachine(ctx);
      const first = await createLog({
        machineId: machine.id,
        faultDescription: 'First',
        entryStatus: 'ACTIVE',
        resultingState: 'DOWNTIME',
      }).expect(201);

      await Promise.all([
        request(ctx.app)
          .patch(`/api/v1/machine-logs/${first.body.data.id}`)
          .set(tech.auth)
          .send({ version: 1, resultingState: 'UNDER_TEST' }),
        createLog({
          machineId: machine.id,
          faultDescription: 'Second',
          entryStatus: 'DOWNTIME',
          resultingState: 'UNDER_MAINTENANCE',
        }),
      ]);

      await expectStatusMatchesLatestLog(ctx, machine.id);
    });
  });
});
