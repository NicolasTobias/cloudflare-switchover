'use strict';

// Desde 2026-11-15 el switchover no avisa por su cuenta: manda alertas al
// Alertmanager de Grafana Cloud, que decide a quien y cuando (repo
// tarddigradeOrg/tardigram, monitoring/alertmanager/). Contrato de labels:
// severity / service / source.
const LABELS = { service: 'casa', source: 'switchover' };
const EVENT_TTL_MS = 10 * 60_000;

async function postAlerts(config, alerts) {
  const auth = Buffer.from(`${config.alertmanagerUser}:${config.alertmanagerToken}`).toString('base64');
  const res = await fetch(`${config.alertmanagerUrl}/alertmanager/api/v2/alerts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(alerts),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alertmanager error: ${res.status} - ${body}`);
  }
}

// Un evento (conmutacion, arranque, errores de polling) es una alerta que se
// resuelve sola a los 10 min. La primera linea del mensaje es el summary, que
// es lo unico que llega a Telegram; el resto va en description.
async function notify(config, message, log, { alertname = 'SwitchoverEvento', severity = 'info' } = {}) {
  if (!config.alertmanagerUrl) {
    log.warn({ message }, 'alertmanager_not_configured');
    return;
  }
  const [summary, ...rest] = message.split('\n');
  const now = Date.now();
  try {
    await postAlerts(config, [{
      // `evento` distingue cada aviso: sin el, dos eventos seguidos serian la
      // misma alerta y el segundo no se notificaria.
      labels: { alertname, severity, ...LABELS, evento: String(now) },
      annotations: { summary: `Switchover: ${summary}`, description: rest.join('\n').trim() },
      startsAt: new Date(now).toISOString(),
      endsAt: new Date(now + EVENT_TTL_MS).toISOString(),
    }]);
  } catch (err) {
    log.error({ err }, 'alertmanager_notification_failed');
  }
}

// Mientras el estado no sea normal, SwitchoverModoLiga sigue disparando: se
// reenvia en cada poll con endsAt a tres polls vista (si el switchover muere,
// se resuelve sola). El Alertmanager la usa para inhibir los sondeos hechos
// desde casa, que en modo LaLiga fallan por el bloqueo y no por el sitio.
let modoLigaActivo = false;

async function reportState(config, state, pollIntervalMs, log) {
  if (!config.alertmanagerUrl) return;
  const firing = state !== 'normal';
  if (!firing && !modoLigaActivo) return;
  const now = Date.now();
  try {
    await postAlerts(config, [{
      labels: { alertname: 'SwitchoverModoLiga', severity: 'info', ...LABELS },
      annotations: { summary: `Switchover en estado ${state}: las webs se sirven desde el VPS` },
      endsAt: new Date(firing ? now + 3 * pollIntervalMs : now).toISOString(),
    }]);
    modoLigaActivo = firing;
  } catch (err) {
    log.error({ err }, 'alertmanager_state_failed');
  }
}

module.exports = { postAlerts, notify, reportState };
