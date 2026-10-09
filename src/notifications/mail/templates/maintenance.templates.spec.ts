import { MaintenanceScheduleState } from '../../../common/enums/maintenance.enums';
import { type MaintenanceDigestItem, maintenanceDigestEmail } from './maintenance.templates';

const item = (overrides: Partial<MaintenanceDigestItem>): MaintenanceDigestItem => ({
  machineName: 'Press 1',
  serialNumber: 'PRS-1',
  partName: null,
  taskName: 'External cleaning',
  state: MaintenanceScheduleState.DUE,
  dueOn: '2026-10-20',
  daysUntilDue: 0,
  intervalDays: 1,
  ...overrides,
});

describe('maintenanceDigestEmail', () => {
  it('summarises the tasks by state in the subject, overdue first', () => {
    const email = maintenanceDigestEmail({
      fullName: 'Jo',
      items: [
        item({ state: MaintenanceScheduleState.UPCOMING, daysUntilDue: 3 }),
        item({ state: MaintenanceScheduleState.OVERDUE, daysUntilDue: -2 }),
        item({}),
        item({ state: MaintenanceScheduleState.OVERDUE, daysUntilDue: -1 }),
      ],
    });
    expect(email.subject).toBe('Maintenance: 2 overdue, 1 due today, 1 upcoming');
    expect(email.text.indexOf('overdue by 2 days')).toBeLessThan(email.text.indexOf('overdue by 1 day'));
    expect(email.text.indexOf('overdue by 1 day')).toBeLessThan(email.text.indexOf('due today ('));
  });

  it('names the part and task, singular and plural', () => {
    const email = maintenanceDigestEmail({
      fullName: 'Jo',
      items: [
        item({
          partName: 'Cutting head',
          taskName: 'Cutting head',
          state: MaintenanceScheduleState.UPCOMING,
          daysUntilDue: 1,
          intervalDays: 7,
        }),
        item({ partName: 'Hydraulic system', taskName: 'Oil change', intervalDays: 30 }),
      ],
    });
    expect(email.text).toContain(
      'Press 1 (PRS-1): Cutting head — due in 1 day (due 2026-10-20, every 7 days)',
    );
    expect(email.text).toContain('Hydraulic system — Oil change — due today');
    expect(email.text).toContain('2 maintenance tasks need attention');
  });

  it('escapes names in HTML', () => {
    const email = maintenanceDigestEmail({
      fullName: 'Jo',
      items: [item({ machineName: '<script>alert(1)</script>' })],
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.text).toContain('1 maintenance task needs attention');
  });
});
