'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Switcher, STATES } = require('../src/switcher');

const mockLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function createMockCf(records = []) {
  const calls = [];
  return {
    calls,
    listRecords: async (zoneId, name) => {
      calls.push({ method: 'listRecords', zoneId, name });
      return records;
    },
    updateRecord: async (zoneId, recordId, data) => {
      calls.push({ method: 'updateRecord', zoneId, recordId, ...data });
      return { success: true, result: { id: recordId, ...data } };
    },
  };
}

function createConfig(overrides = {}) {
  return {
    domainRecords: [
      {
        zone_id: 'zone1',
        record_name: 'tardigram.com',
        fallback_type: 'A',
        fallback_content: '5.161.1.1',
        health_check_string: 'Tardigram',
      },
    ],
    telegramBotToken: null,
    telegramChatId: null,
    slackWebhookUrl: null,
    ...overrides,
  };
}

// Helper: mock fetch to return CF trace OK for any /cdn-cgi/trace,
// HTML with title for origin domains, and 200 for health checks.
function mockFetchAll({ traceOk = true, originOk = true, healthOk = true, healthBody = '<html><title>Tardigram</title></html>' } = {}) {
  return async (url) => {
    if (url.includes('/cdn-cgi/trace')) {
      if (!traceOk) throw new Error('Connection refused');
      return {
        ok: true,
        text: async () => 'fl=123f456\nh=tardigram.com\ncolo=MAD\n',
      };
    }
    if (url.includes('origin.')) {
      if (!originOk) throw new Error('Origin unreachable');
      return {
        ok: true,
        status: 200,
        text: async () => '<html><title>Tardigram - Origin</title></html>',
      };
    }
    // Health check
    if (!healthOk) throw new Error('Health check failed');
    return {
      ok: true,
      status: 200,
      text: async () => healthBody,
    };
  };
}

