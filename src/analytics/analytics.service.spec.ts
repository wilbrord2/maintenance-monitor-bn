import { type AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';

const NOW = new Date('2026-09-11T12:00:00Z');

function setup() {
  const repository = {
    machineStatusCounts: jest.fn().mockResolvedValue({
      total: 5,
      active: 3,
      underMaintenance: 1,
      downtime: 1,
      underTest: 0,
      inactive: 0,
    }),
    logStatusCounts: jest.fn().mockResolvedValue({ total: 4, open: 1, closed: 3 }),
    openLogsCount: jest.fn().mockResolvedValue(2),
    totalDowntimeHours: jest.fn().mockResolvedValue(12.5),
    downtimeByMachine: jest
      .fn()
      .mockResolvedValue([{ id: 1, name: 'Laser 1', serialNumber: 'L1', downtimeHours: 10, events: 2 }]),
    eventsByMachine: jest.fn().mockResolvedValue([]),
    logsByTechnician: jest.fn().mockResolvedValue([]),
    commonFaults: jest
      .fn()
      .mockResolvedValue([{ fault: 'oil leak', occurrences: 3, machines: 2, lastSeenAt: NOW }]),
    recurringIssues: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<AnalyticsRepository>;
  return { repository, service: new AnalyticsService(repository, { now: () => NOW }) };
}

describe('AnalyticsService', () => {
  it('builds the overview from live counts over the default 30-day range', async () => {
    const { service, repository } = setup();
    const overview = await service.overview({});

    expect(overview).toEqual({
      range: { from: '2026-08-12T12:00:00.000Z', to: '2026-09-11T12:00:00.000Z', days: 30 },
      machines: { total: 5, active: 3, underMaintenance: 1, downtime: 1, underTest: 0, inactive: 0 },
      logs: { total: 4, open: 1, closed: 3, currentlyOpen: 2 },
      totalDowntimeHours: 12.5,
    });
    expect(repository.logStatusCounts).toHaveBeenCalledWith(
      expect.objectContaining({ from: new Date('2026-08-12T12:00:00.000Z'), to: NOW }),
    );
  });

  it('passes the resolved range and limit to per-machine downtime', async () => {
    const { service, repository } = setup();
    const result = await service.downtime({ days: 7, limit: 5 });
    expect(repository.downtimeByMachine).toHaveBeenCalledWith(expect.objectContaining({ days: 7 }), 5);
    expect(result.byMachine).toEqual([
      { machine: { id: 1, name: 'Laser 1', serialNumber: 'L1' }, downtimeHours: 10, events: 2 },
    ]);
  });

  it('maps fault rows', async () => {
    const { service } = setup();
    const result = await service.faults({
      from: '2026-09-01',
      to: '2026-09-10',
      limit: 10,
      minOccurrences: 2,
    });
    expect(result.range.days).toBe(10);
    expect(result.commonFaults).toEqual([
      { fault: 'oil leak', occurrences: 3, machinesAffected: 2, lastSeenAt: NOW.toISOString() },
    ]);
  });

  it('rejects invalid ranges before querying', async () => {
    const { service, repository } = setup();
    await expect(service.technicians({ from: '2026-09-10', limit: 10 })).rejects.toMatchObject({
      code: 'INVALID_TIME_RANGE',
    });
    expect(repository.logsByTechnician).not.toHaveBeenCalled();
  });
});
