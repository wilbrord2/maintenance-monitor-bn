import { type DataSource, type EntityManager } from 'typeorm';
import { MachinePart } from '../../machine-parts/machine-part.entity';
import { Machine } from '../../machines/machine.entity';
import { MaintenanceSchedule } from '../../maintenance/maintenance-schedule.entity';
import { addDays, defaultReminderDays } from '../../maintenance/policies/maintenance-cycle';
import { inspectionMachines, type InspectionTask, type SeedMachine } from './inspection-schedule.data';

export interface SeedCounts {
  created: number;
  existing: number;
}

export interface InspectionSeedResult {
  readonly machines: SeedCounts;
  readonly parts: SeedCounts;
  readonly schedules: SeedCounts;
}

/**
 * Creates the machines, parts and maintenance schedules of the plant
 * inspection schedule (see inspection-schedule.data.ts) in one transaction.
 *
 * Idempotent and non-destructive: machines are matched by name and parts by
 * name within their machine (both case-insensitive), schedules by task; any
 * existing row is left exactly as it is, so re-running never resets due dates,
 * intervals or history. New schedules are first due one interval from now.
 */
export async function seedInspectionSchedule(
  dataSource: DataSource,
  now: Date = new Date(),
  machines: readonly SeedMachine[] = inspectionMachines(),
): Promise<InspectionSeedResult> {
  const result: InspectionSeedResult = {
    machines: { created: 0, existing: 0 },
    parts: { created: 0, existing: 0 },
    schedules: { created: 0, existing: 0 },
  };

  await dataSource.transaction(async (manager) => {
    for (const entry of machines) {
      const machine = await findOrCreateMachine(manager, entry, result.machines);
      for (const task of entry.machineTasks) {
        await findOrCreateSchedule(manager, { machine, part: null, task, now }, result.schedules);
      }
      for (const partTask of entry.parts) {
        const part = await findOrCreatePart(manager, machine, partTask.name, result.parts);
        await findOrCreateSchedule(manager, { machine, part, task: partTask, now }, result.schedules);
      }
    }
  });
  return result;
}

async function findOrCreateMachine(
  manager: EntityManager,
  entry: SeedMachine,
  counts: SeedCounts,
): Promise<Machine> {
  const existing = await manager
    .getRepository(Machine)
    .createQueryBuilder('machine')
    .where('lower(machine.name) = lower(:name)', { name: entry.name })
    .orderBy('machine.id', 'ASC')
    .getOne();
  if (existing) {
    counts.existing += 1;
    return existing;
  }
  counts.created += 1;
  return manager.getRepository(Machine).save(
    manager.getRepository(Machine).create({
      name: entry.name,
      serialNumber: entry.serialNumber,
      description: 'Created from the plant inspection schedule',
      isActive: true,
    }),
  );
}

async function findOrCreatePart(
  manager: EntityManager,
  machine: Machine,
  name: string,
  counts: SeedCounts,
): Promise<MachinePart> {
  const repository = manager.getRepository(MachinePart);
  const existing = await repository
    .createQueryBuilder('part')
    .where('part.machineId = :machineId', { machineId: machine.id })
    .andWhere('lower(part.name) = lower(:name)', { name })
    .orderBy('part.id', 'ASC')
    .getOne();
  if (existing) {
    counts.existing += 1;
    return existing;
  }
  counts.created += 1;
  return repository.save(
    repository.create({
      machineId: machine.id,
      name,
      partCode: await nextPartCode(manager, machine.id),
      isCritical: false,
      isActive: true,
    }),
  );
}

/** P01, P02, ... skipping codes already used on the machine (deleted parts included: the code stays unique). */
async function nextPartCode(manager: EntityManager, machineId: number): Promise<string> {
  const parts = await manager
    .getRepository(MachinePart)
    .find({ where: { machineId }, withDeleted: true, select: { partCode: true } });
  const used = new Set(parts.map((part) => part.partCode));
  for (let n = 1; ; n += 1) {
    const code = `P${String(n).padStart(2, '0')}`;
    if (!used.has(code)) return code;
  }
}

async function findOrCreateSchedule(
  manager: EntityManager,
  input: { machine: Machine; part: MachinePart | null; task: InspectionTask; now: Date },
  counts: SeedCounts,
): Promise<void> {
  const repository = manager.getRepository(MaintenanceSchedule);
  const query = repository
    .createQueryBuilder('schedule')
    .where('lower(schedule.taskName) = lower(:taskName)', { taskName: input.task.name });
  if (input.part) {
    query.andWhere('schedule.machinePartId = :partId', { partId: input.part.id });
  } else {
    query
      .andWhere('schedule.machineId = :machineId', { machineId: input.machine.id })
      .andWhere('schedule.machinePartId IS NULL');
  }
  if (await query.getExists()) {
    counts.existing += 1;
    return;
  }
  counts.created += 1;
  await repository.insert({
    machineId: input.machine.id,
    machinePartId: input.part?.id ?? null,
    taskName: input.task.name,
    intervalDays: input.task.intervalDays,
    reminderDaysBefore: defaultReminderDays(input.task.intervalDays),
    lastMaintenanceAt: null,
    nextMaintenanceAt: addDays(input.now, input.task.intervalDays),
    isActive: input.machine.isActive && (input.part?.isActive ?? true),
  });
}
