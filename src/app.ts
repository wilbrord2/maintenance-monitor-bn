import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { mountRoutes } from './common/http/mount-routes';
import { errorHandlerMiddleware, notFoundMiddleware } from './common/middleware/error-handler.middleware';
import { httpLoggerMiddleware } from './common/middleware/http-logger.middleware';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import {
  corsMiddleware,
  helmetMiddleware,
  noStoreMiddleware,
  requireJsonBodyMiddleware,
} from './common/middleware/security.middleware';
import { API_PREFIX, buildOpenApiDocument } from './common/openapi/openapi';
import { swaggerRouter } from './common/openapi/swagger.middleware';
import { type Container } from './container';

export function createApp(container: Container): Express {
  const { config, logger } = container;
  const app = express();

  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple');
  app.disable('x-powered-by');

  app.use(requestIdMiddleware);
  app.use(httpLoggerMiddleware(logger));
  app.use(helmetMiddleware());
  app.use(corsMiddleware(config));
  app.use(container.rateLimiters.global);
  app.use(requireJsonBodyMiddleware);
  app.use(express.json({ limit: config.bodySizeLimit, strict: true }));
  app.use(cookieParser());

  if (config.swagger.enabled) {
    const document = buildOpenApiDocument(container.routes, { version: container.version });
    app.use('/api/docs', swaggerRouter(config, document));
  }

  app.use(
    API_PREFIX,
    noStoreMiddleware,
    mountRoutes(container.routes, { authenticate: container.authenticate }),
  );

  app.use(notFoundMiddleware);
  app.use(errorHandlerMiddleware(logger));

  return app;
}
