# Database

PostgreSQL (14+; the Docker stack uses 16). The schema is managed **only** by migrations
(`synchronize` is disabled everywhere). All timestamps are `timestamptz` and stored in UTC.

## Entity relationships

```mermaid
erDiagram
  users ||--o{ refresh_tokens : "has sessions"
  users ||--o{ password_reset_tokens : "requests"
  users ||--o{ machine_logs : "authors"
  users |o--o{ audit_logs : "performs"
  machines ||--o{ machine_logs : "has history"

  users {
    serial id PK
    varchar full_name
    varchar email UK "lower-case (CHECK)"
    varchar phone UK
    varchar password_hash "Argon2id"
    varchar position
    user_role role
    boolean is_active
    boolean must_change_password
    timestamptz password_expires_at "temporary credential expiry"
    timestamptz password_changed_at
    int failed_login_attempts "CHECK >= 0"
    timestamptz locked_until
    timestamptz last_login_at
    timestamptz created_at
    timestamptz updated_at
    timestamptz deleted_at "soft delete"
  }
  refresh_tokens {
    uuid id PK "JWT jti"
    int user_id FK
    uuid family_id "session id (sid)"
    char token_hash UK "SHA-256"
    timestamptz expires_at
    timestamptz revoked_at
    varchar revoked_reason
    uuid replaced_by_id
    timestamptz created_at
    varchar ip_address
    varchar user_agent
  }
  password_reset_tokens {
    serial id PK
    int user_id FK
    char token_hash UK "SHA-256"
    timestamptz expires_at
    timestamptz used_at
    timestamptz created_at
    varchar ip_address
  }
  machines {
    serial id PK
    varchar name
    varchar serial_number UK "upper-case (CHECK)"
    machine_state status "default ACTIVE"
    varchar description
    boolean is_active
    timestamptz created_at
    timestamptz updated_at
    timestamptz deleted_at
  }
  machine_logs {
    serial id PK
    int machine_id FK
    int user_id FK
    varchar fault_description
    varchar cause_description
    machine_state entry_status
    varchar remedy_action
    machine_state resulting_state
    numeric downtime_hours "CHECK >= 0"
    log_status log_status
    varchar next_maintenance_plan
    timestamptz started_at
    timestamptz ended_at
    int version "optimistic concurrency"
    timestamptz created_at
    timestamptz updated_at
    timestamptz deleted_at
  }
  audit_logs {
    bigserial id PK
    int user_id FK "nullable, ON DELETE SET NULL"
    varchar action
    varchar entity
    varchar entity_id
    jsonb old_values
    jsonb new_values
    varchar ip_address
    varchar user_agent
    varchar request_id
    timestamptz created_at
  }
```

## Enum types

| Type            | Values                                                  | Used by                                                                        |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `user_role`     | `ADMIN`, `TECHNICIAN`                                   | `users.role`                                                                   |
| `machine_state` | `ACTIVE`, `UNDER_MAINTENANCE`, `DOWNTIME`, `UNDER_TEST` | `machines.status`, `machine_logs.entry_status`, `machine_logs.resulting_state` |
| `log_status`    | `OPEN`, `CLOSED`                                        | `machine_logs.log_status`                                                      |

`machine_state` is a single shared type, mirrored by the reusable `MachineState` TypeScript enum.

## Constraints

| Constraint                                                            | Rule                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `UQ_users_email`, `UQ_users_phone`                                    | Email and phone are globally unique (including soft-deleted users)  |
| `CHK_users_email_lowercase`                                           | Emails are stored normalised to lower case                          |
| `CHK_users_failed_login_attempts`                                     | Counter is never negative                                           |
| `UQ_machines_serial_number`, `CHK_machines_serial_number_uppercase`   | Serial numbers are unique, normalised to upper case                 |
| `FK_machine_logs_machine_id`, `FK_machine_logs_user_id`               | `ON DELETE RESTRICT` — history can never lose its machine or author |
| `CHK_machine_logs_downtime_non_negative`                              | `downtime_hours >= 0`                                               |
| `CHK_machine_logs_ended_after_started`                                | `ended_at IS NULL OR ended_at >= started_at`                        |
| `CHK_machine_logs_status_end_time`                                    | `OPEN ⇒ ended_at IS NULL`, `CLOSED ⇒ ended_at IS NOT NULL`          |
| `UQ_refresh_tokens_token_hash`, `UQ_password_reset_tokens_token_hash` | Token hashes are unique                                             |
| `FK_refresh_tokens_user_id`, `FK_password_reset_tokens_user_id`       | `ON DELETE CASCADE` (credentials only)                              |
| `FK_audit_logs_user_id`                                               | `ON DELETE SET NULL` — the trail survives any user removal          |

The application validates the same rules first (for friendly errors); the constraints are the last line of defence.

## Indexes

| Index                                                                                                             | Purpose                                                  |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `UQ_users_email`, `UQ_users_phone` (unique)                                                                       | Login and uniqueness lookups                             |
| `UQ_machines_serial_number` (unique)                                                                              | Serial lookups                                           |
| `IDX_machines_status`                                                                                             | Status board filters and analytics                       |
| `IDX_machine_logs_machine_id_created_at`                                                                          | Machine history (also serves plain `machine_id` lookups) |
| `IDX_machine_logs_user_id`                                                                                        | Logs by technician                                       |
| `IDX_machine_logs_created_at`                                                                                     | Default ordering                                         |
| `IDX_machine_logs_log_status`                                                                                     | Open/closed filters                                      |
| `IDX_machine_logs_resulting_state`                                                                                | State filters                                            |
| `IDX_refresh_tokens_user_id`, `IDX_refresh_tokens_family_id`, `IDX_refresh_tokens_expires_at`                     | Session revocation, per-request session check, cleanup   |
| `IDX_password_reset_tokens_user_id`                                                                               | Invalidating outstanding reset tokens                    |
| `IDX_audit_logs_user_id`, `IDX_audit_logs_action`, `IDX_audit_logs_created_at`, `IDX_audit_logs_entity_entity_id` | Audit browsing filters                                   |

## Soft deletion

Users, machines and machine logs use `deleted_at`. Soft-deleted rows disappear from normal queries but remain
referenced by history: machine logs still show their machine and technician, and audit entries keep their actor.
Deleting a user or machine also sets `is_active = false`.

## Migrations

- Location: `src/database/migrations/`, registered in `src/database/migrations/index.ts` (explicit list, works
  identically from `src` and compiled `dist`).
- History table: `schema_migrations`. Each migration runs in its own transaction.
- `InitialSchema1789000000000` is hand-written so the shared enum is created once and objects are created in
  dependency order.

```bash
npm run migration:show                                    # pending?
npm run migration:run                                     # apply
npm run migration:revert                                  # undo the last one
npm run migration:check                                   # fails if entities and schema differ
npm run migration:generate -- src/database/migrations/AddSites   # after changing entities, then review & register it
```

In containers run `node dist/database/scripts/migrate.js run` (the `migrate` service in `docker-compose.yml`)
before starting the API. Never enable `synchronize` in any environment.
