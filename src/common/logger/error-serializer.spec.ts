import { QueryFailedError } from 'typeorm';
import { serializeError } from './error-serializer';

describe('serializeError', () => {
  it('drops SQL parameters and query text from database errors', () => {
    const driverError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'UQ_users_email',
      detail: 'Key (email)=(someone@example.test) already exists.',
    });
    const error = new QueryFailedError(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2)',
      ['someone@example.test', '$argon2id$v=19$secret-hash'],
      driverError,
    );

    const serialized = serializeError(error);
    expect(serialized).toMatchObject({
      type: 'QueryFailedError',
      code: '23505',
      constraint: 'UQ_users_email',
    });
    const text = JSON.stringify(serialized);
    expect(text).not.toContain('$argon2id');
    expect(text).not.toContain('someone@example.test');
    expect(text).not.toContain('INSERT INTO');
  });

  it('keeps a bounded stack and nested causes', () => {
    const error = new Error('outer', { cause: new Error('inner') });
    const serialized = serializeError(error);
    expect(serialized.cause).toMatchObject({ type: 'Error', message: 'inner' });
    expect(serialized.stack?.split('\n').length).toBeLessThanOrEqual(15);
  });

  it('handles non-Error throwables', () => {
    expect(serializeError('boom')).toEqual({ type: 'string', message: 'boom' });
    expect(serializeError({ password: 'x' })).toEqual({ type: 'object', message: 'Non-error value thrown' });
  });
});
