import { type DataSource, type EntityManager, IsNull } from 'typeorm';
import { User } from '../../users/user.entity';
import { RefreshToken, SessionRevocationReason } from '../entities/refresh-token.entity';

export type NewRefreshToken = Pick<
  RefreshToken,
  'id' | 'userId' | 'familyId' | 'tokenHash' | 'expiresAt' | 'ipAddress' | 'userAgent'
>;

export class RefreshTokenRepository {
  constructor(private readonly dataSource: DataSource) {}

  private repo(manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).getRepository(RefreshToken);
  }

  async insert(token: NewRefreshToken, manager?: EntityManager): Promise<void> {
    await this.repo(manager).insert(token);
  }

  findByIdForUpdate(id: string, manager: EntityManager): Promise<RefreshToken | null> {
    return this.repo(manager)
      .createQueryBuilder('token')
      .setLock('pessimistic_write')
      .where('token.id = :id', { id })
      .getOne();
  }

  async markRotated(id: string, replacedById: string, at: Date, manager: EntityManager): Promise<void> {
    await this.repo(manager).update(
      { id },
      { revokedAt: at, revokedReason: SessionRevocationReason.ROTATED, replacedById },
    );
  }

  async revokeFamily(
    familyId: string,
    reason: SessionRevocationReason,
    at: Date,
    manager?: EntityManager,
  ): Promise<number> {
    const result = await this.repo(manager).update(
      { familyId, revokedAt: IsNull() },
      { revokedAt: at, revokedReason: reason },
    );
    return result.affected ?? 0;
  }

  async revokeAllForUser(
    userId: number,
    reason: SessionRevocationReason,
    at: Date,
    manager?: EntityManager,
  ): Promise<number> {
    const result = await this.repo(manager).update(
      { userId, revokedAt: IsNull() },
      { revokedAt: at, revokedReason: reason },
    );
    return result.affected ?? 0;
  }

  /**
   * Loads an active user that still owns a live session (a non-revoked,
   * unexpired refresh token in the family). Used to authenticate access tokens.
   */
  findUserWithActiveSession(userId: number, familyId: string, now: Date): Promise<User | null> {
    return this.dataSource.manager
      .getRepository(User)
      .createQueryBuilder('user')
      .where('user.id = :userId', { userId })
      .andWhere('user.isActive = true')
      .andWhere(
        `EXISTS (SELECT 1 FROM "refresh_tokens" rt
                  WHERE rt."family_id" = :familyId AND rt."user_id" = "user"."id"
                    AND rt."revoked_at" IS NULL AND rt."expires_at" > :now)`,
        { familyId, now },
      )
      .getOne();
  }

  /** Removes tokens that expired more than `olderThan` ago. Returns the number deleted. */
  async deleteExpiredBefore(olderThan: Date): Promise<number> {
    const result = await this.repo()
      .createQueryBuilder()
      .delete()
      .where('expires_at < :olderThan', { olderThan })
      .execute();
    return result.affected ?? 0;
  }
}
