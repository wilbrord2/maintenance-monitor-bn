# API reference

- Base URL: `/api/v1`
- Interactive documentation: `/api/docs` (Swagger UI) and `/api/docs/openapi.json` (OpenAPI 3.1). Both are
  generated from the route definitions and Zod schemas, so they list every parameter, schema and status code.
- Content type: `application/json` only (`415` otherwise). Body limit: 100 KB by default.
- Authentication: `Authorization: Bearer <accessToken>` unless marked public.
- Correlation: send an optional `X-Request-Id` (8–64 chars `[A-Za-z0-9._-]`); it is echoed on every response.

## Response envelopes

Success:

```json
{ "success": true, "message": "Machine created successfully", "data": {} }
```

Paginated success:

```json
{
  "success": true,
  "message": "Machines retrieved",
  "data": [],
  "meta": { "page": 1, "limit": 20, "totalItems": 57, "totalPages": 3 }
}
```

Error:

```json
{
  "success": false,
  "message": "Machine serial number already exists",
  "code": "MACHINE_SERIAL_EXISTS",
  "timestamp": "2026-09-11T14:03:12.482Z",
  "path": "/api/v1/machines",
  "requestId": "b7c1…",
  "details": [{ "field": "serialNumber", "message": "…" }]
}
```

`details` appears for validation and some business-rule errors. Query/path field names are prefixed
(`query.limit`, `params.id`). Stack traces, SQL and internal messages are never returned.

## Collections

All collection endpoints are paginated — there is no way to fetch unlimited records.

| Parameter   | Default                                  | Notes                                   |
| ----------- | ---------------------------------------- | --------------------------------------- |
| `page`      | `1`                                      | 1-based                                 |
| `limit`     | `20`                                     | 1–100                                   |
| `sortBy`    | per resource                             | whitelisted fields only                 |
| `sortOrder` | `desc` (machines: `asc`, sorted by name) | `asc` \| `desc`                         |
| `search`    | —                                        | case-insensitive; wildcards are escaped |

Unknown or repeated query parameters are rejected with `400`.

## Endpoints

### Auth

| Method & path                | Access   | Description                                                                 |
| ---------------------------- | -------- | --------------------------------------------------------------------------- |
| `POST /auth/login`           | public   | `{email, password}` → `{user, mustChangePassword, tokens}` + refresh cookie |
| `POST /auth/refresh`         | public   | `{refreshToken?}` (or cookie) → rotated token pair                          |
| `POST /auth/logout`          | any role | Revoke the current session                                                  |
| `POST /auth/change-password` | any role | `{currentPassword, newPassword}` → new session                              |
| `POST /auth/forgot-password` | public   | `{email}` → generic acknowledgement                                         |
| `POST /auth/reset-password`  | public   | `{token, newPassword}`                                                      |

### Users

| Method & path                                | Access   | Description                                                                                      |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `GET /users/me`                              | any role | Own profile                                                                                      |
| `PATCH /users/me`                            | any role | `{fullName?, phone?}`                                                                            |
| `POST /users`                                | ADMIN    | Create technician `{fullName, email, phone, position?}` — credentials emailed                    |
| `GET /users`                                 | ADMIN    | Filters: `role`, `isActive`, `search`; `sortBy`: `createdAt`, `fullName`, `email`, `lastLoginAt` |
| `GET /users/:id`                             | ADMIN    |                                                                                                  |
| `PATCH /users/:id`                           | ADMIN    | `{fullName?, email?, phone?, position?}`                                                         |
| `POST /users/:id/deactivate` / `activate`    | ADMIN    |                                                                                                  |
| `POST /users/:id/reissue-temporary-password` | ADMIN    | New emailed temporary credential                                                                 |
| `DELETE /users/:id`                          | ADMIN    | Soft delete                                                                                      |

### Machines

