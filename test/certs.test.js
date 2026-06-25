'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const certs = require('../src/main/certs');

test('deriveCertLabel: CN - OU1 - OU2 …', () => {
  assert.equal(
    certs.deriveCertLabel({ subject: 'CN=Jane Q. Public, OU=Team A, OU=Region 5, O=Acme Corp, C=US' }),
    'Jane Q. Public - Team A - Region 5'
  );
});

test('deriveCertLabel: CN only', () => {
  assert.equal(certs.deriveCertLabel({ subject: 'CN=localhost' }), 'localhost');
});

test('deriveCertLabel: no CN falls back to OU list, empty subject -> empty', () => {
  assert.equal(certs.deriveCertLabel({ subject: 'OU=Orphan, O=Acme' }), 'Orphan');
  assert.equal(certs.deriveCertLabel({ subject: '' }), '');
});

test('parseDNPairs preserves order and duplicate OUs', () => {
  const ous = certs.parseDNPairs('CN=x, OU=A, OU=B, OU=C').filter((p) => p.type === 'OU');
  assert.deepEqual(ous.map((p) => p.value), ['A', 'B', 'C']);
});

test('parseDN is a last-wins map', () => {
  const dn = certs.parseDN('CN=x, OU=A, OU=B');
  assert.equal(dn.CN, 'x');
  assert.equal(dn.OU, 'B');
});

test('normalizeSerial: hex only, uppercase, no leading zeros', () => {
  assert.equal(certs.normalizeSerial('00:0a:bc'), 'ABC');
  assert.equal(certs.normalizeSerial('0'), '0');
});

test('findCertInList matches by serial number (thumbprint fallback)', () => {
  const list = [{ data: 'not-a-pem', serialNumber: '0A:BC' }];
  assert.equal(certs.findCertInList(list, { serialNumber: 'ABC' }), list[0]);
  assert.equal(certs.findCertInList(list, { serialNumber: 'FF' }), null);
});

test('sha1ThumbprintFromPem: uppercase hex SHA-1 of the DER', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----'; // base64 "ABC"
  const tp = certs.sha1ThumbprintFromPem(pem);
  const expected = crypto.createHash('sha1').update(Buffer.from('QUJD', 'base64')).digest('hex').toUpperCase();
  assert.match(tp, /^[0-9A-F]{40}$/);
  assert.equal(tp, expected);
});
