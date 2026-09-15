/** OPEN: the maintenance/fault event is still ongoing. CLOSED: the event is complete. */
export enum LogStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

export const LOG_STATUSES: readonly LogStatus[] = Object.values(LogStatus);
