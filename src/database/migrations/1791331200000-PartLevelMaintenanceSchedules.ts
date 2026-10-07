import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Moves preventive maintenance from one plan per machine to many tasks per
 * machine, each either for a part (`machine_part_id`) or machine-wide, with its
 * own interval (the plant inspection schedule: "Cutting head – weekly",
 * "Laser generator – monthly", "External cleaning – daily", ...).
 *
 * Existing schedules are kept as machine-wide tasks named "General maintenance",
 * so their due dates, events and reminders are unaffected.
 *
 * `down()` restores one schedule per machine and fails while any machine has
 * more than one schedule; remove the extra schedules first.
 */
export class PartLevelMaintenanceSchedules1791331200000 implements MigrationInterface {
  name = 'PartLevelMaintenanceSchedules1791331200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- maintenance_schedules ---------------------------------------------------
    await queryRunner.query(`ALTER TABLE "maintenance_schedules" ADD COLUMN "machine_part_id" integer`);
    await queryRunner.query(
      `ALTER TABLE "maintenance_schedules" ADD COLUMN "task_name" character varying(160)`,
    );
    await queryRunner.query(`UPDATE "maintenance_schedules" SET "task_name" = 'General maintenance'`);
    await queryRunner.query(`ALTER TABLE "maintenance_schedules" ALTER COLUMN "task_name" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "maintenance_schedules" ADD COLUMN "description" character varying(2000)`,
    );
    await queryRunner.query(`
      ALTER TABLE "maintenance_schedules"
        ADD CONSTRAINT "FK_maintenance_schedules_machine_part_id" FOREIGN KEY ("machine_part_id")
        REFERENCES "machine_parts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_schedules_machine_part_id" ON "maintenance_schedules" ("machine_part_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_schedules" DROP CONSTRAINT "UQ_maintenance_schedules_machine_id"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_maintenance_schedules_part_task" ON "maintenance_schedules" ("machine_part_id", "task_name")
        WHERE "machine_part_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_maintenance_schedules_machine_task" ON "maintenance_schedules" ("machine_id", "task_name")
        WHERE "machine_part_id" IS NULL
    `);

    // ---- maintenance_events ------------------------------------------------------
    await queryRunner.query(`ALTER TABLE "maintenance_events" ADD COLUMN "machine_part_id" integer`);
    await queryRunner.query(`
      ALTER TABLE "maintenance_events"
        ADD CONSTRAINT "FK_maintenance_events_machine_part_id" FOREIGN KEY ("machine_part_id")
        REFERENCES "machine_parts"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_maintenance_events_machine_part_id" ON "maintenance_events" ("machine_part_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_maintenance_events_machine_part_id"`);
    await queryRunner.query(
      `ALTER TABLE "maintenance_events" DROP CONSTRAINT "FK_maintenance_events_machine_part_id"`,
    );
    await queryRunner.query(`ALTER TABLE "maintenance_events" DROP COLUMN "machine_part_id"`);

    await queryRunner.query(`DROP INDEX "public"."UQ_maintenance_schedules_machine_task"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_maintenance_schedules_part_task"`);
    await queryRunner.query(`
      ALTER TABLE "maintenance_schedules"
        ADD CONSTRAINT "UQ_maintenance_schedules_machine_id" UNIQUE ("machine_id")
    `);
    await queryRunner.query(`DROP INDEX "public"."IDX_maintenance_schedules_machine_part_id"`);
    await queryRunner.query(
      `ALTER TABLE "maintenance_schedules" DROP CONSTRAINT "FK_maintenance_schedules_machine_part_id"`,
    );
    await queryRunner.query(`ALTER TABLE "maintenance_schedules" DROP COLUMN "description"`);
    await queryRunner.query(`ALTER TABLE "maintenance_schedules" DROP COLUMN "task_name"`);
    await queryRunner.query(`ALTER TABLE "maintenance_schedules" DROP COLUMN "machine_part_id"`);
  }
}
