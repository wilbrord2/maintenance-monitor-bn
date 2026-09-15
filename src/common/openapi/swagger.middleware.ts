import { timingSafeEqual } from 'node:crypto';
import { type RequestHandler, Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { type AppConfig } from '../../config/config';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function basicAuth(username: string, password: string): RequestHandler {
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (
        separator > 0 &&
        safeEqual(decoded.slice(0, separator), username) &&
        safeEqual(decoded.slice(separator + 1), password)
      ) {
        next();
        return;
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="API documentation"');
    res.status(401).json({ success: false, message: 'Authentication required', code: 'UNAUTHORIZED' });
  };
}

/** Serves Swagger UI at /api/docs and the raw document at /api/docs/openapi.json. */
export function swaggerRouter(config: AppConfig, document: object): Router {
  const router = Router();
  const { username, password } = config.swagger;
  if (username && password) router.use(basicAuth(username, password));
  router.get('/openapi.json', (_req, res) => {
    res.json(document);
  });
  router.use('/', swaggerUi.serve, swaggerUi.setup(document, { customSiteTitle: 'Maintenance Monitor API' }));
  return router;
}