| Method & path                                | Access   | Description                                                                                                                                                              |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /machines`                             | ADMIN    | `{name, serialNumber, description?}` — status starts `ACTIVE`                                                                                                            |
| `GET /machines`                              | any role | Filters: `status`, `isActive`, `search`; `sortBy`: `name`, `serialNumber`, `status`, `createdAt`, `updatedAt`. Includes `activity {totalLogs, openLogs, lastActivityAt}` |
| `GET /machines/:id`                          | any role |                                                                                                                                                                          |
| `PATCH /machines/:id`                        | ADMIN    | `{name?, serialNumber?, description?}` — no status                                                                                                                       |
| `POST /machines/:id/deactivate` / `activate` | ADMIN    | Inactive machines accept no new logs                                                                                                                                     |
| `DELETE /machines/:id`                       | ADMIN    | Soft delete; `409 MACHINE_HAS_OPEN_LOGS` if logs are open                                                                                                                |
| `GET /machines/:id/logs`                     | any role | Machine history, newest first (same filters as `/machine-logs` except `machineId`)                                                                                       |
| `GET /machines/state-transitions`            | any role | Allowed transitions and log rules                                                                                                                                        |

### Machine logs

| Method & path              | Access   | Description                                                                                                                                                                                                        |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /machine-logs`       | any role | Record an event and synchronise machine status                                                                                                                                                                     |
| `GET /machine-logs`        | any role | Filters: `machineId`, `userId`, `entryStatus`, `resultingState`, `logStatus`, `from`, `to` (YYYY-MM-DD, UTC, on `startedAt`), `search`; `sortBy`: `createdAt` (default), `startedAt`, `updatedAt`, `downtimeHours` |
| `GET /machine-logs/:id`    | any role |                                                                                                                                                                                                                    |
| `PATCH /machine-logs/:id`  | any role | Requires `version`                                                                                                                                                                                                 |
| `DELETE /machine-logs/:id` | ADMIN    | Soft delete (may revert status)                                                                                                                                                                                    |

Create request:

```json
{
  "machineId": 10,
  "faultDescription": "Hydraulic pressure drop on main cylinder",
  "causeDescription": "Worn seal",
  "entryStatus": "ACTIVE",
  "remedyAction": "Isolated the cylinder",
  "resultingState": "UNDER_MAINTENANCE",
  "logStatus": "OPEN",
  "nextMaintenancePlan": "Replace seal kit on Friday",
  "startedAt": "2026-09-11T07:45:00Z"
}
```

Log resource (also used by machine history):

```json
{
  "id": 42,
  "machine": { "id": 10, "name": "Press 1", "serialNumber": "PRS-001" },
  "technician": { "id": 15, "fullName": "John Doe", "position": "Mechanic" },
  "faultDescription": "Hydraulic pressure drop on main cylinder",
  "causeDescription": "Worn seal",
  "entryStatus": "ACTIVE",
  "remedyAction": "Isolated the cylinder",
  "resultingState": "UNDER_MAINTENANCE",
  "downtimeHours": 0,
  "logStatus": "OPEN",
  "nextMaintenancePlan": "Replace seal kit on Friday",
  "startedAt": "2026-09-11T07:45:00.000Z",
  "endedAt": null,
  "version": 1,
  "createdAt": "2026-09-11T07:46:10.120Z",
  "updatedAt": "2026-09-11T07:46:10.120Z"
}
```

Example: `GET /api/v1/machine-logs?machineId=10&logStatus=OPEN&page=1&limit=20`

### Analytics

All accept `?days=N` (1–366, default 30) **or** `?from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive, UTC, ≤ 366 days).
Log metrics include logs whose `startedAt` falls in the range; deleted logs are excluded.

| Method & path                                  | Returns                                                                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /analytics/overview`                      | Machine counts (`total`, `active`, `underMaintenance`, `downtime`, `underTest`, `inactive`), log counts in range (`total`, `open`, `closed`) plus `currentlyOpen`, `totalDowntimeHours` |
| `GET /analytics/downtime?limit=`               | Total downtime and downtime by machine                                                                                                                                                  |
| `GET /analytics/maintenance-events?limit=`     | Open/closed totals and events by machine                                                                                                                                                |
| `GET /analytics/technicians?limit=`            | Logs, open/closed and downtime by technician                                                                                                                                            |
| `GET /analytics/faults?limit=&minOccurrences=` | Most common (normalised) fault descriptions and recurring issues per machine                                                                                                            |

### Audit logs (ADMIN)

| Method & path         | Description                                                                  |
| --------------------- | ---------------------------------------------------------------------------- |
| `GET /audit-logs`     | Filters: `userId`, `action`, `entity`, `entityId`, `from`, `to`; `sortOrder` |
| `GET /audit-logs/:id` |                                                                              |

Audited actions: `LOGIN_SUCCEEDED`, `LOGIN_FAILED`, `ACCOUNT_LOCKED`, `LOGOUT`, `TOKEN_REUSE_DETECTED`,
`PASSWORD_CHANGED`, `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_COMPLETED`, `TECHNICIAN_CREATED`,
`TEMPORARY_CREDENTIAL_REISSUED`, `USER_UPDATED`, `USER_PROFILE_UPDATED`, `USER_DEACTIVATED`, `USER_ACTIVATED`,
`USER_DELETED`, `MACHINE_CREATED`, `MACHINE_UPDATED`, `MACHINE_DEACTIVATED`, `MACHINE_ACTIVATED`, `MACHINE_DELETED`,
`MACHINE_STATUS_CHANGED`, `MACHINE_LOG_CREATED`, `MACHINE_LOG_UPDATED`, `MACHINE_LOG_DELETED`.

