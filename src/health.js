'use strict';

const { renderDashboard } = require('./dashboard');

async function healthRoutes(fastify, { switcher }) {
  fastify.get('/', async (request, reply) => {
    reply.type('text/html').send(renderDashboard());
  });

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
    return {
      ...switcher.getStatus(),
      forceFootball: process.env.FORCE_FOOTBALL || null,
    };
  });

  fastify.get('/api/events', async () => {
    return switcher.getEventLog();
  });

  // Test endpoints — force football state for manual testing
  fastify.post('/test/force-football', async (request) => {
    const enabled = request.body?.enabled;
    if (enabled === true || enabled === 'true') {
      process.env.FORCE_FOOTBALL = 'true';
      switcher.addEvent('force_override', { message: 'Force football ON' });
    } else if (enabled === false || enabled === 'false') {
      process.env.FORCE_FOOTBALL = 'false';
      switcher.addEvent('force_override', { message: 'Force football OFF' });
    } else {
      delete process.env.FORCE_FOOTBALL;
      switcher.addEvent('force_override', { message: 'Force cleared' });
    }
    // Trigger immediate poll
    await switcher.onPoll(process.env.FORCE_FOOTBALL === 'true');
    return { forceFootball: process.env.FORCE_FOOTBALL || null, state: switcher.state };
  });

  fastify.delete('/test/force-football', async () => {
    delete process.env.FORCE_FOOTBALL;
    switcher.addEvent('force_override', { message: 'Force cleared (auto)' });
    return { forceFootball: null, state: switcher.state };
  });
}

module.exports = healthRoutes;
