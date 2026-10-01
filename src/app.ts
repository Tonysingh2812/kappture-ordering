import Fastify, { type FastifyInstance } from 'fastify';
import { createHistoryService } from './application/history-service.ts';
import { createOrderService } from './application/order-service.ts';
import { createPaymentService } from './application/payment-service.ts';
import { createReviewService } from './application/review-service.ts';
import { createWebhookService } from './application/webhook-service.ts';
import type { DataStore } from './application/ports/repositories.ts';
import type { PaymentProvider } from './application/ports/payment-provider.ts';
import type { Clock, IdGenerator, Sleeper } from './application/ports/system.ts';
import type { RetryPolicy } from './application/retry.ts';
import { registerErrorHandler } from './http/errors.ts';
import { registerHistoryRoutes } from './http/history-routes.ts';
import { registerOrderRoutes } from './http/order-routes.ts';
import { registerPaymentRoutes } from './http/payment-routes.ts';
import { registerReviewRoutes } from './http/review-routes.ts';
import { registerWebhookRoutes } from './http/webhook-routes.ts';
import { createHmacSignatureVerifier } from './infrastructure/hmac-signature.ts';

export interface AppDeps {
  dataStore: DataStore;
  clock: Clock;
  idGenerator: IdGenerator;
  paymentProvider: PaymentProvider;
  sleeper: Sleeper;
  random?: () => number;
  retryPolicy?: RetryPolicy;
  /** Shared secret for verifying payment provider webhook signatures. */
  webhookSecret: string;
  shouldLog?: boolean;
}

/** Composition root: builds the services and wires them to routes. Never binds a port, so tests use `app.inject`. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.shouldLog ?? false });
  registerErrorHandler(app);

  const orderService = createOrderService(deps);
  const paymentService = createPaymentService(deps);
  const reviewService = createReviewService(deps);
  const historyService = createHistoryService(deps);
  const webhookService = createWebhookService({
    dataStore: deps.dataStore,
    clock: deps.clock,
    signatureVerifier: createHmacSignatureVerifier(deps.webhookSecret),
  });

  app.get('/health', async () => ({ status: 'ok' }));
  registerOrderRoutes(app, orderService);
  registerPaymentRoutes(app, paymentService);
  registerWebhookRoutes(app, webhookService);
  registerReviewRoutes(app, reviewService);
  registerHistoryRoutes(app, historyService, orderService);

  return app;
}
