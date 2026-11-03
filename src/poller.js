'use strict';

const STALENESS_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

async function fetchHayaHora(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`hayahora fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Evaluate whether football blocking is active based on ISP data.
 *
 * Each ISP entry has a stateChanges array. The latest stateChange's `state`
 * field indicates whether blocking is detected (true = blocked, false = normal).
 *
 * Returns true if the proportion of ISPs reporting blocking >= threshold.
 * Returns null if data is stale (lastUpdate > 30min old).
 */
function evaluateFootball(data, threshold, home = {}) {
  const force = process.env.FORCE_FOOTBALL;
  if (force === 'true') return true;
  if (force === 'false') return false;

  if (!data || !data.data || !Array.isArray(data.data)) {
    return null;
  }

  // Staleness check
  if (data.lastUpdate) {
    const lastUpdate = new Date(data.lastUpdate.replace(' ', 'T') + 'Z');
    const age = Date.now() - lastUpdate.getTime();
    if (age > STALENESS_THRESHOLD_MS) {
      return null;
    }
  }

  const entries = data.data;
  if (entries.length === 0) return null;

  // Deduplicate by ISP — take latest stateChange per ISP
  const ispStates = new Map();
  for (const entry of entries) {
    if (!entry.stateChanges || entry.stateChanges.length === 0) continue;

    const latest = entry.stateChanges[entry.stateChanges.length - 1];
    const existing = ispStates.get(entry.isp);

    if (!existing || new Date(latest.timestamp) > new Date(existing.timestamp)) {
      ispStates.set(entry.isp, latest);
    }
  }

  if (ispStates.size === 0) return null;

  // Un bloqueo de la ISP de casa sobre una IP nuestra cuenta aunque no llegue
  // a la mayoria: Orange dejo 188.114.96.5 bloqueada 36 h despues del partido
  // (2026-11-01 a 2026-11-03) y las demas ISP ya lo habian levantado.
  if (homeIspBlocks(entries, home.isp, home.ips)) return true;

  let blockedCount = 0;
  for (const [, state] of ispStates) {
    if (state.state === true) blockedCount++;
  }

  return blockedCount / ispStates.size >= threshold;
}

/**
 * True si `isp` tiene bloqueada (ultimo stateChange a true) alguna de `ips`.
 */
function homeIspBlocks(entries, isp, ips) {
  if (!isp || !ips || ips.size === 0) return false;
  return entries.some(e =>
    e.isp === isp && ips.has(e.ip) && e.stateChanges && e.stateChanges.length > 0
    && e.stateChanges[e.stateChanges.length - 1].state === true);
}

module.exports = { fetchHayaHora, evaluateFootball, homeIspBlocks, STALENESS_THRESHOLD_MS };
