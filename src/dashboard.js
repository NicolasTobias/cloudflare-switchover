'use strict';

function renderDashboard() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cloudflare Switchover</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; background: #0d1117; color: #c9d1d9; padding: 1rem; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin-bottom: 1rem; color: #58a6ff; }
  h2 { font-size: 1rem; margin-bottom: 0.5rem; color: #8b949e; border-bottom: 1px solid #21262d; padding-bottom: 0.3rem; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
  .state { font-size: 1.5rem; font-weight: bold; }
  .state.normal { color: #3fb950; }
  .state.watching { color: #d29922; }
  .state.fallback { color: #f85149; }
  .state.restoring { color: #d29922; }
  .meta { color: #8b949e; font-size: 0.85rem; margin-top: 0.5rem; }
  .records { margin-top: 0.5rem; }
  .record { font-size: 0.85rem; padding: 0.25rem 0; font-family: monospace; }
  .controls { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  button { padding: 0.5rem 1rem; border: 1px solid #30363d; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600; transition: 0.15s; }
  button:hover { filter: brightness(1.2); }
  .btn-on { background: #f85149; color: #fff; border-color: #f85149; }
  .btn-off { background: #3fb950; color: #fff; border-color: #3fb950; }
  .btn-auto { background: #21262d; color: #c9d1d9; }
  .btn-auto.active { border-color: #58a6ff; color: #58a6ff; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th { text-align: left; color: #8b949e; padding: 0.4rem 0.5rem; border-bottom: 1px solid #30363d; }
  td { padding: 0.35rem 0.5rem; border-bottom: 1px solid #21262d; font-family: monospace; }
  .type-state_change { color: #58a6ff; }
  .type-notification { color: #d29922; }
  .type-force_override { color: #bc8cff; }
  .type-poll_error { color: #f85149; }
  .refresh-info { color: #484f58; font-size: 0.75rem; text-align: right; }
  .force-label { display: inline-block; background: #f8514922; color: #f85149; font-size: 0.75rem; padding: 0.1rem 0.4rem; border-radius: 3px; margin-left: 0.5rem; }
</style>
</head>
<body>
<h1>Cloudflare Switchover</h1>

<div class="card" id="status-card">
  <h2>Estado</h2>
  <div class="state" id="state">-</div>
  <div id="force-indicator"></div>
  <div class="meta">
    <div>Football activo: <span id="football">-</span></div>
    <div>Ultimo poll: <span id="lastPoll">-</span></div>
    <div>Errores consecutivos: <span id="errors">-</span></div>
    <div>Uptime: <span id="uptime">-</span></div>
  </div>
  <div class="records" id="records"></div>
</div>

<div class="card">
  <h2>Controles</h2>
  <div class="controls">
    <button class="btn-on" onclick="forceOn()">Force ON (futbol)</button>
    <button class="btn-off" onclick="forceOff()">Force OFF</button>
    <button class="btn-auto" id="btn-auto" onclick="forceAuto()">Auto</button>
  </div>
</div>

<div class="card">
  <h2>Historial <span class="refresh-info" id="countdown"></span></h2>
  <table>
    <thead><tr><th>Hora</th><th>Tipo</th><th>Detalle</th></tr></thead>
    <tbody id="events"></tbody>
  </table>
</div>

<script>
const REFRESH_INTERVAL = 30;
let countdown = REFRESH_INTERVAL;

function formatTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleTimeString('es-ES', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function formatUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h + 'h ' + m + 'm';
}

async function fetchStatus() {
  try {
    const res = await fetch('/status');
    const data = await res.json();
    const el = document.getElementById('state');
    el.textContent = data.state.toUpperCase();
    el.className = 'state ' + data.state;
    document.getElementById('football').textContent = data.footballActive ? 'SI' : 'no';
    document.getElementById('lastPoll').textContent = formatTime(data.lastPoll);
    document.getElementById('errors').textContent = data.consecutiveErrors;
    document.getElementById('uptime').textContent = formatUptime(data.uptime);

    const forceVal = data.forceFootball;
    const fi = document.getElementById('force-indicator');
    if (forceVal !== undefined && forceVal !== null) {
      fi.innerHTML = '<span class="force-label">FORCE: ' + forceVal + '</span>';
    } else {
      fi.innerHTML = '';
    }

    const recEl = document.getElementById('records');
    recEl.innerHTML = data.records.map(function(r) {
      return '<div class="record">' + r.name + ': ' + r.currentType + ' → ' + r.currentContent + ' [proxied=' + r.proxied + ']</div>';
    }).join('');
  } catch (e) {
    console.error('Status fetch failed:', e);
  }
}

async function fetchEvents() {
  try {
    const res = await fetch('/api/events');
    const events = await res.json();
    const tbody = document.getElementById('events');
    tbody.innerHTML = events.map(function(ev) {
      const detail = ev.message || ev.from && (ev.from + ' → ' + ev.to) || '';
      return '<tr><td>' + formatTime(ev.timestamp) + '</td><td class="type-' + ev.type + '">' + ev.type + '</td><td>' + detail + '</td></tr>';
    }).join('');
  } catch (e) {
    console.error('Events fetch failed:', e);
  }
}

async function forceOn() {
  await fetch('/test/force-football', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  refresh();
}

async function forceOff() {
  await fetch('/test/force-football', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  refresh();
}

async function forceAuto() {
  await fetch('/test/force-football', { method: 'DELETE' });
  refresh();
}

function refresh() {
  countdown = REFRESH_INTERVAL;
  fetchStatus();
  fetchEvents();
}

setInterval(function() {
  countdown--;
  document.getElementById('countdown').textContent = 'refresh en ' + countdown + 's';
  if (countdown <= 0) {
    refresh();
  }
}, 1000);

refresh();
</script>
</body>
</html>`;
}

module.exports = { renderDashboard };
