import { MaintenanceScheduleState } from '../../../common/enums/maintenance.enums';
import { maintenanceReminderEmail } from './maintenance.templates';

const base = {
  fullName: 'Jo',
  machineName: 'Press 1',
  serialNumber: 'PRS-1',
  dueOn: '2026-10-20',
  intervalDays: 15,
};

describe('maintenanceReminderEmail', () => {
  it('describes an upcoming reminder, singular and plural', () => {
    const plural = maintenanceReminderEmail({
      ...base,
      state: MaintenanceScheduleState.UPCOMING,
      daysUntilDue: 3,
    });
    expect(plural.subject).toBe('Maintenance due in 3 days — Press 1');

    const singular = maintenanceReminderEmail({
      ...base,
      state: MaintenanceScheduleState.UPCOMING,
      daysUntilDue: 1,
    });
    expect(singular.subject).toBe('Maintenance due in 1 day — Press 1');
  });

  it('describes due and overdue reminders', () => {
    expect(
      maintenanceReminderEmail({ ...base, state: MaintenanceScheduleState.DUE, daysUntilDue: 0 }).subject,
    ).toBe('Maintenance due today — Press 1');
    expect(
      maintenanceReminderEmail({ ...base, state: MaintenanceScheduleState.OVERDUE, daysUntilDue: -1 })
        .subject,
    ).toBe('Maintenance overdue by 1 day — Press 1');
    expect(
      maintenanceReminderEmail({ ...base, state: MaintenanceScheduleState.OVERDUE, daysUntilDue: -4 })
        .subject,
    ).toBe('Maintenance overdue by 4 days — Press 1');
  });

  it('escapes machine names in HTML and states the due date and interval', () => {
    const email = maintenanceReminderEmail({
      ...base,
      machineName: '<script>alert(1)</script>',
      state: MaintenanceScheduleState.DUE,
      daysUntilDue: 0,
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.text).toContain('2026-10-20');
    expect(email.text).toContain('every 15 days');
  });
});
