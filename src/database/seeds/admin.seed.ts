import { type DataSource } from 'typeorm';
import { z } from 'zod';
import { type PasswordHasher } from '../../auth/password-hasher';
import { Role } from '../../common/enums/role.enum';
import { emailAddress, phoneNumber, strongPassword, text } from '../../common/validation/primitives';
import { User } from '../../users/user.entity';

export const adminSeedSchema = z.object({
  ADMIN_EMAIL: emailAddress,
  ADMIN_PASSWORD: strongPassword,
  ADMIN_NAME: text(2, 120),
  ADMIN_PHONE: phoneNumber,
});

export type AdminSeedOutcome = 'created' | 'exists';

/**
 * Creates the initial ADMIN account from environment variables. Idempotent:
 * an existing account with the same email or phone is left untouched.
 */
export async function seedAdmin(
  dataSource: DataSource,
  hasher: PasswordHasher,
  env: NodeJS.ProcessEnv,
): Promise<AdminSeedOutcome> {
  const parsed = adminSeedSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid admin seed configuration:\n  - ${fields.join('\n  - ')}`);
  }
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME, ADMIN_PHONE } = parsed.data;

  const repository = dataSource.getRepository(User);
  const existing = await repository.findOne({
    where: [{ email: ADMIN_EMAIL }, { phone: ADMIN_PHONE }],
    withDeleted: true,
  });
  if (existing) return 'exists';

  await repository.insert({
    fullName: ADMIN_NAME,
    email: ADMIN_EMAIL,
    phone: ADMIN_PHONE,
    passwordHash: await hasher.hash(ADMIN_PASSWORD),
    position: 'Administrator',
    role: Role.ADMIN,
    isActive: true,
    mustChangePassword: false,
    passwordChangedAt: new Date(),
  });
  return 'created';
}
