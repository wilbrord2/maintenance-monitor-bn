import { MaintenanceReminderKind, MaintenanceScheduleState } from '../../common/enums/maintenance.enums';
import {
  addDays,
  calendarDaysBetween,
  cycleKey,
  initialNextMaintenance,
  nextMaintenanceAfter,
  resolveScheduleStatus,
} from './maintenance-cycle';

const at = (iso: string) => new Date(iso);
const day = (date: Date) => date.toISOString().slice(0, 10);

describe('maintenance cycle calculations', () => {
  describe('nextMaintenanceAfter', () => {
    it('adds the interval to the completion date (15-day interval)', () => {
      expect(day(nextMaintenanceAfter(at('2026-10-01T08:00:00Z'), 15))).toBe('2026-10-16');
    });

    it('repeats cycle after cycle from each completion', () => {
      const first = nextMaintenanceAfter(at('2026-10-01T08:00:00Z'), 15);
      expect(day(first)).toBe('2026-10-16');
      expect(day(nextMaintenanceAfter(first, 15))).toBe('2026-10-31');
    });

    it('uses the actual completion date, not the scheduled one (late maintenance)', () => {
      // Scheduled 15 Oct, actually completed 18 Oct, 20-day interval.
      expect(day(nextMaintenanceAfter(at('2026-10-18T14:30:00Z'), 20))).toBe('2026-11-07');
    });
  });

  describe('initialNextMaintenance', () => {
    it('derives the first due date from existing history, not from today', () => {
      const next = initialNextMaintenance({
        intervalDays: 20,
        lastMaintenanceAt: at('2026-09-25T09:00:00Z'),
        now: at('2026-10-05T09:00:00Z'),
      });
      expect(day(next)).toBe('2026-10-15');
      expect(calendarDaysBetween(at('2026-10-05T09:00:00Z'), next)).toBe(10);
    });

    it('honours an explicit first due date', () => {
      const next = initialNextMaintenance({
        intervalDays: 20,
        lastMaintenanceAt: at('2026-09-25T09:00:00Z'),
        nextMaintenanceAt: at('2026-10-10T00:00:00Z'),
        now: at('2026-10-05T09:00:00Z'),
      });
      expect(day(next)).toBe('2026-10-10');
    });

    it('starts one interval from now for a machine without history', () => {
      const next = initialNextMaintenance({ intervalDays: 15, now: at('2026-10-05T09:00:00Z') });
      expect(day(next)).toBe('2026-10-20');
    });
  });

  describe('resolveScheduleStatus', () => {
    const schedule = (nextIso: string, reminderDaysBefore = 5) => ({
      nextMaintenanceAt: at(nextIso),
      reminderDaysBefore,
    });

    it('is UPCOMING outside the reminder window, with no reminder', () => {
      const status = resolveScheduleStatus(schedule('2026-10-20T00:00:00Z'), at('2026-10-05T09:00:00Z'));
      expect(status).toMatchObject({
        state: MaintenanceScheduleState.UPCOMING,
        daysUntilDue: 15,
        withinReminderWindow: false,
        reminderKind: null,
      });
    });

    it('starts reminding exactly reminderDaysBefore days ahead', () => {
      const status = resolveScheduleStatus(schedule('2026-10-20T00:00:00Z'), at('2026-10-15T09:00:00Z'));
      expect(status).toMatchObject({
        state: MaintenanceScheduleState.UPCOMING,
        daysUntilDue: 5,
        withinReminderWindow: true,
        reminderKind: MaintenanceReminderKind.UPCOMING,
      });
    });

    it('is DUE on the due day regardless of the time of day', () => {
      const status = resolveScheduleStatus(schedule('2026-10-20T06:00:00Z'), at('2026-10-20T23:30:00Z'));
      expect(status).toMatchObject({
        state: MaintenanceScheduleState.DUE,
        daysUntilDue: 0,
        reminderKind: MaintenanceReminderKind.DUE,
      });
    });

    it('is OVERDUE after the due day, counting days negatively', () => {
      const status = resolveScheduleStatus(schedule('2026-10-20T00:00:00Z'), at('2026-10-23T01:00:00Z'));
      expect(status).toMatchObject({
        state: MaintenanceScheduleState.OVERDUE,
        daysUntilDue: -3,
        reminderKind: MaintenanceReminderKind.OVERDUE,
      });
    });

    it('treats a zero reminder window as "remind on the due day only"', () => {
      expect(
        resolveScheduleStatus(schedule('2026-10-20T00:00:00Z', 0), at('2026-10-19T09:00:00Z')).reminderKind,
      ).toBeNull();
      expect(
        resolveScheduleStatus(schedule('2026-10-20T00:00:00Z', 0), at('2026-10-20T09:00:00Z')).reminderKind,
      ).toBe(MaintenanceReminderKind.DUE);
    });
  });

  it('identifies a maintenance cycle by its UTC due day', () => {
    expect(cycleKey(at('2026-10-20T23:59:00Z'))).toBe('2026-10-20');
    expect(cycleKey(at('2026-10-21T00:00:00Z'))).toBe('2026-10-21');
  });

  it('counts calendar days independently of the time of day', () => {
    expect(calendarDaysBetween(at('2026-10-05T23:00:00Z'), at('2026-10-06T01:00:00Z'))).toBe(1);
    expect(calendarDaysBetween(at('2026-10-05T01:00:00Z'), at('2026-10-05T23:00:00Z'))).toBe(0);
    expect(day(addDays(at('2026-02-27T00:00:00Z'), 2))).toBe('2026-03-01');
  });
});
