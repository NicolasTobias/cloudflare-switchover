'use strict';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

class CloudflareClient {
  constructor(apiToken, logger) {
    this.apiToken = apiToken;
    this.log = logger;
  }

  async _request(method, path, body = null, retries = MAX_RETRIES) {
    const url = `${CF_API_BASE}${path}`;
    const headers = {
      'Authorization': `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const opts = { method, headers };
        if (body) opts.body = JSON.stringify(body);

        const res = await fetch(url, opts);
        const data = await res.json();

        if (!res.ok) {
          const errMsg = data.errors?.map(e => e.message).join(', ') || res.statusText;
          throw new Error(`CF API ${method} ${path}: ${res.status} - ${errMsg}`);
        }

        return data;
      } catch (err) {
        if (attempt === retries) throw err;

        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        this.log.warn({
          err,
          attempt,
          maxRetries: retries,
          backoffMs: backoff,
          path,
        }, 'cloudflare_api_retry');
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }

  async listRecords(zoneId, name) {
    const params = new URLSearchParams({ name });
    const data = await this._request('GET', `/zones/${zoneId}/dns_records?${params}`);
    return data.result || [];
  }

  async updateRecord(zoneId, recordId, { type, name, content, proxied }) {
    return this._request('PUT', `/zones/${zoneId}/dns_records/${recordId}`, {
      type, name, content, proxied,
    });
  }
}

module.exports = { CloudflareClient };
