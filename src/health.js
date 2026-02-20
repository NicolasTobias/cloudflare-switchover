'use strict';

async function healthRoutes(fastify, { switcher }) {
  fastify.get('/healthz', { logLevel: 'silent' }, async () => {
    return { status: 'ok' };
  });

  fastify.get('/readyz', { logLevel: 'silent' }, async (request, reply) => {
    if (!switcher.initialized) {
      reply.code(503);
      return { status: 'not_ready' };
    }
    return { status: 'ready' };
  });

  fastify.get('/status', async () => {
    return switcher.getStatus();
  });
}

module.exports = healthRoutes;
