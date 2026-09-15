import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Initial Maintenance Monitor schema.
 *
 * Hand-written (rather than generated) so the shared `machine_state` enum is
 * created exactly once and objects are created in dependency order.
 * `npm run migration:check` verifies that entities and schema do not drift.
 */
export class InitialSchema1789000000000 implements MigrationInterface {
  name = 'InitialSchema1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- Enum types ---------------------------------------------------------
    await queryRunner.query(`CREATE TYPE "public"."user_role" AS ENUM ('ADMIN', 'TECHNICIAN')`);
    await queryRunner.query(
      `CREATE TYPE "public"."machine_state" AS ENUM ('ACTIVE', 'UNDER_MAINTENANCE', 'DOWNTIME', 'UNDER_TEST')`,
    );
    await queryRunner.query(`CREATE TYPE "public"."log_status" AS ENUM ('OPEN', 'CLOSED')`);

    // ---- users ----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" SERIAL NOT NULL,
        "full_name" character varying(120) NOT NULL,
        "email" character varying(254) NOT NULL,
        "phone" character varying(20) NOT NULL,
        "password_hash" character varying(255) NOT NULL,
        "position" character varying(100),
        "role" "public"."user_role" NOT NULL DEFAULT 'TECHNICIAN',
        "is_active" boolean NOT NULL DEFAULT true,
        "must_change_password" boolean NOT NULL DEFAULT false,
        "password_expires_at" TIMESTAMP WITH TIME ZONE,
        "password_changed_at" TIMESTAMP WITH TIME ZONE,
        "failed_login_attempts" integer NOT NULL DEFAULT '0',
        "locked_until" TIMESTAMP WITH TIME ZONE,
        "last_login_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email"),
        CONSTRAINT "UQ_users_phone" UNIQUE ("phone"),
        CONSTRAINT "CHK_users_email_lowercase" CHECK ("email" = lower("email")),
        CONSTRAINT "CHK_users_failed_login_attempts" CHECK ("failed_login_attempts" >= 0)
      )
    `);

    // ---- refresh_tokens --------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" uuid NOT NULL,
        "user_id" integer NOT NULL,
        "family_id" uuid NOT NULL,
        "token_hash" character(64) NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "revoked_reason" character varying(32),
        "replaced_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "ip_address" character varying(64),
        "user_agent" character varying(512),
        CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_refresh_tokens_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "FK_refresh_tokens_user_id" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_user_id" ON "refresh_tokens" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_family_id" ON "refresh_tokens" ("family_id")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_expires_at" ON "refresh_tokens" ("expires_at")`,
    );

    // ---- password_reset_tokens ---------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "password_reset_tokens" (
        "id" SERIAL NOT NULL,
        "user_id" integer NOT NULL,
        "token_hash" character(64) NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "used_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "ip_address" character varying(64),
        CONSTRAINT "PK_password_reset_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_password_reset_tokens_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "FK_password_reset_tokens_user_id" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_password_reset_tokens_user_id" ON "password_reset_tokens" ("user_id")`,
    );

    // ---- machines -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "machines" (
        "id" SERIAL NOT NULL,
        "name" character varying(120) NOT NULL,
        "serial_number" character varying(64) NOT NULL,
        "status" "public"."machine_state" NOT NULL DEFAULT 'ACTIVE',
        "description" character varying(2000),
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_machines" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_machines_serial_number" UNIQUE ("serial_number"),
        CONSTRAINT "CHK_machines_serial_number_uppercase" CHECK ("serial_number" = upper("serial_number"))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_machines_status" ON "machines" ("status")`);

    // ---- machine_logs -------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "machine_logs" (
        "id" SERIAL NOT NULL,
        "machine_id" integer NOT NULL,
        "user_id" integer NOT NULL,
        "fault_description" character varying(2000) NOT NULL,
        "cause_description" character varying(2000),
        "entry_status" "public"."machine_state" NOT NULL,
        "remedy_action" character varying(2000),
        "resulting_state" "public"."machine_state" NOT NULL,
        "downtime_hours" numeric(10,2) NOT NULL DEFAULT '0',
        "log_status" "public"."log_status" NOT NULL DEFAULT 'OPEN',
        "next_maintenance_plan" character varying(1000),
        "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "ended_at" TIMESTAMP WITH TIME ZONE,
        "version" integer NOT NULL DEFAULT '1',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_machine_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_machine_logs_machine_id" FOREIGN KEY ("machine_id")
          REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_machine_logs_user_id" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "CHK_machine_logs_downtime_non_negative" CHECK ("downtime_hours" >= 0),
        CONSTRAINT "CHK_machine_logs_ended_after_started" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at"),
        CONSTRAINT "CHK_machine_logs_status_end_time" CHECK (
          ("log_status" = 'OPEN' AND "ended_at" IS NULL) OR ("log_status" = 'CLOSED' AND "ended_at" IS NOT NULL)
        )
      )
    `);
    // (machine_id, created_at) also serves plain machine_id lookups.
    await queryRunner.query(
      `CREATE INDEX "IDX_machine_logs_machine_id_created_at" ON "machine_logs" ("machine_id", "created_at")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_machine_logs_user_id" ON "machine_logs" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_machine_logs_created_at" ON "machine_logs" ("created_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_machine_logs_log_status" ON "machine_logs" ("log_status")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_machine_logs_resulting_state" ON "machine_logs" ("resulting_state")`,
    );

    // ---- audit_logs -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "audit_logs" (
        "id" BIGSERIAL NOT NULL,
        "user_id" integer,
        "action" character varying(64) NOT NULL,
        "entity" character varying(64) NOT NULL,
        "entity_id" character varying(64),
        "old_values" jsonb,
        "new_values" jsonb,
        "ip_address" character varying(64),
        "user_agent" character varying(512),
        "request_id" character varying(64),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_audit_logs_user_id" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_audit_logs_user_id" ON "audit_logs" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_audit_logs_action" ON "audit_logs" ("action")`);
    await queryRunner.query(`CREATE INDEX "IDX_audit_logs_created_at" ON "audit_logs" ("created_at")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_entity_entity_id" ON "audit_logs" ("entity", "entity_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP TABLE "machine_logs"`);
    await queryRunner.query(`DROP TABLE "machines"`);
    await queryRunner.query(`DROP TABLE "password_reset_tokens"`);
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."log_status"`);
    await queryRunner.query(`DROP TYPE "public"."machine_state"`);
    await queryRunner.query(`DROP TYPE "public"."user_role"`);
  }
}