### Health (public)

| Method & path      | Description                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`      | `status: ok \| degraded \| down` with application, database and email checks. `503` when the database is down; `degraded` (200) when only email is unavailable |
| `GET /health/live` | Liveness only (used by the Docker health check)                                                                                                                |

## Status codes and error codes

| HTTP | Codes                                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`, `BAD_REQUEST`, `INVALID_RESET_TOKEN`, `INVALID_TIME_RANGE`                                                                                                                                          |
| 401  | `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, `TOKEN_REVOKED`, `TEMPORARY_PASSWORD_EXPIRED`                                                                                                  |
| 403  | `FORBIDDEN`, `PASSWORD_CHANGE_REQUIRED`, `USER_INACTIVE`, `USER_SELF_MODIFICATION_FORBIDDEN`, `CORS_ORIGIN_DENIED`                                                                                                      |
| 404  | `NOT_FOUND`, `ROUTE_NOT_FOUND`, `USER_NOT_FOUND`, `MACHINE_NOT_FOUND`, `MACHINE_LOG_NOT_FOUND`                                                                                                                          |
| 409  | `USER_EMAIL_EXISTS`, `USER_PHONE_EXISTS`, `MACHINE_SERIAL_EXISTS`, `MACHINE_HAS_OPEN_LOGS`, `MACHINE_STATE_CONFLICT`, `STALE_VERSION`, `RESULTING_STATE_IMMUTABLE`                                                      |
| 413  | `PAYLOAD_TOO_LARGE`                                                                                                                                                                                                     |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                                                                                                                                                                                                |
| 422  | `INVALID_STATE_TRANSITION`, `INVALID_LOG_STATUS`, `INVALID_LOG_TIMES`, `INVALID_DOWNTIME`, `MACHINE_INACTIVE`, `USER_NOT_TECHNICIAN`, `USER_INACTIVE`, `INVALID_CREDENTIALS` (wrong current password), `PASSWORD_REUSE` |
| 423  | `ACCOUNT_LOCKED`                                                                                                                                                                                                        |
| 429  | `RATE_LIMITED`                                                                                                                                                                                                          |
| 500  | `INTERNAL_ERROR`                                                                                                                                                                                                        |
| 503  | `SERVICE_UNAVAILABLE` (e.g. credentials email could not be sent)                                                                                                                                                        |

Suggested client handling: on `401 TOKEN_EXPIRED` call `/auth/refresh` once and retry; on other `401` codes send
the user to login; on `403 PASSWORD_CHANGE_REQUIRED` show the change-password screen; on `409` reload the resource.

## Live status board (Socket.IO)

| Item            | Value                                                                |
| --------------- | -------------------------------------------------------------------- |
| Path            | `/socket.io`                                                         |
| Namespace       | `/status-board`                                                      |
| Authentication  | `auth: { token: <accessToken> }` (or `Authorization: Bearer` header) |
| Server → client | `machine.status.updated`, `session.expired`                          |

```js
import { io } from 'socket.io-client';

const socket = io('https://api.example.com/status-board', {
  path: '/socket.io',
  auth: (cb) => cb({ token: getAccessToken() }), // re-evaluated on every reconnect
});

socket.on('machine.status.updated', (event) => updateBoard(event));
socket.on('session.expired', async () => {
  await refreshTokens();
  socket.connect();
});
socket.on('connect_error', (err) => console.warn(err.message)); // e.g. TOKEN_EXPIRED, PASSWORD_CHANGE_REQUIRED
```

`machine.status.updated` payload (emitted only after the change is committed):

```json
{
  "machineId": 15,
  "machineName": "Press 1",
  "serialNumber": "PRS-001",
  "previousStatus": "ACTIVE",
  "newStatus": "UNDER_MAINTENANCE",
  "updatedBy": { "id": 10, "name": "John Doe" },
  "logId": 42,
  "source": "MACHINE_LOG_CREATED",
  "timestamp": "2026-09-11T07:46:10.120Z"
}
```

`source` is `MACHINE_LOG_CREATED`, `MACHINE_LOG_UPDATED` or `MACHINE_LOG_DELETED`. The server disconnects a socket
when its access token expires (after emitting `session.expired`); reconnect with a fresh token.
