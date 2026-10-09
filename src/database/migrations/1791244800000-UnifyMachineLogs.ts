import { type MigrationInterface, type QueryRunner } from 'typeorm';

/** Severity order used to derive a machine's effective status (see MACHINE_STATUS_SEVERITY). */
const SEVERITY = `ARRAY['ACTIVE', 'UNDER_TEST', 'UNDER_MAINTENANCE', 'DOWNTIME']::"public"."machine_state"[]`;

const OPERATIONAL_FROM_STATE = (column: string) => `CASE ${column}
               WHEN 'ACTIVE' THEN 'OPERATING'::"public"."machine_operational_status"
               WHEN 'UNDER_TEST' THEN 'OPERATING_WITH_DEFECTS'::"public"."machine_operational_status"
               ELSE 'NOT_OPERATING'::"public"."machine_operational_status"
             END`;

/**
 * One machine history, and a machine status that follows its parts.
 *
 * - `machines.system_status` (new) is the state of the machine as a whole,
 *   owned by whole-machine logs. `machines.status` becomes the effective status:
 *   the most severe of the system status and every active part's status.
 * - `machine_part_logs` is merged into `machine_logs`, which gains `scope`
 *   (MACHINE | PART), `machine_part_id`, `operational_impact` and the machine's
 *   status before/after each event. Part logs keep their order (they are
 *   inserted by creation time) and their audit entries are re-pointed to the
 *   new log ids.
 *
 * Status snapshots cannot be reconstructed for past events: whole-machine logs
 * use their entry/resulting state, and migrated part logs use the part's
 * entry/resulting state (a lower bound of the machine's status at the time).
 */
