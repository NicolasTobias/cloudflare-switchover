'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { registrableDomain, originDomainFor } = require('../src/domain');

describe('registrableDomain', () => {
  it('devuelve las dos últimas etiquetas', () => {
    assert.equal(registrableDomain('tardigram.com'), 'tardigram.com');
    assert.equal(registrableDomain('www.tardigram.com'), 'tardigram.com');
    assert.equal(registrableDomain('status.elpapeo.com'), 'elpapeo.com');
    assert.equal(registrableDomain('A.B.Example.COM.'), 'example.com');
  });
});

describe('originDomainFor', () => {
  it('deriva origin.* del dominio registrable, no del registro', () => {
    assert.equal(originDomainFor('tardigram.com'), 'origin.tardigram.com');
    assert.equal(originDomainFor('www.tardigram.com'), 'origin.tardigram.com');
    assert.equal(originDomainFor('status.elpapeo.com'), 'origin.elpapeo.com');
  });

  it('respeta un origin_domain explícito', () => {
    assert.equal(originDomainFor('status.elpapeo.com', 'sonda.elpapeo.com'), 'sonda.elpapeo.com');
  });
});
