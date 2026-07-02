'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const labels = require('../src/main/labels');

const bobCert = {
  subject: 'CN=jdoe, OU=Engineering, OU=Platform, OU=US-East, OU=Region, OU=HELLOWORLD, O=Acme, C=US',
  issuer: 'CN=Bob Enterprises',
};
const jimboCert = {
  subject: 'CN=asmith, OU=Alpha, OU=Bravo, OU=Charlie, OU=Delta, OU=Echo, O=Globex',
  issuer: 'CN=Jimbo Enterprises, LLC',
};
const bobRule = { issuer: 'CN=Bob Enterprises', template: '{{ ou[0] }} - {{ ou[4] | skip: 5 }} - {{ ou[1] }}' };
const jimboRule = {
  issuer: 'Jimbo Enterprises, LLC',
  template: '{{ ou[1] | upcase }} - {{ ou[3] | upcase }} - {{ ou[4] | upcase }}',
};

test('Bob packaged default template', () => {
  assert.equal(labels.resolveWithRules(bobCert, [bobRule]).label, 'Engineering - WORLD - Platform');
});

test('Jimbo: 2nd/4th/5th OU in caps', () => {
  assert.equal(labels.resolveWithRules(jimboCert, [jimboRule]).label, 'BRAVO - DELTA - ECHO');
});

test('falls back to CN-OU when no rule matches', () => {
  assert.equal(
    labels.resolveWithRules(jimboCert, [bobRule]).label,
    'asmith - Alpha - Bravo - Charlie - Delta - Echo'
  );
});

test('first matching rule wins', () => {
  assert.equal(labels.resolveWithRules(bobCert, [jimboRule, bobRule]).label, 'Engineering - WORLD - Platform');
});

test('broken template falls back to CN-OU', () => {
  const broken = { issuer: 'CN=Bob Enterprises', template: '{{ ou[0' };
  assert.equal(
    labels.resolveWithRules(bobCert, [broken]).label,
    'jdoe - Engineering - Platform - US-East - Region - HELLOWORLD'
  );
});

test('issuerMatches: CN exact, CN= form, DN substring (case-insensitive)', () => {
  assert.equal(labels.issuerMatches('Bob Enterprises', bobCert), true);
  assert.equal(labels.issuerMatches('CN=Bob Enterprises', bobCert), true);
  assert.equal(labels.issuerMatches('jimbo enterprises', jimboCert), true);
  assert.equal(labels.issuerMatches('Nope', bobCert), false);
});

test('preview reports match + output, and non-match', () => {
  const m = labels.preview({
    template: bobRule.template,
    issuerKey: 'CN=Bob Enterprises',
    subject: bobCert.subject,
    issuer: bobCert.issuer,
  });
  assert.equal(m.matches, true);
  assert.equal(m.output, 'Engineering - WORLD - Platform');
  assert.equal(m.error, null);

  const n = labels.preview({ template: bobRule.template, issuerKey: 'Nope', subject: bobCert.subject, issuer: bobCert.issuer });
  assert.equal(n.matches, false);
});

test('buildContext exposes ou[] array, cn scalar, issuer.cn', () => {
  const ctx = labels.buildContext(bobCert);
  assert.deepEqual(ctx.ou, ['Engineering', 'Platform', 'US-East', 'Region', 'HELLOWORLD']);
  assert.equal(ctx.cn, 'jdoe');
  assert.equal(ctx.issuer.cn, 'Bob Enterprises');
});

test('custom take filter + default for missing index', () => {
  assert.equal(
    labels.resolveWithRules({ subject: 'CN=x, OU=ABCDEFGH', issuer: 'CN=T' }, [
      { issuer: 'T', template: '{{ ou[0] | take: 3 }}' },
    ]).label,
    'ABC'
  );
  assert.equal(
    labels.resolveWithRules({ subject: 'CN=x, OU=A', issuer: 'CN=T' }, [
      { issuer: 'T', template: '{{ ou[9] | default: "none" }}' },
    ]).label,
    'none'
  );
});
