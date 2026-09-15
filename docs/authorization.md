# Authorization

Two roles: `ADMIN` and `TECHNICIAN`. Each route declares its allowed roles in its route definition; the mounter
authenticates, then `assertAuthorized` (`src/common/http/authorization.ts`) enforces the roles and the
"password change required" gate in one place. The role is loaded from the database on every request.

Unauthenticated → `401 UNAUTHORIZED` (or a more specific token code). Authenticated but not allowed →
`403 FORBIDDEN`. Temporary password not yet changed → `403 PASSWORD_CHANGE_REQUIRED`.

## Permission matrix

| Endpoint                                                                             | ADMIN  | TECHNICIAN | Notes                                             |
| ------------------------------------------------------------------------------------ | :----: | :--------: | ------------------------------------------------- |
| `POST /auth/login`, `/auth/refresh`, `/auth/forgot-password`, `/auth/reset-password` | public |   public   | Rate limited                                      |
| `POST /auth/logout`, `/auth/change-password`                                         |   ✅   |     ✅     | Allowed while a password change is pending        |
| `GET /users/me`                                                                      |   ✅   |     ✅     | Allowed while a password change is pending        |
| `PATCH /users/me` (name, phone)                                                      |   ✅   |     ✅     | Email, role and position are admin-managed        |
| `POST /users` (create technician)                                                    |   ✅   |     ❌     |                                                   |
| `GET /users`, `GET /users/:id`                                                       |   ✅   |     ❌     |                                                   |
| `PATCH /users/:id`                                                                   |   ✅   |     ❌     | Role cannot be changed through the API            |
| `POST /users/:id/deactivate`, `/activate`                                            |   ✅   |     ❌     | Not on own account; deactivation revokes sessions |
| `POST /users/:id/reissue-temporary-password`                                         |   ✅   |     ❌     | Technicians only                                  |
| `DELETE /users/:id` (soft)                                                           |   ✅   |     ❌     | Not on own account                                |
| `POST /machines`                                                                     |   ✅   |     ❌     | Status is always `ACTIVE`                         |
| `GET /machines`, `GET /machines/:id`                                                 |   ✅   |     ✅     |                                                   |
| `PATCH /machines/:id`                                                                |   ✅   |     ❌     | `status` is rejected for everyone                 |
| `POST /machines/:id/deactivate`, `/activate`                                         |   ✅   |     ❌     |                                                   |
| `DELETE /machines/:id` (soft)                                                        |   ✅   |     ❌     | Refused while logs are open                       |
| `GET /machines/:id/logs` (history)                                                   |   ✅   |     ✅     |                                                   |
| `GET /machines/state-transitions`                                                    |   ✅   |     ✅     |                                                   |
| `POST /machine-logs`                                                                 |   ✅   |     ✅     | Author is always the caller                       |
| `GET /machine-logs`, `GET /machine-logs/:id`                                         |   ✅   |     ✅     |                                                   |
| `PATCH /machine-logs/:id`                                                            |   ✅   |     ✅     | Any technician may progress a shared event        |
| `DELETE /machine-logs/:id` (soft)                                                    |   ✅   |     ❌     |                                                   |
| `GET /analytics/*`                                                                   |   ✅   |     ✅     |                                                   |
| `GET /audit-logs`, `GET /audit-logs/:id`                                             |   ✅   |     ❌     |                                                   |
| `GET /health`, `GET /health/live`                                                    | public |   public   |                                                   |
| WebSocket `/status-board`                                                            |   ✅   |     ✅     | Password change must be completed                 |

## Machine status protection

There is **no** endpoint that sets machine status directly — not for technicians and not for administrators:

- `POST /machines` and `PATCH /machines/:id` use strict schemas; a `status` field is rejected with `400`.
- There is no `/machines/:id/status` route.
- `MachinesRepository.updateStatus` is called only by `MachineLogsService`, inside the transaction that records the
  causing log and its audit entries.

## Mass assignment

All request schemas are `.strict()`: unknown fields (`role`, `userId`, `status`, `machineId` on log updates, …) are
rejected with `400 VALIDATION_ERROR` and a `details` entry `"is not allowed"`. Authorship (`user_id`) is always taken
from the authenticated principal.
