'use strict';

async function healthRoutes(fastify, { switcher }) {
  fastify.get('/healthz', async () => {
    return { status: 'ok' };
  });

  fastify.get('/readyz', async (request, reply) => {
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