export class UnifyMachineLogs1791244800000 implements MigrationInterface {
  name = 'UnifyMachineLogs1791244800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- machines.system_status ----------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "machines" ADD COLUMN "system_status" "public"."machine_state" NOT NULL DEFAULT 'ACTIVE'`,
    );
    // Until now `status` was only ever written by machine logs: it is the system status.
    await queryRunner.query(`UPDATE "machines" SET "system_status" = "status"`);

    // ---- machine_logs: scope, part and status snapshots ------------------------------
    await queryRunner.query(`CREATE TYPE "public"."log_scope" AS ENUM ('MACHINE', 'PART')`);
    await queryRunner.query(`
      ALTER TABLE "machine_logs"
        ADD COLUMN "scope" "public"."log_scope" NOT NULL DEFAULT 'MACHINE',
        ADD COLUMN "machine_part_id" integer,
        ADD COLUMN "operational_impact" "public"."operational_impact",
        ADD COLUMN "machine_status_before" "public"."machine_state",
        ADD COLUMN "machine_status_after" "public"."machine_state",
        ADD COLUMN "operational_status_before" "public"."machine_operational_status",
        ADD COLUMN "operational_status_after" "public"."machine_operational_status",
        ADD COLUMN "legacy_part_log_id" integer
    `);
    await queryRunner.query(`
      UPDATE "machine_logs"
         SET "machine_status_before" = "entry_status",
             "machine_status_after" = "resulting_state",
             "operational_status_before" = ${OPERATIONAL_FROM_STATE('"entry_status"')},
             "operational_status_after" = ${OPERATIONAL_FROM_STATE('"resulting_state"')}
    `);

    // ---- move part logs into machine_logs ------------------------------------------------
    await queryRunner.query(`
      INSERT INTO "machine_logs" (
        "machine_id", "scope", "machine_part_id", "user_id", "fault_description", "cause_description",
        "entry_status", "remedy_action", "resulting_state", "operational_impact",
        "machine_status_before", "machine_status_after", "operational_status_before", "operational_status_after",
        "downtime_hours", "log_status", "next_maintenance_plan", "started_at", "ended_at", "version",
        "created_at", "updated_at", "deleted_at", "legacy_part_log_id"
      )
      SELECT l."machine_id", 'PART', l."machine_part_id", l."user_id", l."fault_description", l."cause_description",
             l."previous_status", l."remedy_action", l."resulting_status", l."operational_impact",
             l."previous_status", l."resulting_status",
             CASE WHEN l."previous_status" = 'ACTIVE' THEN 'OPERATING'::"public"."machine_operational_status"
                  ELSE 'OPERATING_WITH_DEFECTS'::"public"."machine_operational_status" END,
             CASE WHEN l."resulting_status" = 'ACTIVE' THEN 'OPERATING'::"public"."machine_operational_status"
                  WHEN l."operational_impact" = 'BLOCKING' THEN 'NOT_OPERATING'::"public"."machine_operational_status"
                  ELSE 'OPERATING_WITH_DEFECTS'::"public"."machine_operational_status" END,
             l."downtime_hours", l."log_status", NULL, l."started_at", l."ended_at", l."version",
             l."created_at", l."updated_at", l."deleted_at", l."id"
        FROM "machine_part_logs" l
       ORDER BY l."created_at", l."id"
    `);
    await queryRunner.query(`
      UPDATE "audit_logs" a
         SET "entity" = 'MACHINE_LOG', "entity_id" = l."id"::text
        FROM "machine_logs" l
       WHERE a."entity" = 'MACHINE_PART_LOG' AND a."entity_id" = l."legacy_part_log_id"::text
    `);
    await queryRunner.query(`ALTER TABLE "machine_logs" DROP COLUMN "legacy_part_log_id"`);
    await queryRunner.query(`DROP TABLE "machine_part_logs"`);

    // ---- constraints and indexes ------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "machine_logs"
        ALTER COLUMN "machine_status_before" SET NOT NULL,
        ALTER COLUMN "machine_status_after" SET NOT NULL,
        ALTER COLUMN "operational_status_before" SET NOT NULL,
        ALTER COLUMN "operational_status_after" SET NOT NULL,
        ADD CONSTRAINT "FK_machine_logs_machine_part_id" FOREIGN KEY ("machine_part_id")
          REFERENCES "machine_parts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        ADD CONSTRAINT "CHK_machine_logs_scope_part" CHECK (
          ("scope" = 'MACHINE' AND "machine_part_id" IS NULL AND "operational_impact" IS NULL)
          OR ("scope" = 'PART' AND "machine_part_id" IS NOT NULL AND "operational_impact" IS NOT NULL)
        ),
        ADD CONSTRAINT "CHK_machine_logs_active_part_is_non_blocking" CHECK (
          "operational_impact" IS NULL OR "resulting_state" <> 'ACTIVE' OR "operational_impact" = 'NON_BLOCKING'
        )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_machine_logs_scope" ON "machine_logs" ("scope")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_machine_logs_machine_part_id_created_at" ON "machine_logs" ("machine_part_id", "created_at")`,
    );

    // ---- machines.status: the most severe of the system status and the active parts ------
    await queryRunner.query(`
      UPDATE "machines" m
         SET "status" = (${SEVERITY})[derived."severity"]
        FROM (
          SELECT mm."id",
                 GREATEST(
                   array_position(${SEVERITY}, mm."system_status"),
                   COALESCE(MAX(array_position(${SEVERITY}, p."status")), 1)
                 ) AS "severity"
            FROM "machines" mm
            LEFT JOIN "machine_parts" p
              ON p."machine_id" = mm."id" AND p."deleted_at" IS NULL AND p."is_active"
           GROUP BY mm."id"
        ) derived
       WHERE derived."id" = m."id"
    `);
  }

  /** Splits part logs back into `machine_part_logs` and restores `status` as the workflow status. */
  public async down(queryRunner: QueryRunner): Promise<void> {
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
    await queryRunner.query(`
      INSERT INTO "machine_part_logs" (
        "id", "machine_id", "machine_part_id", "user_id", "previous_status", "resulting_status",
        "operational_impact", "fault_description", "cause_description", "remedy_action", "downtime_hours",
        "log_status", "started_at", "ended_at", "version", "created_at", "updated_at", "deleted_at"
      )
      SELECT "id", "machine_id", "machine_part_id", "user_id", "entry_status", "resulting_state",
             "operational_impact", "fault_description", "cause_description", "remedy_action", "downtime_hours",
             "log_status", "started_at", "ended_at", "version", "created_at", "updated_at", "deleted_at"
        FROM "machine_logs"
       WHERE "scope" = 'PART'
    `);
    await queryRunner.query(
      `SELECT setval(pg_get_serial_sequence('machine_part_logs', 'id'), COALESCE(MAX("id"), 0) + 1, false) FROM "machine_part_logs"`,
    );
    await queryRunner.query(`
      UPDATE "audit_logs" a
         SET "entity" = 'MACHINE_PART_LOG'
        FROM "machine_part_logs" l
       WHERE a."entity" = 'MACHINE_LOG' AND a."entity_id" = l."id"::text
    `);
    await queryRunner.query(`DELETE FROM "machine_logs" WHERE "scope" = 'PART'`);
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

    await queryRunner.query(`DROP INDEX "public"."IDX_machine_logs_machine_part_id_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_machine_logs_scope"`);
    await queryRunner.query(`
      ALTER TABLE "machine_logs"
        DROP CONSTRAINT "CHK_machine_logs_active_part_is_non_blocking",
        DROP CONSTRAINT "CHK_machine_logs_scope_part",
        DROP CONSTRAINT "FK_machine_logs_machine_part_id",
        DROP COLUMN "operational_status_after",
        DROP COLUMN "operational_status_before",
        DROP COLUMN "machine_status_after",
        DROP COLUMN "machine_status_before",
        DROP COLUMN "operational_impact",
        DROP COLUMN "machine_part_id",
        DROP COLUMN "scope"
    `);
    await queryRunner.query(`DROP TYPE "public"."log_scope"`);

    await queryRunner.query(`UPDATE "machines" SET "status" = "system_status"`);
    await queryRunner.query(`ALTER TABLE "machines" DROP COLUMN "system_status"`);
  }
}
