import Fastify, { type FastifyInstance } from 'fastify';
import { createOrderService } from './application/order-service.ts';
import type { DataStore } from './application/ports/repositories.ts';
import type { Clock, IdGenerator } from './application/ports/system.ts';
import { registerErrorHandler } from './http/errors.ts';
import { registerOrderRoutes } from './http/order-routes.ts';

export interface AppDeps {
  dataStore: DataStore;
  clock: Clock;
  idGenerator: IdGenerator;
  shouldLog?: boolean;
}

/** Composition root: builds the services and wires them to routes. Never binds a port, so tests use `app.inject`. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.shouldLog ?? false });
  registerErrorHandler(app);

  const orderService = createOrderService(deps);

  app.get('/health', async () => ({ status: 'ok' }));
  registerOrderRoutes(app, orderService);

  return app;
}
