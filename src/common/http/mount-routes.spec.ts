import { ok } from './response';
import { orderRoutesForMatching } from './mount-routes';
import { publicRoute } from './route';

const route = (path: string) =>
  publicRoute({
    method: 'get',
    path,
    tags: [],
    summary: path,
    response: { status: 200, description: '' },
    handler: () => Promise.resolve(ok('')),
  });

describe('orderRoutesForMatching', () => {
  it('places static segments before parameters, keeping declaration order otherwise', () => {
    const ordered = orderRoutesForMatching([
      route('/machines/:id'),
      route('/machines'),
      route('/machines/:id/logs'),
      route('/machines/state-transitions'),
      route('/users/:id'),
      route('/users/me'),
    ]).map((r) => r.spec.path);

    expect(ordered.indexOf('/machines/state-transitions')).toBeLessThan(ordered.indexOf('/machines/:id'));
    expect(ordered.indexOf('/users/me')).toBeLessThan(ordered.indexOf('/users/:id'));
    expect(ordered.indexOf('/machines/:id')).toBeLessThan(ordered.indexOf('/machines/:id/logs'));
  });
});
