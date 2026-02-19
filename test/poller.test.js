'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateFootball, STALENESS_THRESHOLD_MS } = require('../src/poller');

function makeData(ispStates, lastUpdate = new Date().toISOString().replace('T', ' ').slice(0, 19)) {
  const data = ispStates.map(([isp, state]) => ({
    ip: '104.16.0.1',
    isp,
    description: 'Cloudflare',
    stateChanges: [{ timestamp: new Date().toISOString(), state }],
  }));
  return { lastUpdate, data };
}

describe('evaluateFootball', () => {
  it('returns true when majority of ISPs report blocking', () => {
    const data = makeData([
      ['DIGI', true],
      ['Movistar', true],
      ['Orange', true],
      ['Vodafone', false],
      ['Masmovil', false],
    ]);
    assert.equal(evaluateFootball(data, 0.5), true);
  });

  it('returns false when minority of ISPs report blocking', () => {
    const data = makeData([
      ['DIGI', false],
      ['Movistar', false],
      ['Orange', false],
      ['Vodafone', true],
      ['Masmovil', false],
    ]);
    assert.equal(evaluateFootball(data, 0.5), false);
  });

  it('returns true when exactly at threshold', () => {
    const data = makeData([
      ['DIGI', true],
      ['Movistar', false],
    ]);
    // 1/2 = 0.5 >= 0.5 → true
    assert.equal(evaluateFootball(data, 0.5), true);
  });

  it('returns false when all ISPs are normal', () => {
    const data = makeData([
      ['DIGI', false],
      ['Movistar', false],
      ['Orange', false],
    ]);
    assert.equal(evaluateFootball(data, 0.5), false);
  });

  it('returns true when all ISPs report blocking', () => {
    const data = makeData([
      ['DIGI', true],
      ['Movistar', true],
      ['Orange', true],
    ]);
    assert.equal(evaluateFootball(data, 0.5), true);
  });

  it('returns null for null data', () => {
    assert.equal(evaluateFootball(null, 0.5), null);
  });

  it('returns null for empty data array', () => {
    assert.equal(evaluateFootball({ lastUpdate: new Date().toISOString(), data: [] }, 0.5), null);
  });

  it('returns null for missing data field', () => {
    assert.equal(evaluateFootball({ lastUpdate: 'x' }, 0.5), null);
  });

  it('returns null for stale data (>30min old)', () => {
    const staleTime = new Date(Date.now() - STALENESS_THRESHOLD_MS - 60_000);
    const lastUpdate = staleTime.toISOString().replace('T', ' ').slice(0, 19);
    const data = makeData([['DIGI', true], ['Movistar', true]], lastUpdate);
    assert.equal(evaluateFootball(data, 0.5), null);
  });

  it('handles fresh data within 30min', () => {
    const freshTime = new Date(Date.now() - 5 * 60_000); // 5 min ago
    const lastUpdate = freshTime.toISOString().replace('T', ' ').slice(0, 19);
    const data = makeData([['DIGI', true], ['Movistar', true]], lastUpdate);
    assert.equal(evaluateFootball(data, 0.5), true);
  });

  it('deduplicates by ISP using latest stateChange', () => {
    const oldTimestamp = new Date(Date.now() - 3600_000).toISOString();
    const newTimestamp = new Date().toISOString();
    const data = {
      lastUpdate: new Date().toISOString().replace('T', ' ').slice(0, 19),
      data: [
        {
          ip: '104.16.0.1',
          isp: 'DIGI',
          description: 'Cloudflare',
          stateChanges: [{ timestamp: oldTimestamp, state: true }],
        },
        {
          ip: '104.16.0.2',
          isp: 'DIGI',
          description: 'Cloudflare R2',
          stateChanges: [{ timestamp: newTimestamp, state: false }],
        },
        {
          ip: '104.16.0.3',
          isp: 'Movistar',
          description: 'Cloudflare',
          stateChanges: [{ timestamp: newTimestamp, state: false }],
        },
      ],
    };
    // DIGI: latest is state=false, Movistar: state=false → 0/2 blocked
    assert.equal(evaluateFootball(data, 0.5), false);
  });

  it('uses latest entry in stateChanges array', () => {
    const data = {
      lastUpdate: new Date().toISOString().replace('T', ' ').slice(0, 19),
      data: [
        {
          ip: '104.16.0.1',
          isp: 'DIGI',
          description: 'Cloudflare',
          stateChanges: [
            { timestamp: '2026-01-01T10:00:00Z', state: false },
            { timestamp: '2026-01-01T12:00:00Z', state: true },
          ],
        },
      ],
    };
    // Latest stateChange is state=true (blocked)
    assert.equal(evaluateFootball(data, 0.5), true);
  });

  it('skips entries with empty stateChanges', () => {
    const data = {
      lastUpdate: new Date().toISOString().replace('T', ' ').slice(0, 19),
      data: [
        { ip: '1.1.1.1', isp: 'DIGI', description: 'CF', stateChanges: [] },
        {
          ip: '2.2.2.2',
          isp: 'Movistar',
          description: 'CF',
          stateChanges: [{ timestamp: new Date().toISOString(), state: true }],
        },
      ],
    };
    // Only Movistar counted, 1/1 blocked → true
    assert.equal(evaluateFootball(data, 0.5), true);
  });

  it('respects custom threshold', () => {
    const data = makeData([
      ['DIGI', true],
      ['Movistar', false],
      ['Orange', false],
    ]);
    // 1/3 = 0.33 < 0.8 → false
    assert.equal(evaluateFootball(data, 0.8), false);
    // 1/3 = 0.33 >= 0.3 → true
    assert.equal(evaluateFootball(data, 0.3), true);
  });
});
