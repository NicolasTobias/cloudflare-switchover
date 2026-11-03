'use strict';

const dns = require('node:dns').promises;
const pino = require('pino');
const Fastify = require('fastify');
const { loadConfig } = require('./config');
const { CloudflareClient } = require('./cloudflare');
const { Switcher } = require('./switcher');
const { fetchHayaHora, evaluateFootball, homeIspBlocks } = require('./poller');
const { notify } = require('./notifier');
const healthRoutes = require('./health');
// La imagen se construye del commit ANTES de que semantic-release suba la
// versión en package.json, así que el build inyecta APP_VERSION (la versión que
// semantic-release publicará, calculada con --dry-run). Fallback a package.json.
const version = process.env.APP_VERSION || require('../package.json').version;

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
    `Cloudflare Switchover v${version}\nRegistros: ${switcher.records.length}\nEstado: ${switcher.state}\nFootball active: ${switcher.footballActive}`,
    log
  );

  // IPs de Cloudflare a las que han resuelto nuestros dominios en las ultimas
  // 48 h. Se acumulan porque Cloudflare alterna juegos de IPs y, en fallback,
  // el DNS apunta al VPS y ya no las veriamos.
  const seenIps = new Map();
  const SEEN_IPS_TTL_MS = 48 * 60 * 60 * 1000;
  const fallbackIps = new Set(config.domainRecords.map(r => r.fallback_content));

  async function currentCloudflareIps() {
    const now = Date.now();
    await Promise.all(switcher.records.map(async r => {
      try {
        for (const ip of await dns.resolve4(r.recordName)) {
          if (!fallbackIps.has(ip)) seenIps.set(ip, now);
        }
      } catch (err) {
        log.debug({ err, domain: r.recordName }, 'resolve_failed');
      }
    }));
    for (const [ip, ts] of seenIps) {
      if (now - ts > SEEN_IPS_TTL_MS) seenIps.delete(ip);
    }
    return new Set(seenIps.keys());
  }

  // Poll function
  async function poll() {
    log.info('poll_started');
    try {
      let hayFutbol;
      if (process.env.FORCE_FOOTBALL) {
        hayFutbol = process.env.FORCE_FOOTBALL === 'true';
        log.warn({ forced: hayFutbol }, 'force_football_override');
      } else {
        const data = await fetchHayaHora(config.hayahoraUrl);
        const home = { isp: config.homeIsp, ips: config.homeIsp ? await currentCloudflareIps() : null };
        hayFutbol = evaluateFootball(data, config.footballThreshold, home);
        if (hayFutbol && home.isp && homeIspBlocks(data.data || [], home.isp, home.ips)) {
          log.warn({ isp: home.isp }, 'home_isp_blocking_our_ips');
        }

        if (hayFutbol === null) {
          log.warn('hayahora_data_stale');
        }
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
