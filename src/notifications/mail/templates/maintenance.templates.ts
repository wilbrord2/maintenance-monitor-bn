import { MaintenanceScheduleState } from '../../../common/enums/maintenance.enums';
import { escapeHtml, htmlLayout, type RenderedEmail } from './layout';

export interface MaintenanceReminderInput {
  readonly fullName: string;
  readonly machineName: string;
  readonly serialNumber: string;
  readonly state: MaintenanceScheduleState;
  readonly dueOn: string;
  readonly daysUntilDue: number;
  readonly intervalDays: number;
}

function headline(input: MaintenanceReminderInput): string {
  if (input.state === MaintenanceScheduleState.OVERDUE) {
    const days = Math.abs(input.daysUntilDue);
    return `Maintenance overdue by ${days} day${days === 1 ? '' : 's'}`;
  }
  if (input.state === MaintenanceScheduleState.DUE) return 'Maintenance due today';
  return `Maintenance due in ${input.daysUntilDue} day${input.daysUntilDue === 1 ? '' : 's'}`;
}

export function maintenanceReminderEmail(input: MaintenanceReminderInput): RenderedEmail {
  const title = headline(input);
  const subject = `${title} — ${input.machineName}`;
  const text = [
    `Hello ${input.fullName},`,
    '',
    `${title} for ${input.machineName} (${input.serialNumber}).`,
    '',
    `Due date: ${input.dueOn}`,
    `Maintenance interval: every ${input.intervalDays} days`,
    '',
    'Open Maintenance Monitor to start the maintenance and record what was done.',
  ].join('\n');
  const html = htmlLayout(
    subject,
    `<p>Hello ${escapeHtml(input.fullName)},</p>
     <p><strong>${escapeHtml(title)}</strong> for ${escapeHtml(input.machineName)}
        (${escapeHtml(input.serialNumber)}).</p>
     <p><strong>Due date:</strong> ${escapeHtml(input.dueOn)}<br>
        <strong>Interval:</strong> every ${input.intervalDays} days</p>
     <p>Open Maintenance Monitor to start the maintenance and record what was done.</p>`,
  );
  return { subject, text, html };
}
