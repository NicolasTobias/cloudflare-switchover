'use strict';

const { notify } = require('./notifier');

class Switcher {
  constructor(config, cloudflareClient, logger) {
    this.config = config;
    this.cf = cloudflareClient;
    this.log = logger;
    this.records = [];
    this.footballActive = false;
    this.initialized = false;
    this.lastPoll = null;
    this.lastPollError = null;
    this.consecutiveErrors = 0;
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

      // Take the first record matching this name
      const rec = cfRecords[0];

      // Determine if this record is currently in fallback state
      const isFallback = rec.type === domainRec.fallback_type
        && rec.content === domainRec.fallback_content;

      this.records.push({
        zoneId: domainRec.zone_id,
        recordId: rec.id,
        recordName: rec.name,
        // Current state from CF
        currentType: rec.type,
        currentContent: rec.content,
        currentProxied: rec.proxied,
        // Original state (Cloudflare tunnel / normal)
        originalType: isFallback ? null : rec.type,
        originalContent: isFallback ? null : rec.content,
        originalProxied: isFallback ? null : rec.proxied,
        // Fallback state (direct IP)
        fallbackType: domainRec.fallback_type,
        fallbackContent: domainRec.fallback_content,
      });
    }

    // If any record is currently in fallback, we're in football mode
    const anyFallback = this.records.some(r => r.originalType === null);
    if (anyFallback) {
      this.footballActive = true;
      this.log.warn({
        records: this.records
          .filter(r => r.originalType === null)
          .map(r => r.recordName),
      }, 'init_football_state_detected');
    }

    this.initialized = true;

    this.log.info({
      recordsCount: this.records.length,
      footballActive: this.footballActive,
      records: this.records.map(r =>
        `${r.recordName}: ${r.currentType} → ${r.currentContent} [proxied=${r.currentProxied}]`
      ),
    }, 'switcher_init_completed');
  }

  async onPoll(hayFutbol) {
    this.lastPoll = new Date().toISOString();

    // Stale data — no action
    if (hayFutbol === null) {
      this.log.warn('poll_data_stale_no_action');
      return;
    }

    // Same state — no action
    if (hayFutbol === this.footballActive) {
      this.log.debug({ footballActive: this.footballActive }, 'poll_state_unchanged');
      return;
    }

    if (hayFutbol) {
      // Football detected — switch to fallback (direct IP)
      await this._switchToFallback();
      this.footballActive = true;
      const msg = `FUTBOL DETECTADO\nDNS cambiado a IP directa en ${this.records.length} registro(s):\n${this._recordSummary()}`;
      this.log.info({ recordsCount: this.records.length }, 'football_detected');
      await this._verifyAndNotify(msg);
    } else {
      // Football ended — restore original (Cloudflare tunnel)
      await this._restoreOriginal();
      this.footballActive = false;
      const msg = `FIN DEL FUTBOL\nDNS restaurado a Cloudflare en ${this.records.length} registro(s):\n${this._recordSummary()}`;
      this.log.info({ recordsCount: this.records.length }, 'football_ended');
      await this._verifyAndNotify(msg);
    }
  }

  async _switchToFallback() {
    for (const rec of this.records) {
      try {
        // Save original state before overwriting
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
        // Record ID may change on type change
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
      const start = Date.now();
      try {
        const res = await fetch(`https://${domain}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(10_000),
        });
        results.push({
          domain,
          status: res.status,
          latencyMs: Date.now() - start,
        });
      } catch (err) {
        results.push({
          domain,
          status: 'error',
          error: err.message,
          latencyMs: Date.now() - start,
        });
      }
    }
    return results;
  }

  async _verifyAndNotify(message) {
    const health = await this._verifyHealth();
    const healthSummary = health
      .map(h => `  ${h.domain}: ${h.status} (${h.latencyMs}ms)`)
      .join('\n');

    const fullMsg = `${message}\n\nHealth check:\n${healthSummary}`;
    this.log.info({ health }, 'health_check_completed');
    await notify(this.config, fullMsg, this.log);
  }

  recordPollError(err) {
    this.lastPollError = err.message;
    this.consecutiveErrors++;

    if (this.consecutiveErrors >= 3) {
      this.log.error({
        err,
        consecutiveErrors: this.consecutiveErrors,
      }, 'poll_consecutive_errors');
      return true; // should notify
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

module.exports = { Switcher };
