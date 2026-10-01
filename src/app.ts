import Fastify, { type FastifyInstance } from 'fastify';
import { createOrderService } from './application/order-service.ts';
import { createPaymentService } from './application/payment-service.ts';
import type { DataStore } from './application/ports/repositories.ts';
import type { PaymentProvider } from './application/ports/payment-provider.ts';
import type { Clock, IdGenerator, Sleeper } from './application/ports/system.ts';
import type { RetryPolicy } from './application/retry.ts';
import { registerErrorHandler } from './http/errors.ts';
import { registerOrderRoutes } from './http/order-routes.ts';
import { registerPaymentRoutes } from './http/payment-routes.ts';

export interface AppDeps {
  dataStore: DataStore;
  clock: Clock;
  idGenerator: IdGenerator;
  paymentProvider: PaymentProvider;
  sleeper: Sleeper;
  random?: () => number;
  retryPolicy?: RetryPolicy;
  shouldLog?: boolean;
}

/** Composition root: builds the services and wires them to routes. Never binds a port, so tests use `app.inject`. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.shouldLog ?? false });
  registerErrorHandler(app);

  const orderService = createOrderService(deps);
  const paymentService = createPaymentService(deps);

  app.get('/health', async () => ({ status: 'ok' }));
  registerOrderRoutes(app, orderService);
  registerPaymentRoutes(app, paymentService);

  return app;
}
