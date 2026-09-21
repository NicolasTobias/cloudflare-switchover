'use strict';

const { notify } = require('./notifier');
const { checkAllTraces } = require('./trace');
const { fetchPinned } = require('./httpcheck');
const { originDomainFor } = require('./domain');

const STATES = {
  NORMAL: 'normal',
  WATCHING: 'watching',
  FALLBACK: 'fallback',
  RESTORING: 'restoring',
};

const MAX_EVENT_LOG = 200;

class Switcher {
  constructor(config, cloudflareClient, logger) {
    this.config = config;
    this.cf = cloudflareClient;
    this.log = logger;
    this.records = [];
    this.state = STATES.NORMAL;
    this.initialized = false;
    this.lastPoll = null;
    this.lastPollError = null;
    this.consecutiveErrors = 0;
    this.eventLog = [];
    this.startedAt = new Date().toISOString();
    // Inyectable para tests; pinea la conexión a la IP del fallback (VPS).
    this._fetchPinned = fetchPinned;
  }

  addEvent(type, detail = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      ...detail,
    };
    this.eventLog.unshift(entry);
    if (this.eventLog.length > MAX_EVENT_LOG) {
      this.eventLog.length = MAX_EVENT_LOG;
    }
  }

  getEventLog() {
    return this.eventLog;
  }

  async forceSwitch(toFallback) {
    const prevState = this.state;

    if (toFallback) {
      if (this.state === STATES.FALLBACK) return;
      await this._switchToFallback();
      this.state = STATES.FALLBACK;
      this.addEvent('force_override', { from: prevState, to: STATES.FALLBACK, message: 'Forced switch to fallback' });
      const msg = `🔧 FORCE ON — DNS cambiado a IP directa en ${this.records.length} registro(s):\n${this._recordSummary()}`;
      this.log.info({ from: prevState, to: STATES.FALLBACK }, 'force_switch_to_fallback');
      await this._verifyAndNotify(msg);
    } else {
      if (this.state === STATES.NORMAL) return;
      await this._restoreOriginal();
      this.state = STATES.NORMAL;
      this.addEvent('force_override', { from: prevState, to: STATES.NORMAL, message: 'Forced restore to Cloudflare' });
      const msg = `🔧 FORCE OFF — DNS restaurado a Cloudflare en ${this.records.length} registro(s):\n${this._recordSummary()}`;
      this.log.info({ from: prevState, to: STATES.NORMAL }, 'force_switch_to_normal');
      await this._verifyAndNotify(msg);
    }
  }

  /** Backwards-compatible getter */
  get footballActive() {
    return this.state === STATES.FALLBACK || this.state === STATES.RESTORING;
  }

  async init() {
    this.log.info('switcher_init_started');
    this.records = [];

    for (const domainRec of this.config.domainRecords) {
      const cfRecords = await this.cf.listRecords(
        domainRec.zone_id,
        domainRec.record_name
      );

      if (cfRecords.length === 0) {
        throw new Error(
          `No DNS record found for ${domainRec.record_name} in zone ${domainRec.zone_id}`
        );
      }

      const rec = cfRecords[0];
      const isFallback = rec.type === domainRec.fallback_type
        && rec.content === domainRec.fallback_content;

      this.records.push({
        zoneId: domainRec.zone_id,
        recordId: rec.id,
        recordName: rec.name,
        currentType: rec.type,
        currentContent: rec.content,
        currentProxied: rec.proxied,
        originalType: isFallback ? null : rec.type,
        originalContent: isFallback ? null : rec.content,
        originalProxied: isFallback ? null : rec.proxied,
        fallbackType: domainRec.fallback_type,
        fallbackContent: domainRec.fallback_content,
        healthCheckString: domainRec.health_check_string || null,
        originDomain: originDomainFor(domainRec.record_name, domainRec.origin_domain),
      });
    }

    // If any record is currently in fallback, start in fallback state
    const anyFallback = this.records.some(r => r.originalType === null);
    if (anyFallback) {
      this.state = STATES.FALLBACK;
      this.addEvent('state_change', { from: STATES.NORMAL, to: STATES.FALLBACK, message: 'Init detected fallback state' });
      this.log.warn({
        records: this.records
          .filter(r => r.originalType === null)
          .map(r => r.recordName),
      }, 'init_football_state_detected');
    }

    this.initialized = true;

    this.log.info({
      recordsCount: this.records.length,
      state: this.state,
      footballActive: this.footballActive,
      records: this.records.map(r =>
        `${r.recordName}: ${r.currentType} → ${r.currentContent} [proxied=${r.currentProxied}]`
      ),
    }, 'switcher_init_completed');
  }

  async onPoll(hayFutbol) {
    this.lastPoll = new Date().toISOString();

    if (hayFutbol === null) {
      this.log.warn('poll_data_stale_no_action');
      return;
    }

    switch (this.state) {
      case STATES.NORMAL:
        await this._onNormal(hayFutbol);
        break;
      case STATES.WATCHING:
        await this._onWatching(hayFutbol);
        break;
      case STATES.FALLBACK:
        await this._onFallback(hayFutbol);
        break;
      case STATES.RESTORING:
        await this._onRestoring(hayFutbol);
        break;
    }
  }

  async _onNormal(hayFutbol) {
    if (!hayFutbol) {
      this.log.debug({ state: this.state }, 'poll_state_unchanged');
      return;
    }

    // Football detected — check if CF is actually blocked
    this.log.info('football_detected_checking_traces');
    this.addEvent('state_change', { from: STATES.NORMAL, to: STATES.WATCHING, message: 'Football detected, checking traces' });
    this.state = STATES.WATCHING;

    const domains = this.records.map(r => r.recordName);
    const traces = await checkAllTraces(domains, this.log);
    const allOk = traces.every(t => t.available);

    if (allOk) {
      this.log.info({ traces: traces.map(t => ({ domain: t.domain, colo: t.data?.colo })) },
        'cf_still_accessible_staying_in_watching');
    } else {
      // CF is blocked — switch immediately
      await this._transitionToFallback(traces);
    }
  }

  async _onWatching(hayFutbol) {
    if (!hayFutbol) {
      // Football ended before CF got blocked
      this.log.info('football_ended_before_block_returning_to_normal');
      this.addEvent('state_change', { from: STATES.WATCHING, to: STATES.NORMAL, message: 'Football ended before block' });
      this.state = STATES.NORMAL;
      return;
    }

    // Still football — re-check traces
    const domains = this.records.map(r => r.recordName);
    const traces = await checkAllTraces(domains, this.log);
    const allOk = traces.every(t => t.available);

    if (allOk) {
      this.log.info({ traces: traces.map(t => ({ domain: t.domain, colo: t.data?.colo })) },
        'cf_still_accessible_staying_in_watching');
    } else {
      await this._transitionToFallback(traces);
    }
  }

  async _onFallback(hayFutbol) {
    if (hayFutbol) {
      this.log.debug({ state: this.state }, 'poll_state_unchanged');
      return;
    }

    // Football ended — start verifying CF is accessible via origin domains
    this.log.info('football_ended_checking_origin_traces');
    this.addEvent('state_change', { from: STATES.FALLBACK, to: STATES.RESTORING, message: 'Football ended, checking origin traces' });
    this.state = STATES.RESTORING;

    await this._attemptRestore();
  }

  async _onRestoring(hayFutbol) {
    if (hayFutbol) {
      // Football resumed — go back to fallback
      this.log.warn('football_resumed_staying_in_fallback');
      this.addEvent('state_change', { from: STATES.RESTORING, to: STATES.FALLBACK, message: 'Football resumed during restore' });
      this.state = STATES.FALLBACK;
      return;
    }

    // Keep trying to restore
    await this._attemptRestore();
  }

  async _transitionToFallback(traces) {
    const prevState = this.state;
    await this._switchToFallback();
    this.state = STATES.FALLBACK;
    this.addEvent('state_change', { from: prevState, to: STATES.FALLBACK, message: 'CF blocked — switched to fallback DNS' });

    const traceSummary = traces
      .map(t => `  ${t.domain}: ${t.available ? 'OK' : t.error}`)
      .join('\n');
    const msg = `⚽ FUTBOL DETECTADO — CF BLOQUEADO\nDNS cambiado a IP directa en ${this.records.length} registro(s):\n${this._recordSummary()}\n\nTrace check:\n${traceSummary}`;
    this.log.info({ recordsCount: this.records.length }, 'football_detected_switched_to_fallback');
    await this._verifyAndNotify(msg);
  }

  async _attemptRestore() {
    // Check origin.{domain} — these always go through CF/Argo Tunnel
    const originDomains = this._originDomains();
    const traces = await checkAllTraces(originDomains, this.log);
    const allOk = traces.every(t => t.available);

    if (!allOk) {
      this.log.warn({ traces: traces.map(t => ({ domain: t.domain, error: t.error })) },
        'origin_traces_still_failing_staying_in_restoring');
      return;
    }

    // Origin is accessible — fetch HTML title from origin for notification
    const originInfo = await this._fetchOriginInfo();

    // Restore DNS
    await this._restoreOriginal();
    this.state = STATES.NORMAL;
    this.addEvent('state_change', { from: STATES.RESTORING, to: STATES.NORMAL, message: 'CF restored — DNS back to Cloudflare' });

    const traceSummary = traces
      .map(t => `  ${t.domain}: colo=${t.data?.colo}, fl=${t.data?.fl}`)
      .join('\n');
    const originSummary = originInfo
      .map(o => `  ${o.domain}: ${o.title || 'no title'} (${o.status})`)
      .join('\n');
    const msg = `✅ CF RESTAURADO\nDNS restaurado a Cloudflare en ${this.records.length} registro(s):\n${this._recordSummary()}\n\nOrigin trace:\n${traceSummary}\n\nOrigin HTML:\n${originSummary}`;
    this.log.info({ recordsCount: this.records.length }, 'cf_restored');
    await this._verifyAndNotify(msg);
  }

  /** Sondas origin.* únicas: varios registros de la misma zona comparten una. */
  _originDomains() {
    return [...new Set(this.records.map(r => r.originDomain))];
  }

  async _fetchOriginInfo() {
    const results = [];
    for (const originDomain of this._originDomains()) {
      try {
        const res = await fetch(`https://${originDomain}`, {
          signal: AbortSignal.timeout(10_000),
        });
        const html = await res.text();
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        results.push({
          domain: originDomain,
          status: res.status,
          title: titleMatch ? titleMatch[1] : null,
        });
      } catch (err) {
        results.push({
          domain: originDomain,
          status: 'error',
          title: null,
          error: err.message,
        });
      }
    }
    return results;
  }

  async _switchToFallback() {
    for (const rec of this.records) {
      try {
        rec.originalType = rec.currentType;
        rec.originalContent = rec.currentContent;
        rec.originalProxied = rec.currentProxied;

        const result = await this.cf.updateRecord(rec.zoneId, rec.recordId, {
          type: rec.fallbackType,
          name: rec.recordName,
          content: rec.fallbackContent,
          proxied: false,
        });

        rec.currentType = rec.fallbackType;
        rec.currentContent = rec.fallbackContent;
        rec.currentProxied = false;
        if (result.result?.id) rec.recordId = result.result.id;

        this.log.info({
          recordName: rec.recordName,
          from: `${rec.originalType} → ${rec.originalContent}`,
          to: `${rec.currentType} → ${rec.currentContent}`,
        }, 'dns_record_switched_to_fallback');
      } catch (err) {
        this.log.error({
          err,
          recordName: rec.recordName,
        }, 'dns_record_switch_failed');
        throw err;
      }
    }
  }

  async _restoreOriginal() {
    for (const rec of this.records) {
      if (!rec.originalType || !rec.originalContent) {
        this.log.warn({ recordName: rec.recordName }, 'no_original_state_to_restore');
        continue;
      }

      try {
        const result = await this.cf.updateRecord(rec.zoneId, rec.recordId, {
          type: rec.originalType,
          name: rec.recordName,
          content: rec.originalContent,
          proxied: rec.originalProxied,
        });

        rec.currentType = rec.originalType;
        rec.currentContent = rec.originalContent;
        rec.currentProxied = rec.originalProxied;
        if (result.result?.id) rec.recordId = result.result.id;

        this.log.info({
          recordName: rec.recordName,
          restored: `${rec.currentType} → ${rec.currentContent} [proxied=${rec.currentProxied}]`,
        }, 'dns_record_restored');
      } catch (err) {
        this.log.error({
          err,
          recordName: rec.recordName,
        }, 'dns_record_restore_failed');
        throw err;
      }
    }
  }

  async _verifyHealth() {
    const results = [];
    for (const rec of this.records) {
      const domain = rec.recordName;
      // ¿El registro apunta ahora al fallback (VPS)? Entonces NO podemos fiarnos
      // del DNS (todavía cacheado en el edge de CF, bloqueado): pineamos a la IP
      // del VPS para verificar el camino real (VPS → Anubis → backend).
      const inFallback = rec.currentProxied === false
        && rec.currentContent === rec.fallbackContent;
      const start = Date.now();
      try {
        let status;
        let body;
        if (inFallback) {
          ({ status, body } = await this._fetchPinned(domain, rec.fallbackContent, {
            timeoutMs: 10_000,
          }));
        } else {
          const res = await fetch(`https://${domain}`, {
            signal: AbortSignal.timeout(10_000),
          });
          status = res.status;
          body = await res.text();
        }
        const contentOk = rec.healthCheckString
          ? body.includes(rec.healthCheckString)
          : null;
        results.push({
          domain,
          status,
          latencyMs: Date.now() - start,
          contentOk,
          via: inFallback ? 'fallback-ip' : 'dns',
        });
      } catch (err) {
        results.push({
          domain,
          status: 'error',
          error: err.message,
          latencyMs: Date.now() - start,
          contentOk: false,
          via: inFallback ? 'fallback-ip' : 'dns',
        });
      }
    }
    return results;
  }

  async _verifyAndNotify(message) {
    const health = await this._verifyHealth();
    const healthSummary = health
      .map(h => {
        const contentInfo = h.contentOk !== null ? ` content=${h.contentOk ? 'OK' : 'FAIL'}` : '';
        const viaInfo = h.via ? ` via=${h.via}` : '';
        return `  ${h.domain}: ${h.status} (${h.latencyMs}ms)${contentInfo}${viaInfo}`;
      })
      .join('\n');

    const fullMsg = `${message}\n\nHealth check:\n${healthSummary}`;
    this.log.info({ health }, 'health_check_completed');
    this.addEvent('notification', { message: message.split('\n')[0] });
    await notify(this.config, fullMsg, this.log);
  }

  recordPollError(err) {
    this.lastPollError = err.message;
    this.consecutiveErrors++;
    this.addEvent('poll_error', { message: err.message, consecutiveErrors: this.consecutiveErrors });

    if (this.consecutiveErrors >= 3) {
      this.log.error({
        err,
        consecutiveErrors: this.consecutiveErrors,
      }, 'poll_consecutive_errors');
      return true;
    }
    return false;
  }

  clearPollError() {
    this.consecutiveErrors = 0;
    this.lastPollError = null;
  }

  _recordSummary() {
    return this.records
      .map(r => `  ${r.recordName}: ${r.currentType} → ${r.currentContent} [proxied=${r.currentProxied}]`)
      .join('\n');
  }

  getStatus() {
    return {
      state: this.state,
      footballActive: this.footballActive,
      recordsCount: this.records.length,
      records: this.records.map(r => ({
        name: r.recordName,
        currentType: r.currentType,
        currentContent: r.currentContent,
        proxied: r.currentProxied,
        originalType: r.originalType,
        originalContent: r.originalContent,
      })),
      lastPoll: this.lastPoll,
      lastPollError: this.lastPollError,
      consecutiveErrors: this.consecutiveErrors,
      uptime: process.uptime(),
    };
  }
}

module.exports = { Switcher, STATES };
