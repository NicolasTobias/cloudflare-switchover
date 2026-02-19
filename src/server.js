'use strict';

const pino = require('pino');
const Fastify = require('fastify');
const { loadConfig } = require('./config');
const { CloudflareClient } = require('./cloudflare');
const { Switcher } = require('./switcher');
const { fetchHayaHora, evaluateFootball } = require('./poller');
const { notify } = require('./notifier');
const healthRoutes = require('./health');

async function main() {
  const log = pino({ level: process.env.LOG_LEVEL || 'info' });

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.fatal({ err }, 'config_load_failed');
    process.exit(1);
  }

  const fastify = Fastify({ logger: log });
  const cf = new CloudflareClient(config.cloudflareApiToken, log);
  const switcher = new Switcher(config, cf, log);

  await fastify.register(healthRoutes, { switcher });

  // Init — read current DNS state from Cloudflare
  try {
    await switcher.init();
  } catch (err) {
    log.fatal({ err }, 'switcher_init_failed');
    process.exit(1);
  }

  // Start HTTP server
  await fastify.listen({ port: config.healthCheckPort, host: '0.0.0.0' });

  // Startup notification
  await notify(
    config,
    `Cloudflare Switchover iniciado\nRegistros: ${switcher.records.length}\nEstado actual: ${switcher.footballActive ? 'FUTBOL ACTIVO (proxy off)' : 'Normal (proxy on)'}`,
    log
  );

  // Poll function
  async function poll() {
    log.info('poll_started');
    try {
      const data = await fetchHayaHora(config.hayahoraUrl);
      const hayFutbol = evaluateFootball(data, config.footballThreshold);

      if (hayFutbol === null) {
        log.warn('hayahora_data_stale');
      }

      await switcher.onPoll(hayFutbol);
      switcher.clearPollError();
    } catch (err) {
      log.error({ err }, 'poll_failed');
      const shouldNotify = switcher.recordPollError(err);
      if (shouldNotify) {
        await notify(
          config,
          `ALERTA: ${switcher.consecutiveErrors} errores consecutivos en polling\nUltimo error: ${err.message}`,
          log
        );
      }
    }
  }

  // Run first poll immediately
  await poll();

  // Schedule recurring polls
  const pollInterval = setInterval(poll, config.pollInterval);

  // Graceful shutdown
  async function shutdown(signal) {
    log.info({ signal }, 'shutdown_started');
    clearInterval(pollInterval);

    if (switcher.footballActive) {
      log.warn('shutdown_while_football_active');
    }

    try {
      await fastify.close();
    } catch (err) {
      log.error({ err }, 'fastify_close_failed');
    }

    log.info('shutdown_completed');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
