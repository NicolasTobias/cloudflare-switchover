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

  // Test endpoints — force football state for manual testing
  fastify.post('/test/force-football', async (request) => {
    const enabled = request.body?.enabled;
    if (enabled === true || enabled === 'true') {
      process.env.FORCE_FOOTBALL = 'true';
    } else if (enabled === false || enabled === 'false') {
      process.env.FORCE_FOOTBALL = 'false';
    } else {
      delete process.env.FORCE_FOOTBALL;
    }
    // Trigger immediate poll
    await switcher.onPoll(process.env.FORCE_FOOTBALL === 'true');
    return { forceFootball: process.env.FORCE_FOOTBALL || null, state: switcher.state };
  });

  fastify.delete('/test/force-football', async () => {
    delete process.env.FORCE_FOOTBALL;
    return { forceFootball: null, state: switcher.state };
  });
}

module.exports = healthRoutes;
