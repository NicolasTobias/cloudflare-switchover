'use strict';

/**
 * Dominio registrable de un hostname: las dos últimas etiquetas
 * (`www.tardigram.com` → `tardigram.com`). Suficiente para los TLD que
 * gestiona este servicio; no contempla sufijos públicos de dos niveles
 * (`co.uk`), que aquí no existen.
 */
function registrableDomain(hostname) {
  const labels = String(hostname).toLowerCase().replace(/\.$/, '').split('.');
  return labels.slice(-2).join('.');
}

/**
 * Dominio `origin.*` que sirve de sonda para saber si Cloudflare vuelve a ser
 * accesible. Se deriva del dominio registrable, no del registro: para
 * `www.tardigram.com` o `status.tardigram.com` la sonda es
 * `origin.tardigram.com`, que es el único `origin.*` que existe en la zona.
 * Si se derivara del registro (`origin.www.tardigram.com`) la sonda no
 * existiría, el trace fallaría siempre y el servicio se quedaría en
 * `restoring` sin devolver nunca el DNS a Cloudflare.
 */
function originDomainFor(recordName, override) {
  if (override) return override;
  return `origin.${registrableDomain(recordName)}`;
}

module.exports = { registrableDomain, originDomainFor };
