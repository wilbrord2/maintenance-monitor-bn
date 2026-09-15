import argon2 from 'argon2';
import { type AppConfig } from '../config/config';

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
  /** Performs a comparable amount of work when no user exists, to blunt timing-based account discovery. */
  verifyDummy(plain: string): Promise<void>;
}

/** Argon2id hashing with configurable cost parameters. */
export class Argon2PasswordHasher implements PasswordHasher {
  private readonly options: {
    type: typeof argon2.argon2id;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
  private dummyHash: Promise<string> | null = null;

  constructor(settings: AppConfig['argon2']) {
    this.options = {
      type: argon2.argon2id,
      memoryCost: settings.memoryCost,
      timeCost: settings.timeCost,
      parallelism: settings.parallelism,
    };
  }

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // Malformed hashes are treated as a failed verification.
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, this.options);
    } catch {
      return true;
    }
  }

  async verifyDummy(plain: string): Promise<void> {
    this.dummyHash ??= this.hash('dummy-password-for-timing-equalisation');
    await this.verify(await this.dummyHash, plain);
  }
}
