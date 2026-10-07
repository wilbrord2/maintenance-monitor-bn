import { MaintenanceScheduleState } from '../../../common/enums/maintenance.enums';
import { escapeHtml, htmlLayout, type RenderedEmail } from './layout';

export interface MaintenanceDigestItem {
  readonly machineName: string;
  readonly serialNumber: string;
  /** Null for a machine-wide task. */
  readonly partName: string | null;
  readonly taskName: string;
  readonly state: MaintenanceScheduleState;
  readonly dueOn: string;
  readonly daysUntilDue: number;
  readonly intervalDays: number;
}

export interface MaintenanceDigestInput {
  readonly fullName: string;
  readonly items: readonly MaintenanceDigestItem[];
}

/** Overdue first, then due today, then upcoming. */
const STATE_ORDER: readonly MaintenanceScheduleState[] = [
  MaintenanceScheduleState.OVERDUE,
  MaintenanceScheduleState.DUE,
  MaintenanceScheduleState.UPCOMING,
];

const STATE_LABELS: Readonly<Record<MaintenanceScheduleState, string>> = {
  [MaintenanceScheduleState.OVERDUE]: 'overdue',
  [MaintenanceScheduleState.DUE]: 'due today',
  [MaintenanceScheduleState.UPCOMING]: 'upcoming',
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function when(item: MaintenanceDigestItem): string {
  if (item.state === MaintenanceScheduleState.OVERDUE) {
    return `overdue by ${plural(Math.abs(item.daysUntilDue), 'day')}`;
  }
  if (item.state === MaintenanceScheduleState.DUE) return 'due today';
  return `due in ${plural(item.daysUntilDue, 'day')}`;
}

/** "Cutting head" for a part task named after its part, otherwise "Cutting head — Nozzle check". */
function subjectOf(item: MaintenanceDigestItem): string {
  if (item.partName === null || item.partName === item.taskName) return item.taskName;
  return `${item.partName} — ${item.taskName}`;
}

function sorted(items: readonly MaintenanceDigestItem[]): MaintenanceDigestItem[] {
  return [...items].sort(
    (a, b) =>
      STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
      a.daysUntilDue - b.daysUntilDue ||
      a.machineName.localeCompare(b.machineName),
  );
}

/** One email listing every maintenance task that reached a reminder in this run. */
export function maintenanceDigestEmail(input: MaintenanceDigestInput): RenderedEmail {
  const items = sorted(input.items);
  const counts = STATE_ORDER.map((state) => ({
    state,
    count: items.filter((item) => item.state === state).length,
  })).filter(({ count }) => count > 0);
  const summary = counts.map(({ state, count }) => `${count} ${STATE_LABELS[state]}`).join(', ');
  const subject = `Maintenance: ${summary}`;

  const text = [
    `Hello ${input.fullName},`,
    '',
    `${plural(items.length, 'maintenance task')} need${items.length === 1 ? 's' : ''} attention (${summary}):`,
    '',
    ...items.map(
      (item) =>
        `- ${item.machineName} (${item.serialNumber}): ${subjectOf(item)} — ${when(item)} ` +
        `(due ${item.dueOn}, every ${plural(item.intervalDays, 'day')})`,
    ),
    '',
    'Open Maintenance Monitor to start the maintenance and record what was done.',
  ].join('\n');

  const rows = items
    .map(
      (item) => `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid #ddd9ce;">${escapeHtml(item.machineName)}<br>
          <span style="color:#75736a;font-size:12px;">${escapeHtml(item.serialNumber)}</span></td>
        <td style="padding:4px 8px;border-bottom:1px solid #ddd9ce;">${escapeHtml(subjectOf(item))}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #ddd9ce;">${escapeHtml(when(item))}<br>
          <span style="color:#75736a;font-size:12px;">${escapeHtml(item.dueOn)}</span></td>
      </tr>`,
    )
    .join('');
  const html = htmlLayout(
    subject,
    `<p>Hello ${escapeHtml(input.fullName)},</p>
     <p><strong>${escapeHtml(plural(items.length, 'maintenance task'))}</strong> need attention
        (${escapeHtml(summary)}).</p>
     <table role="presentation" width="100%" style="border-collapse:collapse;font-size:13px;">
       <tr><th align="left" style="padding:4px 8px;">Machine</th><th align="left" style="padding:4px 8px;">Task</th>
           <th align="left" style="padding:4px 8px;">When</th></tr>
       ${rows}
     </table>
     <p>Open Maintenance Monitor to start the maintenance and record what was done.</p>`,
  );
  return { subject, text, html };
}
