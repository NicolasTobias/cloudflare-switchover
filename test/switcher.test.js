'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Switcher } = require('../src/switcher');

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
      },
    ],
    telegramBotToken: null,
    telegramChatId: null,
    slackWebhookUrl: null,
    ...overrides,
  };
}

describe('Switcher', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Mock fetch for health checks (HEAD requests to domains)
    globalThis.fetch = async () => ({ status: 200 });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('init', () => {
    it('loads records and stores original state', async () => {
      const cfRecords = [
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ];
      const cf = createMockCf(cfRecords);
      const switcher = new Switcher(createConfig(), cf, mockLog);

      await switcher.init();

      assert.equal(switcher.records.length, 1);
      assert.equal(switcher.records[0].originalType, 'CNAME');
      assert.equal(switcher.records[0].originalContent, 'xxx.cfargotunnel.com');
      assert.equal(switcher.records[0].originalProxied, true);
      assert.equal(switcher.records[0].fallbackType, 'A');
      assert.equal(switcher.records[0].fallbackContent, '5.161.1.1');
      assert.equal(switcher.initialized, true);
      assert.equal(switcher.footballActive, false);
    });

    it('detects football state if record matches fallback', async () => {
      const cfRecords = [
        { id: 'rec1', name: 'tardigram.com', type: 'A', proxied: false, content: '5.161.1.1' },
      ];
      const cf = createMockCf(cfRecords);
      const switcher = new Switcher(createConfig(), cf, mockLog);

      await switcher.init();

      assert.equal(switcher.footballActive, true);
      // originalType is null because it was already in fallback
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

  describe('onPoll', () => {
    it('does nothing on null (stale data)', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      await switcher.onPoll(null);

      const updates = cf.calls.filter(c => c.method === 'updateRecord');
      assert.equal(updates.length, 0);
    });

    it('does nothing when state unchanged', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      await switcher.onPoll(false);

      const updates = cf.calls.filter(c => c.method === 'updateRecord');
      assert.equal(updates.length, 0);
    });

    it('switches to fallback when football detected', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      await switcher.onPoll(true);

      const updates = cf.calls.filter(c => c.method === 'updateRecord');
      assert.equal(updates.length, 1);
      assert.equal(updates[0].type, 'A');
      assert.equal(updates[0].content, '5.161.1.1');
      assert.equal(updates[0].proxied, false);
      assert.equal(switcher.footballActive, true);

      // Verify original state was saved
      assert.equal(switcher.records[0].originalType, 'CNAME');
      assert.equal(switcher.records[0].originalContent, 'xxx.cfargotunnel.com');
    });

    it('restores original when football ends', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      // Football starts
      await switcher.onPoll(true);
      // Football ends
      await switcher.onPoll(false);

      const updates = cf.calls.filter(c => c.method === 'updateRecord');
      assert.equal(updates.length, 2);
      // Second call restores original
      assert.equal(updates[1].type, 'CNAME');
      assert.equal(updates[1].content, 'xxx.cfargotunnel.com');
      assert.equal(updates[1].proxied, true);
      assert.equal(switcher.footballActive, false);
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

      await switcher.onPoll(true);

      const updates = cf.calls.filter(c => c.method === 'updateRecord');
      assert.equal(updates.length, 2);
      assert.equal(updates[0].content, '1.1.1.1');
      assert.equal(updates[1].content, '2.2.2.2');
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
    it('returns current status with original and current state', async () => {
      const cf = createMockCf([
        { id: 'rec1', name: 'tardigram.com', type: 'CNAME', proxied: true, content: 'xxx.cfargotunnel.com' },
      ]);
      const switcher = new Switcher(createConfig(), cf, mockLog);
      await switcher.init();

      const status = switcher.getStatus();
      assert.equal(status.footballActive, false);
      assert.equal(status.recordsCount, 1);
      assert.equal(status.records[0].name, 'tardigram.com');
      assert.equal(status.records[0].currentType, 'CNAME');
      assert.equal(status.records[0].originalType, 'CNAME');
      assert.equal(typeof status.uptime, 'number');
    });
  });
});