describe('Switcher', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchAll();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('init', () => {
    it('loads records and starts in normal state', async () => {
      const cfRecords = [
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ];
      const cf = createMockCf(cfRecords);
      const switcher = new Switcher(createConfig(), cf, mockLog);

      await switcher.init();

      assert.equal(switcher.records.length, 1);
      assert.equal(switcher.state, STATES.NORMAL);
      assert.equal(switcher.footballActive, false);
      assert.equal(switcher.records[0].originalType, 'CNAME');
      assert.equal(switcher.records[0].originalContent, 'xxx.cfargotunnel.com');
      assert.equal(switcher.records[0].healthCheckString, 'Tardigram');
      assert.equal(switcher.initialized, true);
    });

    it('detects fallback state on init', async () => {
      const cfRecords = [
        { id: 'rec1', name: 'tardigram.com', type: 'A', proxied: false, content: '5.161.1.1' },
      ];
      const cf = createMockCf(cfRecords);
      const switcher = new Switcher(createConfig(), cf, mockLog);

      await switcher.init();

      assert.equal(switcher.state, STATES.FALLBACK);
      assert.equal(switcher.footballActive, true);
      assert.equal(switcher.records[0].originalType, null);
    });

    it('throws if no records found', async () => {
      const cf = createMockCf([]);
      const switcher = new Switcher(createConfig(), cf, mockLog);

      await assert.rejects(() => switcher.init(), /No DNS record found/);
    });

    it('handles multiple domain records', async () => {
      const config = createConfig({
        domainRecords: [
          { zone_id: 'z1', record_name: 'a.com', fallback_type: 'A', fallback_content: '1.1.1.1' },
          { zone_id: 'z2', record_name: 'b.com', fallback_type: 'A', fallback_content: '2.2.2.2' },
        ],
      });
      let callIdx = 0;
      const cfResponses = [
        [{ id: 'rec-a', name: 'a.com', type: 'CNAME', proxied: true, content: 'a.cfargotunnel.com' }],
        [{ id: 'rec-b', name: 'b.com', type: 'CNAME', proxied: true, content: 'b.cfargotunnel.com' }],
      ];
      const cf = {
        calls: [],
        listRecords: async () => cfResponses[callIdx++],
        updateRecord: async (zoneId, recordId, data) => ({ success: true, result: { id: recordId, ...data } }),
      };
      const switcher = new Switcher(config, cf, mockLog);

      await switcher.init();
      assert.equal(switcher.records.length, 2);
    });
  });

  describe('state machine transitions', () => {
    it('normal → watching when football detected and CF accessible', async () => {
      const cfRecords = [
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ];
      const cf = createMockCf(cfRecords);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      // Trace returns OK → stay in watching
      globalThis.fetch = mockFetchAll({ traceOk: true });
      await switcher.onPoll(true);

      assert.equal(switcher.state, STATES.WATCHING);
      // No DNS updates — CF is still accessible
      const updates = cf.calls.filter(c => c.method === 'updateRecord');
      assert.equal(updates.length, 0);
    });

    it('normal → fallback when football detected and CF blocked', async () => {
      const cfRecords = [
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ];
      const cf = createMockCf(cfRecords);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      // Trace fails → switch to fallback
      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(true);

      assert.equal(switcher.state, STATES.FALLBACK);
      assert.equal(switcher.footballActive, true);
      const updates = cf.calls.filter(c => c.method === 'updateRecord');
      assert.equal(updates.length, 1);
      assert.equal(updates[0].type, 'A');
      assert.equal(updates[0].content, '5.161.1.1');
    });

    it('watching → normal when football ends before block', async () => {
      const cfRecords = [
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ];
      const cf = createMockCf(cfRecords);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      globalThis.fetch = mockFetchAll({ traceOk: true });
      await switcher.onPoll(true); // normal → watching
      assert.equal(switcher.state, STATES.WATCHING);

      await switcher.onPoll(false); // watching → normal
      assert.equal(switcher.state, STATES.NORMAL);
      assert.equal(switcher.footballActive, false);
    });

    it('watching → fallback when trace fails on re-check', async () => {
      const cfRecords = [
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ];
      const cf = createMockCf(cfRecords);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      globalThis.fetch = mockFetchAll({ traceOk: true });
      await switcher.onPoll(true); // normal → watching
      assert.equal(switcher.state, STATES.WATCHING);

      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(true); // watching → fallback (trace now fails)
      assert.equal(switcher.state, STATES.FALLBACK);
      const updates = cf.calls.filter(c => c.method === 'updateRecord');
      assert.equal(updates.length, 1);
    });

    it('fallback → restoring → normal when football ends and origin accessible', async () => {
      const cfRecords = [
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ];
      const cf = createMockCf(cfRecords);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      // Go to fallback first
      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(true);
      assert.equal(switcher.state, STATES.FALLBACK);

      // Football ends, origin trace OK → restoring → normal
      globalThis.fetch = mockFetchAll({ traceOk: true, originOk: true });
      await switcher.onPoll(false);
      assert.equal(switcher.state, STATES.NORMAL);
      assert.equal(switcher.footballActive, false);

      // Should have 2 updates: switch to fallback + restore
      const updates = cf.calls.filter(c => c.method === 'updateRecord');
      assert.equal(updates.length, 2);
      assert.equal(updates[1].type, 'CNAME');
      assert.equal(updates[1].content, 'xxx.cfargotunnel.com');
    });

    it('fallback → restoring (stays) when origin trace fails', async () => {
      const cfRecords = [
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ];
      const cf = createMockCf(cfRecords);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(true);
      assert.equal(switcher.state, STATES.FALLBACK);

      // Football ends but origin still down
      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(false);
      assert.equal(switcher.state, STATES.RESTORING);

      // Only 1 update (the initial fallback switch)
      const updates = cf.calls.filter(c => c.method === 'updateRecord');
      assert.equal(updates.length, 1);
    });

    it('restoring → fallback when football resumes', async () => {
      const cfRecords = [
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ];
      const cf = createMockCf(cfRecords);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(true); // → fallback

      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(false); // → restoring

      assert.equal(switcher.state, STATES.RESTORING);

      await switcher.onPoll(true); // → fallback again
      assert.equal(switcher.state, STATES.FALLBACK);
    });

    it('restoring → restoring → normal on second attempt', async () => {
      const cfRecords = [
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ];
      const cf = createMockCf(cfRecords);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(true); // → fallback

      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(false); // → restoring (origin still down)
      assert.equal(switcher.state, STATES.RESTORING);

      // Now origin comes back
      globalThis.fetch = mockFetchAll({ traceOk: true, originOk: true });
      await switcher.onPoll(false); // → normal
      assert.equal(switcher.state, STATES.NORMAL);
    });
  });

  describe('onPoll edge cases', () => {
    it('does nothing on null (stale data)', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      await switcher.onPoll(null);
      assert.equal(switcher.state, STATES.NORMAL);
      const updates = cf.calls.filter(c => c.method === 'updateRecord');
      assert.equal(updates.length, 0);
    });

    it('does nothing in normal when no football', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      await switcher.onPoll(false);
      assert.equal(switcher.state, STATES.NORMAL);
    });

    it('does nothing in fallback when football still active', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(true); // → fallback

      const updatesBefore = cf.calls.filter(c => c.method === 'updateRecord').length;
      await switcher.onPoll(true); // still fallback, no action
      const updatesAfter = cf.calls.filter(c => c.method === 'updateRecord').length;
      assert.equal(updatesBefore, updatesAfter);
    });

    it('switches all records when multiple exist', async () => {
      const config = createConfig({
        domainRecords: [
          { zone_id: 'z1', record_name: 'a.com', fallback_type: 'A', fallback_content: '1.1.1.1' },
          { zone_id: 'z2', record_name: 'b.com', fallback_type: 'A', fallback_content: '2.2.2.2' },
        ],
      });
      let callIdx = 0;
      const cfResponses = [
        [{ id: 'rec-a', name: 'a.com', type: 'CNAME', proxied: true, content: 'a.cfargotunnel.com' }],
        [{ id: 'rec-b', name: 'b.com', type: 'CNAME', proxied: true, content: 'b.cfargotunnel.com' }],
      ];
      const cf = {
        calls: [],
        listRecords: async () => cfResponses[callIdx++],
        updateRecord: async (zoneId, recordId, data) => {
          cf.calls.push({ method: 'updateRecord', zoneId, recordId, ...data });
          return { success: true, result: { id: recordId, ...data } };
        },
      };
      const switcher = new Switcher(config, cf, mockLog);
      await switcher.init();

      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(true);

      const updates = cf.calls.filter(c => c.method === 'updateRecord');
      assert.equal(updates.length, 2);
      assert.equal(updates[0].content, '1.1.1.1');
      assert.equal(updates[1].content, '2.2.2.2');
    });
  });

  describe('_verifyHealth with content check', () => {
    it('checks content when health_check_string is set', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => '<html><title>Tardigram - Blog</title></html>',
      });

      const results = await switcher._verifyHealth();
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 200);
      assert.equal(results[0].contentOk, true);
    });

    it('reports contentOk=false when string not found', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => '<html><title>Error 503</title></html>',
      });

      const results = await switcher._verifyHealth();
      assert.equal(results[0].contentOk, false);
    });

    it('en fallback verifica pineando a la IP del VPS, no por DNS', async () => {
      // Registro ya en fallback (A → IP del VPS, proxied=false)
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'A', proxied: false, content: '5.161.1.1' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();
      assert.equal(switcher.state, STATES.FALLBACK);

      // Si tocara el DNS (fetch) el test fallaría: lo dejamos explotando.
      globalThis.fetch = async () => { throw new Error('no debe usar DNS en fallback'); };

      const pinnedCalls = [];
      switcher._fetchPinned = async (domain, ip, opts) => {
        pinnedCalls.push({ domain, ip, opts });
        return { status: 200, body: '<html><title>Tardigram</title></html>' };
      };

      const results = await switcher._verifyHealth();
      assert.equal(pinnedCalls.length, 1);
      assert.equal(pinnedCalls[0].domain, 'tardigram.com');
      assert.equal(pinnedCalls[0].ip, '5.161.1.1'); // la IP del fallback, no el DNS
      assert.equal(results[0].status, 200);
      assert.equal(results[0].contentOk, true);
      assert.equal(results[0].via, 'fallback-ip');
    });

    it('en estado normal verifica por DNS (fetch), no pineado', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      switcher._fetchPinned = async () => { throw new Error('no debe pinear en normal'); };
      globalThis.fetch = async () => ({
        ok: true, status: 200, text: async () => '<html><title>Tardigram</title></html>',
      });

      const results = await switcher._verifyHealth();
      assert.equal(results[0].status, 200);
      assert.equal(results[0].contentOk, true);
      assert.equal(results[0].via, 'dns');
    });

    it('reporta error (no cuelga) si el check pineado del fallback falla', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'A', proxied: false, content: '5.161.1.1' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      switcher._fetchPinned = async () => { throw new Error('timeout after 10000ms'); };

      const results = await switcher._verifyHealth();
      assert.equal(results[0].status, 'error');
      assert.equal(results[0].contentOk, false);
      assert.equal(results[0].via, 'fallback-ip');
      assert.match(results[0].error, /timeout/);
    });

    it('returns contentOk=null when no health_check_string', async () => {
      const config = createConfig({
        domainRecords: [{
          zone_id: 'zone1',
          record_name: 'example.com',
          fallback_type: 'A',
          fallback_content: '1.2.3.4',
        }],
      });
      const cf = createMockCf([
        { id: 'rec1', name: 'example.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(config, cf, mockLog);
      await switcher.init();

      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => '<html>anything</html>',
      });

      const results = await switcher._verifyHealth();
      assert.equal(results[0].contentOk, null);
    });
  });

  describe('error tracking', () => {
    it('tracks consecutive poll errors', () => {
      const cf = createMockCf();
      const switcher = new Switcher(createConfig(), cf, mockLog);

      switcher.recordPollError(new Error('err1'));
      assert.equal(switcher.consecutiveErrors, 1);

      switcher.recordPollError(new Error('err2'));
      assert.equal(switcher.consecutiveErrors, 2);
    });

    it('returns true (should notify) after 3 consecutive errors', () => {
      const cf = createMockCf();
      const switcher = new Switcher(createConfig(), cf, mockLog);

      assert.equal(switcher.recordPollError(new Error('e1')), false);
      assert.equal(switcher.recordPollError(new Error('e2')), false);
      assert.equal(switcher.recordPollError(new Error('e3')), true);
    });

    it('clears errors on successful poll', () => {
      const cf = createMockCf();
      const switcher = new Switcher(createConfig(), cf, mockLog);

      switcher.recordPollError(new Error('e1'));
      switcher.recordPollError(new Error('e2'));
      switcher.clearPollError();

      assert.equal(switcher.consecutiveErrors, 0);
      assert.equal(switcher.lastPollError, null);
    });
  });

  describe('getStatus', () => {
    it('returns current status with state field', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      const status = switcher.getStatus();
      assert.equal(status.state, 'normal');
      assert.equal(status.footballActive, false);
      assert.equal(status.recordsCount, 1);
      assert.equal(status.records[0].name, 'tardigram.com');
      assert.equal(typeof status.uptime, 'number');
    });
  });

  describe('footballActive getter', () => {
    it('returns true in fallback state', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(true);
      assert.equal(switcher.footballActive, true);
    });

    it('returns true in restoring state', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(true); // → fallback
      globalThis.fetch = mockFetchAll({ traceOk: false });
      await switcher.onPoll(false); // → restoring
      assert.equal(switcher.footballActive, true);
      assert.equal(switcher.state, STATES.RESTORING);
    });

    it('returns false in normal and watching states', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      assert.equal(switcher.footballActive, false); // normal

      globalThis.fetch = mockFetchAll({ traceOk: true });
      await switcher.onPoll(true); // → watching
      assert.equal(switcher.footballActive, false);
    });
  });
});
