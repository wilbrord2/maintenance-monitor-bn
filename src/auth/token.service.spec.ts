import { AppError } from '../common/errors/app-error';
import { Role } from '../common/enums/role.enum';
import { type Clock } from '../common/utils/clock';
import { TokenService } from './token.service';

const settings = {
  accessSecret: 'access-secret-access-secret-access-secret',
  refreshSecret: 'refresh-secret-refresh-secret-refresh-secret',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 86_400,
  issuer: 'mm-test',
  audience: 'mm-clients',
};

const SID = '3f1c7f0e-8a52-4a9b-9d3c-2f7a1b6c5d4e';
const JTI = '6a0e2b9d-1c3f-4e5a-8b7c-9d0e1f2a3b4c';

function fixedClock(initial: Date): Clock & { advance(seconds: number): void } {
  let current = initial;
  return {
    now: () => current,
    advance: (seconds) => {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
}

const accessPayload = {
  sub: 15,
  userId: 15,
  name: 'John Doe',
  role: Role.TECHNICIAN,
  phone: '0780000000',
  sid: SID,
};

function expectAuthError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected an AppError');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    expect((error as AppError).statusCode).toBe(401);
  }
}

describe('TokenService', () => {
  it('signs and verifies an access token with the required claims', () => {
    const clock = fixedClock(new Date());
    const service = new TokenService(settings, clock);
    const signed = service.signAccessToken(accessPayload);

    expect(signed.expiresAt.getTime() - clock.now().getTime()).toBe(900_000);
    expect(service.verifyAccessToken(signed.token)).toEqual({ ...accessPayload, type: 'access' });
  });

  it('signs and verifies a refresh token', () => {
    const service = new TokenService(settings, fixedClock(new Date()));
    const signed = service.signRefreshToken({ sub: 15, sid: SID, jti: JTI });
    expect(service.verifyRefreshToken(signed.token)).toEqual({
      sub: 15,
      sid: SID,
      jti: JTI,
      type: 'refresh',
    });
  });

  it('reports expiry distinctly', () => {
    const clock = fixedClock(new Date());
    const service = new TokenService(settings, clock);
    const signed = service.signAccessToken(accessPayload);
    clock.advance(901);
    expectAuthError(() => service.verifyAccessToken(signed.token), 'TOKEN_EXPIRED');
  });

  it('never accepts a refresh token as an access token or vice versa', () => {
    const service = new TokenService(settings, fixedClock(new Date()));
    const refresh = service.signRefreshToken({ sub: 15, sid: SID, jti: JTI });
    const access = service.signAccessToken(accessPayload);
    expectAuthError(() => service.verifyAccessToken(refresh.token), 'TOKEN_INVALID');
    expectAuthError(() => service.verifyRefreshToken(access.token), 'TOKEN_INVALID');
  });

  it('rejects tokens from another issuer or audience', () => {
    const clock = fixedClock(new Date());
    const other = new TokenService({ ...settings, issuer: 'someone-else' }, clock);
    const service = new TokenService(settings, clock);
    expectAuthError(
      () => service.verifyAccessToken(other.signAccessToken(accessPayload).token),
      'TOKEN_INVALID',
    );
  });

  it('rejects well-signed tokens with an invalid claim shape', () => {
    const service = new TokenService(settings, fixedClock(new Date()));
    const signed = service.signAccessToken({ ...accessPayload, role: 'SUPERUSER' as Role });
    expectAuthError(() => service.verifyAccessToken(signed.token), 'TOKEN_INVALID');
  });
});
