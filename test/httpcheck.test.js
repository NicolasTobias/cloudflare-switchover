'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { fetchPinned } = require('../src/httpcheck');
const selfSigned = require('./fixtures/selfsigned');

// Servidor HTTPS local para ejercitar fetchPinned: pineado a 127.0.0.1,
// redirect del mismo host, y timeout. El cert es CN=localhost.
describe('fetchPinned', () => {
  let server;
  let port;
  const ca = [selfSigned.cert];

  before(async () => {
    server = https.createServer({ key: selfSigned.key, cert: selfSigned.cert }, (req, res) => {
      if (req.url === '/') {
        res.writeHead(302, { Location: 'https://localhost/feed' });
        res.end();
      } else if (req.url === '/www') {
        // Como el VPS con www.tardigram.com: redirige al apex (otro host, mismo dominio)
        res.writeHead(302, { Location: 'https://example.test/feed' });
        res.end();
      } else if (req.url === '/away') {
        res.writeHead(302, { Location: 'https://other.test/feed' });
        res.end();
      } else if (req.url === '/feed') {
        // Eco del Host para comprobar que se preserva el vhost a través del redirect.
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><title>OK</title>host=${req.headers.host}</html>`);
      } else if (req.url === '/slow') {
        const t = setTimeout(() => { res.writeHead(200); res.end('late'); }, 5000);
        t.unref();
      } else {
        res.writeHead(404);
        res.end('nope');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  after(() => server && server.close());

  it('pinea la conexión a la IP y preserva el Host (vhost) siguiendo el redirect', async () => {
    const { status, body } = await fetchPinned('localhost', '127.0.0.1', {
      port,
      requestOptions: { ca },
    });
    assert.equal(status, 200);
    assert.match(body, /title>OK</);
    assert.match(body, /host=localhost/);
  });

  // El cert del fixture es CN=localhost; para los tests con otros hosts se
  // desactiva solo la comprobación de nombre (la cadena sigue validándose).
  const otherHost = { ca, checkServerIdentity: () => undefined };

  it('sigue un redirect a otro host del mismo dominio, pineado a la misma IP y con el Host nuevo', async () => {
    const { status, body } = await fetchPinned('www.example.test', '127.0.0.1', {
      path: '/www',
      port,
      requestOptions: otherHost,
    });
    assert.equal(status, 200);
    assert.match(body, /host=example\.test/);
  });

  it('no persigue un redirect a otro dominio: devuelve el 3xx', async () => {
    const { status, body } = await fetchPinned('www.example.test', '127.0.0.1', {
      path: '/away',
      port,
      requestOptions: otherHost,
    });
    assert.equal(status, 302);
    assert.equal(body, '');
  });

  it('aborta con timeout en vez de colgarse', async () => {
    await assert.rejects(
      () => fetchPinned('localhost', '127.0.0.1', {
        path: '/slow',
        port,
        timeoutMs: 300,
        requestOptions: { ca },
      }),
      /timeout/,
    );
  });
});
