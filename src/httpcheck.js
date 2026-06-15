'use strict';

const https = require('https');
const { URL } = require('url');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * HTTPS GET a https://<domain><path> pero forzando la conexión TCP a <ip>,
 * manteniendo SNI y la cabecera Host = <domain>.
 *
 * Por qué: justo después de cambiar el DNS al fallback, el resolver del switcher
 * todavía tiene cacheado el edge de Cloudflare (que durante el partido está
 * bloqueado desde su red). Resolver por nombre cuelga hasta el timeout y nunca
 * prueba el camino real del fallback. Pineando a la IP del VPS verificamos el
 * camino que el switch realmente crea (VPS → Anubis → backend), de forma
 * determinista e independiente de la propagación DNS.
 *
 * Sigue hasta `maxRedirects` redirects del mismo host (re-pineando cada salto a
 * <ip>) — necesario porque la home redirige al feed local, y el feed es lo que
 * pasa por Anubis. Fuerza IPv4 (el cluster suele no tener ruta IPv6).
 *
 * @returns {Promise<{status:number, body:string}>}
 */
function fetchPinned(domain, ip, {
  path = '/',
  port = 443,
  timeoutMs = 10_000,
  maxRedirects = 3,
  requestOptions = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: ip,
      port,
      path,
      family: 4,
      servername: domain, // SNI → el VPS sirve el vhost y cert correctos
      headers: {
        Host: domain,
        'User-Agent': 'cloudflare-switchover/healthcheck',
      },
      ...requestOptions,
    }, (res) => {
      const { statusCode } = res;

      if (REDIRECT_CODES.has(statusCode) && res.headers.location && maxRedirects > 0) {
        res.resume(); // drenar el cuerpo
        let next;
        try {
          next = new URL(res.headers.location, `https://${domain}${path}`);
        } catch {
          resolve({ status: statusCode, body: '' });
          return;
        }
        if (next.hostname === domain) {
          fetchPinned(domain, ip, {
            path: next.pathname + next.search,
            port,
            timeoutMs,
            maxRedirects: maxRedirects - 1,
            requestOptions,
          }).then(resolve, reject);
          return;
        }
        // Redirect a otro host: no lo perseguimos pineados, devolvemos el 3xx
        resolve({ status: statusCode, body: '' });
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: statusCode, body }));
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { fetchPinned };
