import { type DataSource, type EntityManager, IsNull } from 'typeorm';
import { PasswordResetToken } from '../entities/password-reset-token.entity';

export type NewPasswordResetToken = Pick<
  PasswordResetToken,
  'userId' | 'tokenHash' | 'expiresAt' | 'ipAddress'
>;

export class PasswordResetTokenRepository {
  constructor(private readonly dataSource: DataSource) {}

  private repo(manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).getRepository(PasswordResetToken);
  }

  async insert(token: NewPasswordResetToken, manager?: EntityManager): Promise<void> {
    await this.repo(manager).insert(token);
  }

  findByHashForUpdate(tokenHash: string, manager: EntityManager): Promise<PasswordResetToken | null> {
    return this.repo(manager)
      .createQueryBuilder('token')
      .setLock('pessimistic_write')
      .where('token.tokenHash = :tokenHash', { tokenHash })
      .getOne();
  }

  /** Removes tokens that expired before `olderThan`. Returns the number deleted. */
  async deleteExpiredBefore(olderThan: Date): Promise<number> {
    const result = await this.repo()
      .createQueryBuilder()
      .delete()
      .where('expires_at < :olderThan', { olderThan })
      .execute();
    return result.affected ?? 0;
  }

  /** Consumes every outstanding token for the user (single active reset link at a time). */
  async invalidateOutstanding(userId: number, at: Date, manager: EntityManager): Promise<void> {
    await this.repo(manager).update({ userId, usedAt: IsNull() }, { usedAt: at });
  }
}
