'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { checkCloudflareTrace, checkAllTraces, parseTrace } = require('../src/trace');

const mockLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe('parseTrace', () => {
  it('parses key=value format', () => {
    const text = 'fl=123f456\nh=tardigram.com\ncolo=MAD\nip=1.2.3.4\n';
    const data = parseTrace(text);
    assert.equal(data.fl, '123f456');
    assert.equal(data.h, 'tardigram.com');
    assert.equal(data.colo, 'MAD');
    assert.equal(data.ip, '1.2.3.4');
  });

  it('handles empty lines gracefully', () => {
    const text = 'fl=abc\n\ncolo=MAD\n';
    const data = parseTrace(text);
    assert.equal(data.fl, 'abc');
    assert.equal(data.colo, 'MAD');
  });

  it('handles values containing =', () => {
    const text = 'key=val=ue\n';
    const data = parseTrace(text);
    assert.equal(data.key, 'val=ue');
  });
});

describe('checkCloudflareTrace', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns available=true when trace responds correctly', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => 'fl=123f456\nh=tardigram.com\ncolo=MAD\n',
    });

    const result = await checkCloudflareTrace('tardigram.com');
    assert.equal(result.available, true);
    assert.equal(result.data.fl, '123f456');
    assert.equal(result.data.colo, 'MAD');
  });

  it('returns available=false on HTTP error', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
    });

    const result = await checkCloudflareTrace('tardigram.com');
    assert.equal(result.available, false);
    assert.equal(result.error, 'HTTP 403');
  });

  it('returns available=false on network error', async () => {
    globalThis.fetch = async () => { throw new Error('Connection refused'); };

    const result = await checkCloudflareTrace('tardigram.com');
    assert.equal(result.available, false);
    assert.equal(result.error, 'Connection refused');
  });

  it('returns available=false when fl field is missing', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => 'h=tardigram.com\ncolo=MAD\n',
    });

    const result = await checkCloudflareTrace('tardigram.com');
    assert.equal(result.available, false);
    assert.match(result.error, /Missing fl field/);
  });
});

describe('checkAllTraces', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('checks all domains in parallel', async () => {
    const fetchedUrls = [];
    globalThis.fetch = async (url) => {
      fetchedUrls.push(url);
      return {
        ok: true,
        text: async () => 'fl=abc\ncolo=MAD\n',
      };
    };

    const results = await checkAllTraces(['a.com', 'b.com'], mockLog);
    assert.equal(results.length, 2);
    assert.equal(results[0].domain, 'a.com');
    assert.equal(results[0].available, true);
    assert.equal(results[1].domain, 'b.com');
    assert.equal(results[1].available, true);
    assert.ok(fetchedUrls.includes('https://a.com/cdn-cgi/trace'));
    assert.ok(fetchedUrls.includes('https://b.com/cdn-cgi/trace'));
  });

  it('returns mixed results when some fail', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, text: async () => 'fl=abc\ncolo=MAD\n' };
      }
      throw new Error('timeout');
    };

    const results = await checkAllTraces(['ok.com', 'fail.com'], mockLog);
    assert.equal(results[0].available, true);
    assert.equal(results[1].available, false);
  });
});
