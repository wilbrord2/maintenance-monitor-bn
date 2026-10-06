import { type EntityManager } from 'typeorm';
import { AuditAction, AuditEntity } from '../audit/audit.constants';
import { type AuditService } from '../audit/audit.service';
import { type AuthenticatedUser } from '../auth/auth.types';
import { type MachineOperationalStatus } from '../common/enums/machine-operational-status.enum';
import { type MachineState } from '../common/enums/machine-state.enum';
import { type DomainEventBus } from '../common/events/domain-event-bus';
import {
  MACHINE_OPERATIONAL_STATUS_UPDATED,
  MACHINE_STATUS_UPDATED,
  type MachineStatusTrigger,
} from '../common/events/domain-events';
import { type RequestMeta } from '../common/http/request-meta';
import { type Machine } from './machine.entity';
import { type MachineStatusResolver, type PartCondition } from './machine-status.resolver';
import { type MachinesRepository } from './machines.repository';

/**
 * Supplies the part conditions of a machine. Implemented by
 * MachinePartsRepository; declared here so the machines module does not depend
 * on the parts module.
 */
export interface PartConditionReader {
  conditionsForMachine(machineId: number, manager?: EntityManager): Promise<PartCondition[]>;
}

export interface MachineStatusChange {
  readonly machine: Machine;
  readonly previousStatus: MachineState;
  readonly newStatus: MachineState;
  readonly previousOperationalStatus: MachineOperationalStatus;
  readonly newOperationalStatus: MachineOperationalStatus;
  readonly reason: string;
  readonly trigger: MachineStatusTrigger;
}

/**
 * Recalculates, persists and announces a machine's derived status and
 * operational status from its system status and its parts.
 *
 * Call inside the transaction that already holds the machine row lock, after
 * the change that triggered it (a machine log, a part change or a maintenance
 * event). Returns the change so the caller can publish it after commit.
 */
export class MachineStatusSynchronizer {
  constructor(
    private readonly resolver: MachineStatusResolver,
    private readonly machines: MachinesRepository,
    private readonly parts: PartConditionReader,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
  ) {}

  async synchronize(input: {
    machine: Machine;
    trigger: MachineStatusTrigger;
    actor: AuthenticatedUser;
    meta: RequestMeta;
    manager: EntityManager;
  }): Promise<MachineStatusChange | null> {
    const { machine, trigger, actor, meta, manager } = input;
    const conditions = await this.parts.conditionsForMachine(machine.id, manager);
    const resolution = this.resolver.resolve({ machineState: machine.systemStatus, parts: conditions });
    const previousStatus = machine.status;
    const previousOperationalStatus = machine.operationalStatus;
    const statusChanged = previousStatus !== resolution.machineStatus;
    const operationalChanged = previousOperationalStatus !== resolution.status;
    if (!statusChanged && !operationalChanged) return null;

    await this.machines.updateDerivedStatus(
      machine.id,
      { status: resolution.machineStatus, operationalStatus: resolution.status },
      manager,
    );
    machine.status = resolution.machineStatus;
    machine.operationalStatus = resolution.status;

    const details = {
      reason: resolution.reason,
      trigger,
      blockingPartIds: resolution.blockingPartIds,
      defectivePartIds: resolution.defectivePartIds,
    };
    if (statusChanged) {
      await this.audit.record(
        {
          action: AuditAction.MACHINE_STATUS_CHANGED,
          entity: AuditEntity.MACHINE,
          entityId: machine.id,
          actorId: actor.id,
          oldValues: { status: previousStatus },
          newValues: { status: resolution.machineStatus, ...details },
          meta,
        },
        manager,
      );
    }
    if (operationalChanged) {
      await this.audit.record(
        {
          action: AuditAction.MACHINE_OPERATIONAL_STATUS_CHANGED,
          entity: AuditEntity.MACHINE,
          entityId: machine.id,
          actorId: actor.id,
          oldValues: { operationalStatus: previousOperationalStatus },
          newValues: { operationalStatus: resolution.status, ...details },
          meta,
        },
        manager,
      );
    }

    return {
      machine,
      previousStatus,
      newStatus: resolution.machineStatus,
      previousOperationalStatus,
      newOperationalStatus: resolution.status,
      reason: resolution.reason,
      trigger,
    };
  }

  /** Publishes the change after the transaction has committed. */
  publish(change: MachineStatusChange | null, actor: AuthenticatedUser, at: Date): void {
    if (!change) return;
    const base = {
      machineId: change.machine.id,
      machineName: change.machine.name,
      serialNumber: change.machine.serialNumber,
      reason: change.reason,
      trigger: change.trigger,
      updatedBy: { id: actor.id, name: actor.name },
      timestamp: at.toISOString(),
    };
    if (change.previousStatus !== change.newStatus) {
      this.events.publish(MACHINE_STATUS_UPDATED, {
        ...base,
        previousStatus: change.previousStatus,
        newStatus: change.newStatus,
        logId: change.trigger.logId ?? null,
      });
    }
    if (change.previousOperationalStatus !== change.newOperationalStatus) {
      this.events.publish(MACHINE_OPERATIONAL_STATUS_UPDATED, {
        ...base,
        previousStatus: change.previousOperationalStatus,
        newStatus: change.newOperationalStatus,
      });
    }
  }
}
