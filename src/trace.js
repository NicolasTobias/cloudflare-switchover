'use strict';

/**
 * Parse Cloudflare trace response (key=value\n format) into an object.
 */
function parseTrace(text) {
  const data = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      data[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return data;
}

/**
 * Check Cloudflare availability via /cdn-cgi/trace endpoint.
 * Returns { available: true, data } on success or { available: false, error } on failure.
 */
async function checkCloudflareTrace(domain, timeout = 10_000) {
  try {
    const res = await fetch(`https://${domain}/cdn-cgi/trace`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      return { available: false, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    const data = parseTrace(text);
    if (!data.fl) {
      return { available: false, error: 'Missing fl field in trace response' };
    }
    return { available: true, data };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

/**
 * Check Cloudflare trace for all domains in parallel.
 * Returns array of { domain, ...traceResult }.
 */
async function checkAllTraces(domains, log) {
  const results = await Promise.all(
    domains.map(async (domain) => {
      const result = await checkCloudflareTrace(domain);
      if (log) {
        if (result.available) {
          log.debug({ domain, colo: result.data.colo }, 'trace_ok');
        } else {
          log.warn({ domain, error: result.error }, 'trace_failed');
        }
      }
      return { domain, ...result };
    })
  );
  return results;
}

module.exports = { checkCloudflareTrace, checkAllTraces, parseTrace };
