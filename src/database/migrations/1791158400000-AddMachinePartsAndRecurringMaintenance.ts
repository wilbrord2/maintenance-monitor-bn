import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Machine parts (with independent statuses and operational impact), part-level
 * maintenance history, and recurring preventive maintenance.
 *
 * Strictly additive: it creates new enum types and tables and adds one column
 * to `machines`. No existing row, id, log or constraint is modified or removed;
 * `machines.operational_status` is backfilled from each machine's current
 * workflow status so existing machines keep a correct derived status before any
 * part is configured.
 */
export class AddMachinePartsAndRecurringMaintenance1791158400000 implements MigrationInterface {
  name = 'AddMachinePartsAndRecurringMaintenance1791158400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- New enum types -------------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "public"."machine_operational_status" AS ENUM ('OPERATING', 'OPERATING_WITH_DEFECTS', 'NOT_OPERATING')`,
    );
    await queryRunner.query(`CREATE TYPE "public"."operational_impact" AS ENUM ('NON_BLOCKING', 'BLOCKING')`);
    await queryRunner.query(
      `CREATE TYPE "public"."maintenance_event_status" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'MISSED', 'CANCELLED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."maintenance_reminder_kind" AS ENUM ('UPCOMING', 'DUE', 'OVERDUE')`,
    );

    // ---- machines.operational_status (derived) ----------------------------------
    await queryRunner.query(
      `ALTER TABLE "machines" ADD COLUMN "operational_status" "public"."machine_operational_status" NOT NULL DEFAULT 'OPERATING'`,
    );
    // Existing machines have no parts yet: derive from the machine workflow status.
    await queryRunner.query(`
      UPDATE "machines"
         SET "operational_status" = CASE "status"
               WHEN 'ACTIVE' THEN 'OPERATING'::"public"."machine_operational_status"
               WHEN 'UNDER_TEST' THEN 'OPERATING_WITH_DEFECTS'::"public"."machine_operational_status"
               ELSE 'NOT_OPERATING'::"public"."machine_operational_status"
             END
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_machines_operational_status" ON "machines" ("operational_status")`,
    );

    // ---- machine_parts -----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "machine_parts" (
        "id" SERIAL NOT NULL,
        "machine_id" integer NOT NULL,
        "name" character varying(120) NOT NULL,
        "part_code" character varying(64) NOT NULL,
        "description" character varying(2000),
        "status" "public"."machine_state" NOT NULL DEFAULT 'ACTIVE',
        "operational_impact" "public"."operational_impact" NOT NULL DEFAULT 'NON_BLOCKING',
        "is_critical" boolean NOT NULL DEFAULT false,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_machine_parts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_machine_parts_machine_id_part_code" UNIQUE ("machine_id", "part_code"),
        CONSTRAINT "FK_machine_parts_machine_id" FOREIGN KEY ("machine_id")
          REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "CHK_machine_parts_part_code_uppercase" CHECK ("part_code" = upper("part_code")),
        CONSTRAINT "CHK_machine_parts_active_is_non_blocking"
          CHECK ("status" <> 'ACTIVE' OR "operational_impact" = 'NON_BLOCKING')
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_machine_parts_machine_id" ON "machine_parts" ("machine_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_machine_parts_status" ON "machine_parts" ("status")`);

    // ---- machine_part_logs --------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "machine_part_logs" (
        "id" SERIAL NOT NULL,
        "machine_id" integer NOT NULL,
        "machine_part_id" integer NOT NULL,
        "user_id" integer NOT NULL,
        "previous_status" "public"."machine_state" NOT NULL,
        "resulting_status" "public"."machine_state" NOT NULL,
        "operational_impact" "public"."operational_impact" NOT NULL DEFAULT 'NON_BLOCKING',
        "fault_description" character varying(2000) NOT NULL,
        "cause_description" character varying(2000),
        "remedy_action" character varying(2000),
        "downtime_hours" numeric(10,2) NOT NULL DEFAULT '0',
        "log_status" "public"."log_status" NOT NULL DEFAULT 'OPEN',
        "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "ended_at" TIMESTAMP WITH TIME ZONE,
        "version" integer NOT NULL DEFAULT '1',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_machine_part_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_machine_part_logs_machine_id" FOREIGN KEY ("machine_id")
          REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_machine_part_logs_machine_part_id" FOREIGN KEY ("machine_part_id")
          REFERENCES "machine_parts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_machine_part_logs_user_id" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "CHK_machine_part_logs_downtime_non_negative" CHECK ("downtime_hours" >= 0),
        CONSTRAINT "CHK_machine_part_logs_ended_after_started"
          CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at"),
        CONSTRAINT "CHK_machine_part_logs_status_end_time" CHECK (
          ("log_status" = 'OPEN' AND "ended_at" IS NULL) OR ("log_status" = 'CLOSED' AND "ended_at" IS NOT NULL)
        ),
        CONSTRAINT "CHK_machine_part_logs_active_is_non_blocking"
          CHECK ("resulting_status" <> 'ACTIVE' OR "operational_impact" = 'NON_BLOCKING')
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_machine_part_logs_part_id_created_at" ON "machine_part_logs" ("machine_part_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_machine_part_logs_machine_id" ON "machine_part_logs" ("machine_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_machine_part_logs_user_id" ON "machine_part_logs" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_machine_part_logs_resulting_status" ON "machine_part_logs" ("resulting_status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_machine_part_logs_log_status" ON "machine_part_logs" ("log_status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_machine_part_logs_created_at" ON "machine_part_logs" ("created_at")`,
    );

    // ---- maintenance_schedules -------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "maintenance_schedules" (
        "id" SERIAL NOT NULL,
        "machine_id" integer NOT NULL,
        "interval_days" integer NOT NULL,
        "last_maintenance_at" TIMESTAMP WITH TIME ZONE,
        "next_maintenance_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reminder_days_before" integer NOT NULL DEFAULT '3',
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_maintenance_schedules" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_maintenance_schedules_machine_id" UNIQUE ("machine_id"),
        CONSTRAINT "FK_maintenance_schedules_machine_id" FOREIGN KEY ("machine_id")
          REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "CHK_maintenance_schedules_interval_days"
          CHECK ("interval_days" >= 1 AND "interval_days" <= 3650),
        CONSTRAINT "CHK_maintenance_schedules_reminder_days"
          CHECK ("reminder_days_before" >= 0 AND "reminder_days_before" <= "interval_days")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_schedules_next_maintenance_at" ON "maintenance_schedules" ("next_maintenance_at")`,
    );

    // ---- maintenance_events -----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "maintenance_events" (
        "id" SERIAL NOT NULL,
        "maintenance_schedule_id" integer,
        "machine_id" integer NOT NULL,
        "performed_by_id" integer,
        "machine_log_id" integer,
        "scheduled_for" TIMESTAMP WITH TIME ZONE NOT NULL,
        "started_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "status" "public"."maintenance_event_status" NOT NULL DEFAULT 'SCHEDULED',
        "notes" character varying(2000),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_maintenance_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_maintenance_events_schedule_id" FOREIGN KEY ("maintenance_schedule_id")
          REFERENCES "maintenance_schedules"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_maintenance_events_machine_id" FOREIGN KEY ("machine_id")
          REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_maintenance_events_performed_by_id" FOREIGN KEY ("performed_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_maintenance_events_machine_log_id" FOREIGN KEY ("machine_log_id")
          REFERENCES "machine_logs"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "CHK_maintenance_events_in_progress_started"
          CHECK ("status" <> 'IN_PROGRESS' OR "started_at" IS NOT NULL),
        CONSTRAINT "CHK_maintenance_events_completed_at"
          CHECK (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL)),
        CONSTRAINT "CHK_maintenance_events_completed_after_started"
          CHECK ("completed_at" IS NULL OR "started_at" IS NULL OR "completed_at" >= "started_at")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_events_schedule_id" ON "maintenance_events" ("maintenance_schedule_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_events_machine_id" ON "maintenance_events" ("machine_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_events_status" ON "maintenance_events" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_events_scheduled_for" ON "maintenance_events" ("scheduled_for")`,
    );

    // ---- maintenance_notifications -------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "maintenance_notifications" (
        "id" SERIAL NOT NULL,
        "maintenance_schedule_id" integer NOT NULL,
        "kind" "public"."maintenance_reminder_kind" NOT NULL,
        "cycle_due_on" date NOT NULL,
        "recipients" integer NOT NULL DEFAULT '0',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_maintenance_notifications" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_maintenance_notifications_schedule_kind_cycle"
          UNIQUE ("maintenance_schedule_id", "kind", "cycle_due_on"),
        CONSTRAINT "FK_maintenance_notifications_schedule_id" FOREIGN KEY ("maintenance_schedule_id")
          REFERENCES "maintenance_schedules"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  /** Reverts only what `up` created; existing machines, logs and users are untouched. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "maintenance_notifications"`);
    await queryRunner.query(`DROP TABLE "maintenance_events"`);
    await queryRunner.query(`DROP TABLE "maintenance_schedules"`);
    await queryRunner.query(`DROP TABLE "machine_part_logs"`);
    await queryRunner.query(`DROP TABLE "machine_parts"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_machines_operational_status"`);
    await queryRunner.query(`ALTER TABLE "machines" DROP COLUMN "operational_status"`);
    await queryRunner.query(`DROP TYPE "public"."maintenance_reminder_kind"`);
    await queryRunner.query(`DROP TYPE "public"."maintenance_event_status"`);
    await queryRunner.query(`DROP TYPE "public"."operational_impact"`);
    await queryRunner.query(`DROP TYPE "public"."machine_operational_status"`);
  }
}
