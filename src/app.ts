import Fastify, { type FastifyInstance } from 'fastify';

export interface AppOptions {
  logger?: boolean;
}

/**
 * Builds the Fastify app without binding a port, so tests can drive it via `app.inject`.
 * Dependencies (database, payment provider, clock) will be injected here as tickets land.
 */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
