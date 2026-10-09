import { z } from 'zod';
import { Role, ROLES } from '../common/enums/role.enum';
import { protectedRoute, type RouteDefinition } from '../common/http/route';
import { idParams, positiveId } from '../common/validation/primitives';
import { type MaintenanceController } from './maintenance.controller';
import {
  cancelMaintenanceEventSchema,
  completeMaintenanceEventSchema,
  createMaintenanceEventSchema,
  createMaintenanceScheduleSchema,
  listMaintenanceEventsQuerySchema,
  maintenanceDashboardQuerySchema,
  maintenanceEventResponseSchema,
  maintenanceScheduleResponseSchema,
  startMaintenanceEventSchema,
  updateMaintenanceEventSchema,
  updateMaintenanceScheduleSchema,
} from './maintenance.dto';

const SCHEDULE_TAGS = ['Maintenance schedules'];
const EVENT_TAGS = ['Maintenance events'];
const ADMIN = [Role.ADMIN] as const;
const machineParams = z.object({ machineId: positiveId });

const CYCLE_NOTE =
  'Due dates come from the maintenance history: the next due date is the last completion plus the interval. ' +
  'UPCOMING / DUE / OVERDUE are derived on read and never change the machine status.';

export function maintenanceRoutes(controller: MaintenanceController): RouteDefinition[] {
  return [
    protectedRoute({
      method: 'post',
      path: '/machines/:machineId/maintenance',
      tags: SCHEDULE_TAGS,
      summary: 'Create the recurring maintenance schedule of a machine',
      description: `One schedule per machine. ${CYCLE_NOTE}`,
      roles: ADMIN,
      params: machineParams,
      body: createMaintenanceScheduleSchema,
      response: { status: 201, description: 'Schedule created', data: maintenanceScheduleResponseSchema },
      errors: [409, 422],
      handler: (ctx) => controller.createSchedule(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/machines/:machineId/maintenance',
      tags: SCHEDULE_TAGS,
      summary: 'Get the maintenance schedule of a machine',
      description: CYCLE_NOTE,
      roles: ROLES,
      params: machineParams,
      response: { status: 200, description: 'Schedule', data: maintenanceScheduleResponseSchema },
      handler: (ctx) => controller.getSchedule(ctx),
    }),
    protectedRoute({
      method: 'patch',
      path: '/machines/:machineId/maintenance',
      tags: SCHEDULE_TAGS,
      summary: 'Update the maintenance schedule of a machine',
      description: 'Changing the interval or the last maintenance date recalculates the due date.',
      roles: ADMIN,
      params: machineParams,
      body: updateMaintenanceScheduleSchema,
      response: { status: 200, description: 'Updated schedule', data: maintenanceScheduleResponseSchema },
      errors: [422],
      handler: (ctx) => controller.updateSchedule(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/maintenance/upcoming',
      tags: SCHEDULE_TAGS,
      summary: 'Schedules approaching their due date (inside the reminder window)',
      roles: ROLES,
      query: maintenanceDashboardQuerySchema,
      response: {
        status: 200,
        description: 'Paginated schedules',
        data: maintenanceScheduleResponseSchema,
        paginated: true,
      },
      handler: (ctx) => controller.upcoming(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/maintenance/due',
      tags: SCHEDULE_TAGS,
      summary: 'Schedules due today',
      roles: ROLES,
      query: maintenanceDashboardQuerySchema,
      response: {
        status: 200,
        description: 'Paginated schedules',
        data: maintenanceScheduleResponseSchema,
        paginated: true,
      },
      handler: (ctx) => controller.due(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/maintenance/overdue',
      tags: SCHEDULE_TAGS,
      summary: 'Schedules past their due date',
      roles: ROLES,
      query: maintenanceDashboardQuerySchema,
      response: {
        status: 200,
        description: 'Paginated schedules',
        data: maintenanceScheduleResponseSchema,
        paginated: true,
      },
      handler: (ctx) => controller.overdue(ctx),
    }),
    protectedRoute({
      method: 'post',
      path: '/maintenance-events',
      tags: EVENT_TAGS,
      summary: 'Create a maintenance event',
      description:
        'Links to the machine schedule when one exists. Only one event per schedule may be open at a time.',
      roles: ROLES,
      body: createMaintenanceEventSchema,
      response: { status: 201, description: 'Event created', data: maintenanceEventResponseSchema },
      errors: [404, 409, 422],
      handler: (ctx) => controller.createEvent(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/maintenance-events',
      tags: EVENT_TAGS,
      summary: 'List maintenance events',
      roles: ROLES,
      query: listMaintenanceEventsQuerySchema,
      response: {
        status: 200,
        description: 'Paginated events',
        data: maintenanceEventResponseSchema,
        paginated: true,
      },
      handler: (ctx) => controller.listEvents(ctx),
    }),
    protectedRoute({
      method: 'get',
      path: '/maintenance-events/:id',
      tags: EVENT_TAGS,
      summary: 'Get a maintenance event',
      roles: ROLES,
      params: idParams,
      response: { status: 200, description: 'Event', data: maintenanceEventResponseSchema },
      handler: (ctx) => controller.getEvent(ctx),
    }),
    protectedRoute({
      method: 'patch',
      path: '/maintenance-events/:id',
      tags: EVENT_TAGS,
      summary: 'Reschedule an event or edit its notes',
      description: 'Lifecycle changes use the start, complete and cancel endpoints.',
      roles: ROLES,
      params: idParams,
      body: updateMaintenanceEventSchema,
      response: { status: 200, description: 'Updated event', data: maintenanceEventResponseSchema },
      errors: [409],
      handler: (ctx) => controller.updateEvent(ctx),
    }),
    protectedRoute({
      method: 'post',
      path: '/maintenance-events/:id/start',
      tags: EVENT_TAGS,
      summary: 'Start a scheduled maintenance',
      description:
        'Moves the event to IN_PROGRESS and, unless `putMachineUnderMaintenance` is false, opens a machine ' +
        'log that sets the machine to UNDER_MAINTENANCE through the existing workflow.',
      roles: ROLES,
      params: idParams,
      body: startMaintenanceEventSchema,
      response: { status: 200, description: 'Maintenance started', data: maintenanceEventResponseSchema },
      errors: [409, 422],
      handler: (ctx) => controller.startEvent(ctx),
    }),
    protectedRoute({
      method: 'post',
      path: '/maintenance-events/:id/complete',
      tags: EVENT_TAGS,
      summary: 'Complete a maintenance',
      description:
        'Records the actual completion time, rolls the schedule forward (completion + interval) in the same ' +
        'transaction and closes the machine log opened at start, re-deriving the machine status from its parts.',
      roles: ROLES,
      params: idParams,
      body: completeMaintenanceEventSchema,
      response: { status: 200, description: 'Maintenance completed', data: maintenanceEventResponseSchema },
      errors: [409, 422],
      handler: (ctx) => controller.completeEvent(ctx),
    }),
    protectedRoute({
      method: 'post',
      path: '/maintenance-events/:id/cancel',
      tags: EVENT_TAGS,
      summary: 'Cancel a maintenance event',
      roles: ADMIN,
      params: idParams,
      body: cancelMaintenanceEventSchema,
      response: { status: 200, description: 'Event cancelled', data: maintenanceEventResponseSchema },
      errors: [409],
      handler: (ctx) => controller.cancelEvent(ctx),
    }),
  ];
}
