'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { CloudflareClient } = require('../src/cloudflare');

const mockLog = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
};

describe('CloudflareClient', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('listRecords', () => {
    it('returns records from CF API response', async () => {
      const mockRecords = [
        { id: 'rec1', name: 'example.com', type: 'CNAME', proxied: true, content: 'tunnel.cfargotunnel.com' },
      ];
      globalThis.fetch = async (url) => {
        assert.ok(url.includes('/zones/zone123/dns_records'));
        assert.ok(url.includes('name=example.com'));
        return {
          ok: true,
          json: async () => ({ success: true, result: mockRecords }),
        };
      };

      const client = new CloudflareClient('test-token', mockLog);
      const records = await client.listRecords('zone123', 'example.com');
      assert.deepEqual(records, mockRecords);
    });

    it('sends correct auth header', async () => {
      globalThis.fetch = async (url, opts) => {
        assert.equal(opts.headers['Authorization'], 'Bearer my-token');
        return {
          ok: true,
          json: async () => ({ success: true, result: [] }),
        };
      };

      const client = new CloudflareClient('my-token', mockLog);
      await client.listRecords('z', 'n');
    });

    it('returns empty array when no result field', async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ success: true }),
      });

      const client = new CloudflareClient('token', mockLog);
      const records = await client.listRecords('z', 'n');
      assert.deepEqual(records, []);
    });
  });

  describe('updateRecord', () => {
    it('sends PUT with full record data', async () => {
      globalThis.fetch = async (url, opts) => {
        assert.ok(url.includes('/zones/zone1/dns_records/rec1'));
        assert.equal(opts.method, 'PUT');
        const body = JSON.parse(opts.body);
        assert.equal(body.type, 'A');
        assert.equal(body.name, 'example.com');
        assert.equal(body.content, '5.161.1.1');
        assert.equal(body.proxied, false);
        return {
          ok: true,
          json: async () => ({ success: true, result: { id: 'rec1', type: 'A', content: '5.161.1.1', proxied: false } }),
        };
      };

      const client = new CloudflareClient('token', mockLog);
      const result = await client.updateRecord('zone1', 'rec1', {
        type: 'A',
        name: 'example.com',
        content: '5.161.1.1',
        proxied: false,
      });
      assert.equal(result.result.type, 'A');
      assert.equal(result.result.proxied, false);
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response after retries', async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({ errors: [{ message: 'server error' }] }),
        };
      };

      const client = new CloudflareClient('token', mockLog);
      await assert.rejects(
        () => client.listRecords('z', 'n'),
        /CF API GET.*500.*server error/
      );
      assert.equal(attempts, 3);
    });

    it('retries on fetch errors', async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 3) throw new Error('network error');
        return {
          ok: true,
          json: async () => ({ success: true, result: [] }),
        };
      };

      const client = new CloudflareClient('token', mockLog);
      const records = await client.listRecords('z', 'n');
      assert.deepEqual(records, []);
      assert.equal(attempts, 3);
    });
  });
});
